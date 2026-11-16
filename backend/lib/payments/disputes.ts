import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import { decryptCredential } from "@/lib/payments/credentials-crypto";
import { assertPaymentKeyUsable } from "@/lib/payments/key-check";
import { fetchDispute, type FetchLike } from "@/lib/payments/razorpay";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import "@/models/Business";
import "@/models/Order";
import "@/models/User";
import { OrderPayment, type OrderPaymentDoc } from "@/models/OrderPayment";
import {
  DISPUTE_HISTORY_MAX,
  DISPUTE_STATUSES,
  PaymentDispute,
  type DisputeStatus,
  type PaymentDisputeDoc,
} from "@/models/PaymentDispute";

/**
 * Dispute tracking for storefront order payments (server-only).
 *
 * `syncDisputeFromProvider` is the ONLY writer of dispute state: it re-reads
 * the dispute from the Razorpay API with the business's own key and stores
 * what Razorpay reports. It never changes the order or the payment and never
 * records a refund (a lost dispute is the provider deducting money, which the
 * business reconciles in Razorpay). Super admins can only append internal
 * notes (`addDisputeNote`, audited).
 */

export type DisputeSyncOutcome = "created" | "updated" | "unchanged" | "unknown_payment" | "mismatch" | "no_credentials";

const toDate = (unix: number | null | undefined) => (typeof unix === "number" && unix > 0 ? new Date(unix * 1000) : null);

function normaliseStatus(value: string): DisputeStatus | null {
  return (DISPUTE_STATUSES as readonly string[]).includes(value) ? (value as DisputeStatus) : null;
}

export async function syncDisputeFromProvider(input: {
  businessId: string;
  disputeId: string;
  eventId?: string | null;
  now?: Date;
  fetchImpl?: FetchLike;
}): Promise<{ outcome: DisputeSyncOutcome; disputeId?: string }> {
  const now = input.now ?? new Date();
  const business = new mongoose.Types.ObjectId(input.businessId);
  const account = await BusinessPaymentAccount.findOne({ business, provider: "razorpay" }).select("+keySecretEnc").lean();
  if (!account?.keySecretEnc) return { outcome: "no_credentials" };
  // Before decrypting: a wrong or unverifiable key answers 503, so the event is delivered again later.
  await assertPaymentKeyUsable();

  const remote = await fetchDispute({ keyId: account.keyId, keySecret: decryptCredential(account.keySecretEnc) }, input.disputeId, input.fetchImpl);
  const status = normaliseStatus(String(remote.status));
  if (remote.id !== input.disputeId || !status || typeof remote.payment_id !== "string" || !/^pay_[A-Za-z0-9]+$/.test(remote.payment_id)) {
    console.warn("[payments] event=dispute_unexpected_response");
    return { outcome: "mismatch" };
  }

  // Only disputes on a payment THIS business recorded are tracked.
  const payment = await OrderPayment.findOne({ business, providerPaymentId: remote.payment_id }).lean<OrderPaymentDoc>();
  if (!payment) return { outcome: "unknown_payment" };
  const currency = String(remote.currency).toUpperCase();
  if (currency !== payment.currency || !Number.isInteger(remote.amount) || remote.amount < 0 || remote.amount > payment.amountMinor) {
    console.warn("[payments] event=dispute_amount_mismatch");
    return { outcome: "mismatch" };
  }

  const fields = {
    amountMinor: remote.amount,
    amountDeductedMinor: Number.isInteger(remote.amount_deducted) ? Number(remote.amount_deducted) : 0,
    reasonCode: String(remote.reason_code ?? "").slice(0, 100),
    phase: String(remote.phase ?? "").slice(0, 40),
    status,
    respondBy: toDate(remote.respond_by),
    closedAt: status === "won" || status === "lost" || status === "closed" ? now : null,
    lastSyncedAt: now,
  };
  const entry = { at: now, source: "provider" as const, status, phase: fields.phase || null, eventId: input.eventId ?? null, note: null, actor: null };

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await PaymentDispute.findOne({ providerDisputeId: input.disputeId }).lean<PaymentDisputeDoc>();
    if (!existing) {
      try {
        const created = await PaymentDispute.create({
          ...fields,
          business,
          orderPayment: payment._id,
          order: payment.order,
          provider: "razorpay",
          mode: payment.mode,
          providerDisputeId: input.disputeId,
          providerPaymentId: remote.payment_id,
          currency,
          openedAt: toDate(remote.created_at) ?? now,
          history: [entry],
        });
        return { outcome: "created", disputeId: String(created._id) };
      } catch (error) {
        if ((error as { code?: number })?.code === 11000) continue; // concurrent creation: re-read and update
        throw error;
      }
    }
    if (String(existing.business) !== input.businessId) {
      // A dispute id owned by another business is never touched.
      console.warn("[payments] event=dispute_business_mismatch");
      return { outcome: "mismatch" };
    }
    const changed =
      existing.status !== fields.status ||
      existing.phase !== fields.phase ||
      existing.amountDeductedMinor !== fields.amountDeductedMinor ||
      String(existing.respondBy ?? "") !== String(fields.respondBy ?? "");
    if (!changed || (input.eventId && existing.history.some((h) => h.eventId === input.eventId))) {
      await PaymentDispute.updateOne({ _id: existing._id }, { $set: { lastSyncedAt: now } });
      return { outcome: "unchanged", disputeId: String(existing._id) };
    }
    // Conditional on the state we compared against, so concurrent deliveries
    // record each transition once.
    const result = await PaymentDispute.updateOne(
      { _id: existing._id, status: existing.status, phase: existing.phase, amountDeductedMinor: existing.amountDeductedMinor },
      {
        $set: { ...fields, closedAt: fields.closedAt ? existing.closedAt ?? now : null },
        $push: { history: { $each: [entry], $slice: -DISPUTE_HISTORY_MAX } },
      },
    );
    if (result.modifiedCount === 1) return { outcome: "updated", disputeId: String(existing._id) };
  }
  return { outcome: "unchanged" };
}

export async function addDisputeNote(input: { actorId: string; disputeId: string; note: string }) {
  if (!mongoose.isValidObjectId(input.disputeId)) throw new HttpError(404, "Dispute not found", "not_found");
  const note = input.note.trim();
  if (note.length < ADMIN_REASON_MIN || note.length > 1000) {
    throw new HttpError(422, `Write a note of ${ADMIN_REASON_MIN} to 1000 characters.`, "validation_error");
  }
  const id = new mongoose.Types.ObjectId(input.disputeId);
  return runAuditedAdminAction(async (session) => {
    const dispute = await PaymentDispute.findOneAndUpdate(
      { _id: id },
      {
        $push: {
          history: {
            $each: [{ at: new Date(), source: "admin", status: null, phase: null, eventId: null, note, actor: new mongoose.Types.ObjectId(input.actorId) }],
            $slice: -DISPUTE_HISTORY_MAX,
          },
        },
      },
      { new: true, session },
    ).lean<PaymentDisputeDoc>();
    if (!dispute) throw new HttpError(404, "Dispute not found", "not_found");
    return {
      result: { id: String(dispute._id), historyLength: dispute.history.length },
      audit: {
        actorId: input.actorId,
        action: "dispute.note",
        targetType: "dispute",
        targetId: String(dispute._id),
        targetLabel: dispute.providerDisputeId,
        reason: note.slice(0, 500),
        before: null,
        after: { status: dispute.status },
      },
    };
  });
}

/** Super-admin view of one dispute with its full history (no secrets, no shopper PII). */
export async function getDisputeDetail(disputeId: string) {
  if (!mongoose.isValidObjectId(disputeId)) throw new HttpError(404, "Dispute not found", "not_found");
  const dispute = await PaymentDispute.findById(disputeId)
    .populate({ path: "business", select: "name subdomain" })
    .populate({ path: "order", select: "orderNumber status total currency" })
    .populate({ path: "history.actor", select: "name" })
    .lean();
  if (!dispute) throw new HttpError(404, "Dispute not found", "not_found");
  const business = dispute.business as unknown as { _id: unknown; name?: string; subdomain?: string } | null;
  const order = dispute.order as unknown as { orderNumber?: string; status?: string; total?: number; currency?: string } | null;
  return {
    id: String(dispute._id),
    business: business ? { id: String(business._id), name: business.name ?? "", subdomain: business.subdomain ?? "" } : null,
    order: order ? { number: order.orderNumber ?? "", status: order.status ?? "", total: order.total ?? 0, currency: order.currency ?? "" } : null,
    reference: dispute.providerDisputeId,
    providerPaymentId: dispute.providerPaymentId,
    mode: dispute.mode,
    amount: dispute.amountMinor / 100,
    amountDeducted: dispute.amountDeductedMinor / 100,
    currency: dispute.currency,
    reasonCode: dispute.reasonCode,
    phase: dispute.phase,
    status: dispute.status,
    respondBy: dispute.respondBy ?? null,
    openedAt: dispute.openedAt ?? null,
    closedAt: dispute.closedAt ?? null,
    lastSyncedAt: dispute.lastSyncedAt,
    history: [...dispute.history].reverse().map((h) => {
      const actor = h.actor as unknown as { name?: string } | null;
      return { at: h.at, source: h.source, status: h.status, phase: h.phase, note: h.note, actorName: actor?.name ?? null, eventId: h.eventId };
    }),
  };
}
