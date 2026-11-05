import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { billingConfig, syncBillingAdjustment, syncProviderSubscription } from "@/lib/billing-razorpay";
import { isFeatureReady } from "@/lib/required-indexes";
import { RazorpayApiError, verifyWebhookSignature } from "@/lib/payments/razorpay";

const MAX_BODY_CHARS = 1024 * 1024;
const unauthorized = () => NextResponse.json({ error: "Invalid webhook" }, { status: 401 });

/**
 * Razorpay events for SiteForge's OWN subscription billing (store checkouts use
 * `/api/webhooks/razorpay/[businessId]` with each store's account). The HMAC is checked
 * on the exact raw body. The event only says something changed: the subscription and any
 * payment are re-read from the API before anything is saved. A failed read answers 502,
 * so Razorpay delivers it again; anything we will never act on answers 200.
 */
export async function POST(request: Request) {
  const config = billingConfig();
  if (!config) return NextResponse.json({ error: "Not configured" }, { status: 503 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return unauthorized();
  if (!verifyWebhookSignature(config.webhookSecret, raw, request.headers.get("x-razorpay-signature"))) return unauthorized();

  // Razorpay delivers again later, so nothing is lost while billing is not switched on.
  if (!(await isFeatureReady("subscription_billing"))) return NextResponse.json({ error: "Not ready" }, { status: 503 });

  let event: { event?: unknown; payload?: { subscription?: { entity?: { id?: unknown } }; payment?: { entity?: { id?: unknown } }; refund?: { entity?: { id?: unknown } }; dispute?: { entity?: { id?: unknown } } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const type = typeof event.event === "string" ? event.event : "";
  // Razorpay's id for this event; a hash of the signed body if it is ever missing.
  const eventId = request.headers.get("x-razorpay-event-id")?.slice(0, 100) || `body:${crypto.createHash("sha256").update(raw).digest("hex")}`;

  // Refunds and disputes on subscription payments. Both are re-read from the API, and
  // only ever recorded against a payment already known as a subscription payment.
  const refundId = event.payload?.refund?.entity?.id;
  const disputeId = event.payload?.dispute?.entity?.id;
  const adjustment =
    type.startsWith("refund.") && typeof refundId === "string" && /^rfnd_[A-Za-z0-9]+$/.test(refundId)
      ? ({ kind: "refund", providerId: refundId } as const)
      : type.startsWith("payment.dispute.") && typeof disputeId === "string" && /^disp_[A-Za-z0-9]+$/.test(disputeId)
        ? ({ kind: "dispute", providerId: disputeId } as const)
        : null;
  if (adjustment) {
    try {
      return NextResponse.json({ received: true, outcome: await syncBillingAdjustment({ ...adjustment, eventId, eventType: type.slice(0, 60) }) });
    } catch (error) {
      console.error("[billing-webhook] could not apply an event", { type: type.slice(0, 60), status: error instanceof RazorpayApiError ? error.status : null });
      return NextResponse.json({ error: "Temporary failure" }, { status: 502 });
    }
  }

  const subscriptionId = event.payload?.subscription?.entity?.id;
  if (!type.startsWith("subscription.") || typeof subscriptionId !== "string" || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    return NextResponse.json({ received: true, outcome: "ignored" });
  }
  const paymentId = event.payload?.payment?.entity?.id;
  try {
    const outcome = await syncProviderSubscription({
      providerSubscriptionId: subscriptionId,
      eventId,
      eventType: type.slice(0, 60),
      paymentId: typeof paymentId === "string" && /^pay_[A-Za-z0-9]+$/.test(paymentId) ? paymentId : null,
    });
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    // Scalars only: never the body, a key or a customer detail.
    console.error("[billing-webhook] could not apply an event", { type: type.slice(0, 60), status: error instanceof RazorpayApiError ? error.status : null });
    return NextResponse.json({ error: "Temporary failure" }, { status: 502 });
  }
}
