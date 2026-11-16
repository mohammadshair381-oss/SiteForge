import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError } from "@/lib/api";
import { verifyWebhookSignature, RazorpayApiError } from "@/lib/payments/razorpay";
import { confirmPaymentLink, recordPaymentFailure, webhookSecretOf } from "@/lib/payments/order-payments";
import { syncRefundFromProvider } from "@/lib/payments/order-refunds";
import { syncDisputeFromProvider } from "@/lib/payments/disputes";
import { checkPaymentKey, isBlockingPaymentKeyState } from "@/lib/payments/key-check";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ businessId: string }>;
}

const MAX_BODY_BYTES = 64 * 1024;
const HANDLED_EVENTS = new Set(["payment_link.paid", "payment_link.expired", "payment_link.cancelled"]);
/** Dispute lifecycle events; the dispute is always re-read from the API. */
const DISPUTE_EVENTS = new Set([
  "payment.dispute.created",
  "payment.dispute.under_review",
  "payment.dispute.action_required",
  "payment.dispute.won",
  "payment.dispute.lost",
  "payment.dispute.closed",
]);

/** Refund lifecycle events; the refund is always re-read from the API. */
const REFUND_EVENTS = new Set(["refund.created", "refund.processed", "refund.failed"]);

function unauthorized(): HttpError {
  // Identical for unknown businesses, missing accounts and bad signatures.
  return new HttpError(401, "Invalid signature", "invalid_signature");
}

/**
 * `POST /api/webhooks/razorpay/[businessId]` — one webhook URL per business,
 * configured in that business's own Razorpay dashboard with its own secret.
 *
 * The path id only selects WHICH secret to verify with; nothing is trusted
 * until the HMAC over the exact raw body matches. Even a signed event is not
 * applied directly: `confirmPaymentLink` re-reads the Payment Link from the
 * API, scoped to this business. Duplicate deliveries are harmless because
 * every write there is conditional. A provider outage returns 502 so Razorpay
 * retries; an unrelated or unknown event returns 200.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { businessId } = await context.params;
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      throw new HttpError(413, "Payload too large", "payload_too_large");
    }
    if (!mongoose.isValidObjectId(businessId)) throw unauthorized();

    await dbConnect();
    // A wrong or unverifiable payment key is a temporary failure for EVERY request, decided before
    // any account is looked up: Razorpay delivers the event again later, and the answer never
    // reveals which businesses have an account.
    if (isBlockingPaymentKeyState((await checkPaymentKey()).state)) {
      throw new HttpError(503, "Temporarily unavailable", "temporarily_unavailable", { "Retry-After": "300" });
    }
    const account = await BusinessPaymentAccount.findOne({
      business: new mongoose.Types.ObjectId(businessId),
      provider: "razorpay",
      status: "active",
    })
      .select("+keySecretEnc +webhookSecretEnc")
      .lean();
    if (!account?.webhookSecretEnc) throw unauthorized();

    let secret: string;
    try {
      secret = webhookSecretOf(account as Parameters<typeof webhookSecretOf>[0]);
    } catch {
      throw unauthorized();
    }
    if (!verifyWebhookSignature(secret, rawBody, request.headers.get("x-razorpay-signature"))) {
      throw unauthorized();
    }

    let event: {
      event?: unknown;
      payload?: {
        payment_link?: { entity?: { id?: unknown } };
        dispute?: { entity?: { id?: unknown } };
        refund?: { entity?: { id?: unknown } };
        payment?: { entity?: { notes?: { siteforge_order?: unknown } | unknown[]; error_code?: unknown } };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new HttpError(400, "Invalid JSON body", "invalid_json");
    }
    const eventId = request.headers.get("x-razorpay-event-id")?.slice(0, 100) ?? null;
    if (typeof event.event === "string" && DISPUTE_EVENTS.has(event.event)) {
      const disputeId = event.payload?.dispute?.entity?.id;
      if (typeof disputeId !== "string" || !/^disp_[A-Za-z0-9]+$/.test(disputeId)) return ok({ received: true });
      try {
        const { outcome } = await syncDisputeFromProvider({ businessId, disputeId, eventId });
        return ok({ received: true, outcome });
      } catch (error) {
        if (error instanceof RazorpayApiError) {
          throw new HttpError(502, "Payment provider unavailable", "payment_provider_error");
        }
        throw error;
      }
    }
    if (typeof event.event === "string" && REFUND_EVENTS.has(event.event)) {
      const refundId = event.payload?.refund?.entity?.id;
      if (typeof refundId !== "string" || !/^rfnd_[A-Za-z0-9]+$/.test(refundId)) return ok({ received: true });
      try {
        const { outcome } = await syncRefundFromProvider({ businessId, providerRefundId: refundId });
        return ok({ received: true, outcome });
      } catch (error) {
        if (error instanceof RazorpayApiError) {
          throw new HttpError(502, "Payment provider unavailable", "payment_provider_error");
        }
        throw error;
      }
    }
    // A declined attempt is only noted: it never changes an order, and no re-read
    // is needed because nothing is paid or released from it.
    if (event.event === "payment.failed") {
      const entity = event.payload?.payment?.entity;
      const notes = entity?.notes && !Array.isArray(entity.notes) ? (entity.notes as { siteforge_order?: unknown }) : null;
      if (typeof notes?.siteforge_order === "string") {
        await recordPaymentFailure({ businessId, orderReference: notes.siteforge_order, errorCode: typeof entity?.error_code === "string" ? entity.error_code : null, eventId });
      }
      return ok({ received: true });
    }
    if (typeof event.event !== "string" || !HANDLED_EVENTS.has(event.event)) {
      return ok({ received: true });
    }
    const linkId = event.payload?.payment_link?.entity?.id;
    if (typeof linkId !== "string" || !/^plink_[A-Za-z0-9]+$/.test(linkId)) {
      return ok({ received: true });
    }

    try {
      const { outcome } = await confirmPaymentLink({ businessId, linkId, eventId });
      return ok({ received: true, outcome });
    } catch (error) {
      if (error instanceof RazorpayApiError) {
        throw new HttpError(502, "Payment provider unavailable", "payment_provider_error");
      }
      throw error;
    }
  });
}
