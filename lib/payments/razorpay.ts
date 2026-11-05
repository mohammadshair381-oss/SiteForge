import crypto from "node:crypto";

/**
 * Minimal Razorpay REST client for storefront order payments (server-only, no
 * SDK, native `fetch`). It talks to the business's OWN Razorpay account using
 * that business's key pair; SiteForge never holds the funds.
 *
 * Only hosted Payment Links are used (a redirect to Razorpay), so the
 * storefront Content Security Policy never has to allow Razorpay scripts or
 * frames.
 *
 * Tests inject `fetchImpl`; automated tests never reach the network. Errors
 * carry the HTTP status and Razorpay's error code only, never the key secret,
 * the Authorization header or the request body.
 */

export const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class RazorpayApiError extends Error {
  constructor(
    public status: number,
    public providerCode: string | null,
  ) {
    super(`Razorpay request failed (HTTP ${status}${providerCode ? `, ${providerCode}` : ""})`);
    this.name = "RazorpayApiError";
  }
}

export interface RazorpayPaymentLink {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: "created" | "partially_paid" | "expired" | "cancelled" | "paid";
  reference_id: string;
  short_url: string;
  payments?: Array<{ payment_id: string; amount: number; status: string }> | null;
}

export interface CreatePaymentLinkInput {
  /** Currency subunit (paise for INR). */
  amountMinor: number;
  currency: string;
  /** Our order id; Razorpay requires it to be unique per link. */
  referenceId: string;
  description: string;
  customer: { name: string; email: string };
  callbackUrl: string;
  /** Unix seconds. */
  expireBy: number;
}

async function request<T>(
  credentials: RazorpayCredentials,
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: unknown; headers?: Record<string, string> },
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${RAZORPAY_API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new RazorpayApiError(0, "network_error");
  } finally {
    clearTimeout(timer);
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = (data?.error as { code?: unknown } | undefined)?.code;
    throw new RazorpayApiError(response.status, typeof code === "string" ? code : null);
  }
  if (!data || typeof data !== "object") throw new RazorpayApiError(response.status, "invalid_response");
  return data as T;
}

// ---------------------------------------------------------------------------
// Subscriptions: SiteForge charging store owners, on SiteForge's own account
// (lib/billing-razorpay.ts). Never used with a store's keys.
// ---------------------------------------------------------------------------

export interface RazorpayPlan {
  id: string;
}

export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  status: "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "expired" | "paused";
  current_start: number | null;
  current_end: number | null;
  paid_count: number;
  remaining_count: number | string | null;
  short_url: string;
  /** Documented on the subscription; read when present, never relied on. */
  payment_method?: string | null;
  has_scheduled_changes?: boolean;
  change_scheduled_at?: number | null;
}

export interface RazorpayInvoice {
  id: string;
  status: string;
  amount: number;
  currency: string;
  billing_start: number | null;
  billing_end: number | null;
  paid_at: number | null;
  short_url: string | null;
  invoice_number?: string | null;
  payment_id?: string | null;
}

export function createRazorpayPlan(
  credentials: RazorpayCredentials,
  input: { period: "monthly" | "yearly"; interval: number; name: string; amountMinor: number; currency: string; description: string; notes: Record<string, string> },
  fetchImpl?: FetchLike,
): Promise<RazorpayPlan> {
  return request<RazorpayPlan>(
    credentials,
    "/plans",
    {
      method: "POST",
      body: {
        period: input.period,
        interval: input.interval,
        item: { name: input.name, amount: input.amountMinor, currency: input.currency, description: input.description || input.name },
        notes: input.notes,
      },
    },
    fetchImpl,
  );
}

export function createRazorpaySubscription(
  credentials: RazorpayCredentials,
  input: { planId: string; totalCount: number; expireBy: number; notes: Record<string, string> },
  fetchImpl?: FetchLike,
): Promise<RazorpaySubscription> {
  return request<RazorpaySubscription>(
    credentials,
    "/subscriptions",
    { method: "POST", body: { plan_id: input.planId, total_count: input.totalCount, quantity: 1, customer_notify: true, expire_by: input.expireBy, notes: input.notes } },
    fetchImpl,
  );
}

export function fetchRazorpaySubscription(credentials: RazorpayCredentials, id: string, fetchImpl?: FetchLike): Promise<RazorpaySubscription> {
  return request<RazorpaySubscription>(credentials, `/subscriptions/${encodeURIComponent(id)}`, { method: "GET" }, fetchImpl);
}

export function cancelRazorpaySubscription(credentials: RazorpayCredentials, id: string, input: { atCycleEnd: boolean }, fetchImpl?: FetchLike): Promise<RazorpaySubscription> {
  return request<RazorpaySubscription>(credentials, `/subscriptions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { cancel_at_cycle_end: input.atCycleEnd } }, fetchImpl);
}

export function updateRazorpaySubscription(
  credentials: RazorpayCredentials,
  id: string,
  input: { planId: string; scheduleChangeAt: "now" | "cycle_end" },
  fetchImpl?: FetchLike,
): Promise<RazorpaySubscription> {
  return request<RazorpaySubscription>(credentials, `/subscriptions/${encodeURIComponent(id)}`, { method: "PATCH", body: { plan_id: input.planId, schedule_change_at: input.scheduleChangeAt } }, fetchImpl);
}

/** Withdraws a plan change that has been scheduled and has not happened yet. */
export function cancelRazorpayScheduledChanges(credentials: RazorpayCredentials, id: string, fetchImpl?: FetchLike): Promise<RazorpaySubscription> {
  return request<RazorpaySubscription>(credentials, `/subscriptions/${encodeURIComponent(id)}/cancel_scheduled_changes`, { method: "POST" }, fetchImpl);
}

export async function listRazorpaySubscriptionInvoices(credentials: RazorpayCredentials, subscriptionId: string, fetchImpl?: FetchLike): Promise<RazorpayInvoice[]> {
  const data = await request<{ items?: RazorpayInvoice[] }>(credentials, `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=50`, { method: "GET" }, fetchImpl);
  return Array.isArray(data.items) ? data.items : [];
}

export function fetchRazorpayPayment(credentials: RazorpayCredentials, id: string, fetchImpl?: FetchLike): Promise<{ id: string; amount: number; currency: string; status: string; created_at?: number }> {
  return request(credentials, `/payments/${encodeURIComponent(id)}`, { method: "GET" }, fetchImpl);
}

export function createPaymentLink(
  credentials: RazorpayCredentials,
  input: CreatePaymentLinkInput,
  fetchImpl?: FetchLike,
): Promise<RazorpayPaymentLink> {
  return request<RazorpayPaymentLink>(
    credentials,
    "/payment_links",
    {
      method: "POST",
      body: {
        amount: input.amountMinor,
        currency: input.currency,
        accept_partial: false,
        reference_id: input.referenceId,
        description: input.description,
        customer: { name: input.customer.name, email: input.customer.email },
        // The store sends its own confirmation; Razorpay does not message the
        // customer on the business's behalf.
        notify: { sms: false, email: false },
        reminder_enable: false,
        callback_url: input.callbackUrl,
        callback_method: "get",
        expire_by: input.expireBy,
        // Lets a declined attempt's `payment.failed` event be traced to its order.
        notes: { siteforge_order: input.referenceId },
      },
    },
    fetchImpl,
  );
}

export async function fetchPaymentLink(
  credentials: RazorpayCredentials,
  linkId: string,
  fetchImpl?: FetchLike,
): Promise<RazorpayPaymentLink> {
  if (!/^plink_[A-Za-z0-9]+$/.test(linkId)) throw new RazorpayApiError(400, "invalid_link_id");
  return request<RazorpayPaymentLink>(credentials, `/payment_links/${linkId}`, { method: "GET" }, fetchImpl);
}

/** Closes an open link, so a cancelled order cannot be paid. */
export async function cancelPaymentLink(credentials: RazorpayCredentials, linkId: string, fetchImpl?: FetchLike): Promise<void> {
  if (!/^plink_[A-Za-z0-9]+$/.test(linkId)) throw new RazorpayApiError(400, "invalid_link_id");
  await request(credentials, `/payment_links/${linkId}/cancel`, { method: "POST", body: {} }, fetchImpl);
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
}

/**
 * Requests a refund. Razorpay treats the same `X-Refund-Idempotency` value as the
 * same refund, so retrying after a lost response cannot refund twice.
 */
export function createRefund(
  credentials: RazorpayCredentials,
  paymentId: string,
  input: { amountMinor: number; idempotencyKey: string; orderReference: string },
  fetchImpl?: FetchLike,
): Promise<RazorpayRefund> {
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new RazorpayApiError(400, "invalid_payment_id");
  return request<RazorpayRefund>(
    credentials,
    `/payments/${paymentId}/refund`,
    {
      method: "POST",
      body: { amount: input.amountMinor, speed: "normal", notes: { siteforge_order: input.orderReference } },
      headers: { "X-Refund-Idempotency": input.idempotencyKey },
    },
    fetchImpl,
  );
}

export function fetchRefund(credentials: RazorpayCredentials, refundId: string, fetchImpl?: FetchLike): Promise<RazorpayRefund> {
  if (!/^rfnd_[A-Za-z0-9]+$/.test(refundId)) throw new RazorpayApiError(400, "invalid_refund_id");
  return request<RazorpayRefund>(credentials, `/refunds/${refundId}`, { method: "GET" }, fetchImpl);
}

export interface RazorpayDispute {
  id: string;
  payment_id: string;
  amount: number;
  amount_deducted?: number | null;
  currency: string;
  reason_code?: string | null;
  /** Unix seconds. */
  respond_by?: number | null;
  status: string;
  phase?: string | null;
  /** Unix seconds. */
  created_at?: number | null;
}

export async function fetchDispute(
  credentials: RazorpayCredentials,
  disputeId: string,
  fetchImpl?: FetchLike,
): Promise<RazorpayDispute> {
  if (!/^disp_[A-Za-z0-9]+$/.test(disputeId)) throw new RazorpayApiError(400, "invalid_dispute_id");
  return request<RazorpayDispute>(credentials, `/disputes/${disputeId}`, { method: "GET" }, fetchImpl);
}

function hmacHex(secret: string, payload: string | Buffer): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqualHex(expected: string, provided: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided.toLowerCase(), "hex"));
}

/**
 * Signature Razorpay appends to the Payment Link callback redirect:
 * HMAC-SHA256(`link_id|reference_id|status|payment_id`, key_secret).
 * A valid signature is necessary but NOT sufficient: the server still fetches
 * the link from the API before treating anything as paid.
 */
export function verifyPaymentLinkCallbackSignature(
  keySecret: string,
  params: { linkId: string; referenceId: string; status: string; paymentId: string; signature: string },
): boolean {
  const payload = `${params.linkId}|${params.referenceId}|${params.status}|${params.paymentId}`;
  return safeEqualHex(hmacHex(keySecret, payload), params.signature);
}

/** Webhook signature: HMAC-SHA256 of the exact raw body with the webhook secret. */
export function verifyWebhookSignature(webhookSecret: string, rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  return safeEqualHex(hmacHex(webhookSecret, rawBody), signature);
}

/** Key ids look like `rzp_test_...` / `rzp_live_...`; the prefix must match the mode. */
export function keyIdMatchesMode(keyId: string, mode: "test" | "live"): boolean {
  return new RegExp(`^rzp_${mode}_[A-Za-z0-9]{6,40}$`).test(keyId);
}

/** Only Razorpay-hosted HTTPS links are ever handed to the browser for a redirect. */
export function isTrustedPaymentLinkUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "rzp.io" || host.endsWith(".rzp.io") || host === "razorpay.com" || host.endsWith(".razorpay.com"));
  } catch {
    return false;
  }
}

/**
 * Convert an order total (major units, e.g. 499.5) to the integer subunit
 * Razorpay expects. Refuses values that are not an exact number of subunits.
 */
export function toMinorUnits(total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const minor = Math.round(total * 100);
  if (Math.abs(total * 100 - minor) > 1e-6 || !Number.isSafeInteger(minor)) return null;
  return minor;
}
