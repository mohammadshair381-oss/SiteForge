import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { isOrderOnlinePaymentsEnabled, isOrderPaymentsLiveAllowed, isProduction } from "@/lib/env";
import { markOrderPaid } from "@/lib/orders/lifecycle";
import {
  decryptCredential,
  isPaymentCredentialsKeyConfigured,
} from "@/lib/payments/credentials-crypto";
import {
  RazorpayApiError,
  cancelPaymentLink,
  createPaymentLink,
  fetchPaymentLink,
  isTrustedPaymentLinkUrl,
  toMinorUnits,
  type FetchLike,
  type RazorpayCredentials,
} from "@/lib/payments/razorpay";
import { BusinessPaymentAccount, type BusinessPaymentAccountDoc } from "@/models/BusinessPaymentAccount";
import { queueOrderEmail } from "@/lib/orders/notifications";
import { notifyOrder, notifyPaymentFailure } from "@/lib/notification-events";
import { Order, type OrderDoc } from "@/models/Order";
import { OrderPayment, type OrderPaymentDoc } from "@/models/OrderPayment";

/**
 * Storefront order payments through each business's own Razorpay account
 * (server-only). The ONLY code path that marks an online order paid is
 * `confirmPaymentLink`, which always re-reads the Payment Link from the
 * Razorpay API and checks id, reference, amount and currency first. A browser
 * redirect, a client message or an unverified webhook never marks anything
 * paid. See docs/payments-architecture.md.
 */

/** Currencies the integration accepts (Razorpay settles INR for Indian merchants). */
export const ONLINE_PAYMENT_CURRENCIES = ["INR"] as const;
/** Razorpay refuses Payment Links that expire sooner than 15 minutes from now. */
const MIN_LINK_LIFETIME_SECONDS = 16 * 60;
/** The link closes shortly before the stock reservation is released. */
const LINK_EXPIRY_MARGIN_SECONDS = 60;

type AccountWithSecrets = BusinessPaymentAccountDoc & {
  keySecretEnc: NonNullable<BusinessPaymentAccountDoc["keySecretEnc"]>;
  webhookSecretEnc: NonNullable<BusinessPaymentAccountDoc["webhookSecretEnc"]>;
};

function toObjectId(id: unknown): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(String(id));
}

/**
 * The business's usable account, or null. An account is usable only when the
 * feature flag is on, the encryption key is configured, the account is active,
 * and (for live mode) live payments are explicitly allowed.
 */
export async function getUsablePaymentAccount(businessId: unknown): Promise<AccountWithSecrets | null> {
  if (!isOrderOnlinePaymentsEnabled() || !isPaymentCredentialsKeyConfigured()) return null;
  const account = await BusinessPaymentAccount.findOne({
    business: toObjectId(businessId),
    provider: "razorpay",
    status: "active",
  })
    .select("+keySecretEnc +webhookSecretEnc")
    .lean<AccountWithSecrets>();
  if (!account || !account.keySecretEnc || !account.webhookSecretEnc) return null;
  if (account.mode === "live" && !isOrderPaymentsLiveAllowed()) return null;
  return account;
}

/**
 * The account a payment taken in `mode` is refunded through. Unlike taking new
 * payments this ignores the feature flag, but a live refund still needs live
 * payments allowed, and test and live payments never use each other's keys.
 */
export async function paymentAccountForRefunds(businessId: unknown, mode: "test" | "live" | null): Promise<AccountWithSecrets | null> {
  if (!isPaymentCredentialsKeyConfigured()) return null;
  const account = await BusinessPaymentAccount.findOne({ business: toObjectId(businessId), provider: "razorpay", status: "active" })
    .select("+keySecretEnc +webhookSecretEnc")
    .lean<AccountWithSecrets>();
  if (!account?.keySecretEnc) return null;
  if (mode !== null && account.mode !== mode) return null;
  if (account.mode === "live" && !isOrderPaymentsLiveAllowed()) return null;
  return account;
}

export async function isOnlinePaymentAvailable(businessId: unknown): Promise<boolean> {
  return (await getUsablePaymentAccount(businessId)) !== null;
}

function credentialsOf(account: AccountWithSecrets): RazorpayCredentials {
  return { keyId: account.keyId, keySecret: decryptCredential(account.keySecretEnc) };
}

export function webhookSecretOf(account: AccountWithSecrets): string {
  return decryptCredential(account.webhookSecretEnc);
}

export function keySecretOf(account: AccountWithSecrets): string {
  return decryptCredential(account.keySecretEnc);
}

/**
 * Checkout-time validation for an online order: a supported currency and an
 * exact number of subunits. Throws the 400 the storefront shows.
 */
export function assertOnlinePayable(total: number, currency: string): void {
  if (!(ONLINE_PAYMENT_CURRENCIES as readonly string[]).includes(currency.toUpperCase())) {
    throw new HttpError(400, "Online payment is available only for orders in INR", "currency_not_supported");
  }
  if (toMinorUnits(total) === null) {
    throw new HttpError(400, "This order total cannot be paid online", "invalid_amount");
  }
}

function storefrontOrigin(host: string): string {
  return `${isProduction() ? "https" : "http"}://${host}`;
}

/**
 * Create (or reuse) the hosted Payment Link for a pending online order and
 * return its URL. The caller has already authenticated the shopper (order
 * proof) and resolved the business from the Host.
 */
export async function startOrderPayment(input: {
  businessId: string;
  orderId: string;
  host: string;
  now?: Date;
  fetchImpl?: FetchLike;
}): Promise<{ url: string }> {
  const now = input.now ?? new Date();
  const account = await getUsablePaymentAccount(input.businessId);
  if (!account) throw new HttpError(409, "Online payment is not available for this store", "online_payment_unavailable");

  const order = await Order.findOne({ _id: toObjectId(input.orderId), business: toObjectId(input.businessId) }).lean<OrderDoc>();
  if (!order) throw new HttpError(404, "Order not found", "not_found");
  if (order.paymentMethod !== "online" || order.status !== "pending" || order.inventoryState !== "reserved") {
    throw new HttpError(409, "This order cannot be paid online", "not_payable");
  }

  const existing = await OrderPayment.findOne({ business: order.business, order: order._id, status: "created" })
    .sort({ createdAt: -1 })
    .lean<OrderPaymentDoc>();
  if (existing && isTrustedPaymentLinkUrl(existing.shortUrl)) return { url: existing.shortUrl };

  const expiresAt = order.reservationExpiresAt ? new Date(order.reservationExpiresAt) : null;
  const expireBy = expiresAt ? Math.floor(expiresAt.getTime() / 1000) - LINK_EXPIRY_MARGIN_SECONDS : 0;
  if (!expiresAt || expireBy - Math.floor(now.getTime() / 1000) < MIN_LINK_LIFETIME_SECONDS) {
    throw new HttpError(409, "The payment window for this order has closed. Please place the order again.", "payment_window_closed");
  }

  const currency = (order.currency ?? "").toUpperCase();
  assertOnlinePayable(order.total, currency);
  const amountMinor = toMinorUnits(order.total) as number;

  let link;
  try {
    link = await createPaymentLink(
      credentialsOf(account),
      {
        amountMinor,
        currency,
        referenceId: String(order._id),
        description: `Order #${order.orderNumber}`,
        customer: { name: order.customerName, email: order.customerEmail },
        callbackUrl: `${storefrontOrigin(input.host)}/api/storefront/payments/razorpay/return`,
        expireBy,
      },
      input.fetchImpl,
    );
  } catch (error) {
    // A concurrent request may have created the link first (Razorpay rejects a
    // reused reference_id); hand back that link instead of failing.
    const raced = await OrderPayment.findOne({ business: order.business, order: order._id, status: "created" }).lean<OrderPaymentDoc>();
    if (raced && isTrustedPaymentLinkUrl(raced.shortUrl)) return { url: raced.shortUrl };
    if (error instanceof RazorpayApiError) {
      console.warn("[payments] payment link creation failed", { status: error.status, code: error.providerCode });
      throw new HttpError(502, "The payment provider is unavailable. Please try again.", "payment_provider_error");
    }
    throw error;
  }

  if (
    link.amount !== amountMinor ||
    String(link.currency).toUpperCase() !== currency ||
    link.reference_id !== String(order._id) ||
    !isTrustedPaymentLinkUrl(link.short_url)
  ) {
    throw new HttpError(502, "The payment provider returned an unexpected response", "payment_provider_error");
  }

  await OrderPayment.create({
    business: order.business,
    order: order._id,
    provider: "razorpay",
    mode: account.mode,
    providerLinkId: link.id,
    shortUrl: link.short_url,
    amountMinor,
    currency,
  });
  return { url: link.short_url };
}

export type ConfirmOutcome =
  | "unknown_link"
  | "not_paid"
  | "applied"
  | "already_applied"
  | "needs_review";

/**
 * Re-read a Payment Link from Razorpay and, only if Razorpay says it is fully
 * paid with exactly the recorded amount, currency and order reference, mark
 * the order paid. Idempotent: duplicate webhooks and callback + webhook for
 * the same payment converge on one paid order and one paid OrderPayment.
 */
export async function confirmPaymentLink(input: {
  businessId: string;
  linkId: string;
  eventId?: string | null;
  now?: Date;
  fetchImpl?: FetchLike;
}): Promise<{ outcome: ConfirmOutcome; orderId?: string }> {
  const now = input.now ?? new Date();
  const businessObjectId = toObjectId(input.businessId);
  const payment = await OrderPayment.findOne({ business: businessObjectId, providerLinkId: input.linkId }).lean<OrderPaymentDoc>();
  if (!payment) return { outcome: "unknown_link" };
  const orderId = String(payment.order);

  if (payment.status === "paid" && payment.orderOutcome) {
    return { outcome: payment.orderOutcome === "applied" ? "already_applied" : "needs_review", orderId };
  }

  // Look up the account even when the feature flag has since been switched
  // off: a payment that was already taken must still be recorded.
  const account = await BusinessPaymentAccount.findOne({ business: businessObjectId, provider: "razorpay" })
    .select("+keySecretEnc +webhookSecretEnc")
    .lean<AccountWithSecrets>();
  if (!account?.keySecretEnc) return { outcome: "not_paid", orderId };
  // Test and live keys see different links: never read one with the other.
  if (account.mode !== payment.mode) return { outcome: "not_paid", orderId };

  const link = await fetchPaymentLink(credentialsOf(account), input.linkId, input.fetchImpl);
  const matches =
    link.id === payment.providerLinkId &&
    link.reference_id === orderId &&
    link.amount === payment.amountMinor &&
    String(link.currency).toUpperCase() === payment.currency;
  if (!matches) {
    console.warn("[payments] payment link does not match the recorded order", { operation: "confirm" });
    return { outcome: "not_paid", orderId };
  }

  if (link.status !== "paid" || link.amount_paid !== link.amount) {
    if (link.status === "expired" || link.status === "cancelled") {
      await OrderPayment.updateOne(
        { _id: payment._id, status: "created" },
        { $set: { status: link.status === "expired" ? "failed" : "cancelled", lastEventId: input.eventId ?? null } },
      );
    }
    return { outcome: "not_paid", orderId };
  }

  const providerPaymentId = link.payments?.find((p) => p.status === "captured")?.payment_id ?? null;
  await OrderPayment.updateOne(
    { _id: payment._id, status: { $ne: "paid" } },
    { $set: { status: "paid", providerPaymentId, paidAt: now, lastEventId: input.eventId ?? null } },
  );

  const result = await markOrderPaid({ orderId, businessId: input.businessId, now });
  const applied = result.applied || result.reason === "already_paid";
  // Only the first writer records the outcome.
  const recorded = await OrderPayment.updateOne(
    { _id: payment._id, orderOutcome: null },
    { $set: { orderOutcome: applied ? "applied" : "needs_review", outcomeReason: applied ? null : result.reason ?? "unknown" } },
  );
  if (!applied) {
    console.warn("[payments] captured payment could not be applied to its order", { operation: "confirm", reason: result.reason });
    return { outcome: "needs_review", orderId };
  }
  if (recorded.modifiedCount === 1 && result.applied) {
    queueOrderEmail("paid", input.businessId, orderId);
    queueOrderEmail("owner_new_order", input.businessId, orderId);
    notifyOrder("paid", input.businessId, orderId);
  }
  return { outcome: recorded.modifiedCount === 1 && result.applied ? "applied" : "already_applied", orderId };
}

/**
 * Records a declined attempt from a signed `payment.failed` event. Changes nothing
 * about the order: the link stays open and the reservation runs as before, so the
 * shopper can try again. Only the owner's and shopper's views use it.
 */
export async function recordPaymentFailure(input: { businessId: string; orderReference: string; errorCode?: string | null; eventId?: string | null; now?: Date }): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/i.test(input.orderReference)) return false;
  const result = await OrderPayment.updateOne(
    { business: toObjectId(input.businessId), order: toObjectId(input.orderReference), status: "created" },
    { $set: { lastFailureAt: input.now ?? new Date(), lastFailureCode: input.errorCode ? String(input.errorCode).slice(0, 80) : null, lastEventId: input.eventId ?? null } },
  );
  if (result.matchedCount > 0) notifyPaymentFailure(input.businessId, input.orderReference);
  return result.matchedCount > 0;
}

/**
 * Closes the open links of a cancelled order, so nobody pays for an order that no
 * longer exists. Best-effort: if this fails the late-payment path still catches it
 * (`needs_review`), and the link expires by itself shortly after.
 */
export async function closeOpenPaymentLinks(businessId: string, orderId: string, fetchImpl?: FetchLike): Promise<void> {
  try {
    const open = await OrderPayment.find({ business: toObjectId(businessId), order: toObjectId(orderId), status: "created" }).lean<OrderPaymentDoc[]>();
    if (open.length === 0) return;
    const account = await BusinessPaymentAccount.findOne({ business: toObjectId(businessId), provider: "razorpay", status: "active" })
      .select("+keySecretEnc +webhookSecretEnc")
      .lean<AccountWithSecrets>();
    if (!account?.keySecretEnc) return;
    for (const payment of open) {
      if (payment.mode !== account.mode) continue;
      await cancelPaymentLink(credentialsOf(account), payment.providerLinkId, fetchImpl);
      await OrderPayment.updateOne({ _id: payment._id, status: "created" }, { $set: { status: "cancelled" } });
    }
  } catch (error) {
    console.warn("[payments] could not close a payment link", { operation: "close_link", code: error instanceof RazorpayApiError ? error.providerCode : "error" });
  }
}
