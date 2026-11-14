import { enforceRateLimit, getClientIp } from "./rate-limit";

/**
 * Rate limits for the public guest cart and order APIs.
 *
 * Rationale:
 * - Cart reads are cheap (one tenant lookup plus one cart read). 120/minute
 *   leaves room for multiple tabs, refreshes and client-side polling while
 *   still stopping scrapers and cart-creation floods.
 * - Cart writes are user actions and more expensive (product validation and a
 *   cart write). 60/minute is far above ordinary add/update/remove bursts,
 *   including several shoppers behind one NAT address, but bounds automated
 *   writes.
 * - Order creation reserves inventory and runs a transaction. 10 attempts per
 *   10 minutes leaves room for ordinary network retries and idempotent replays
 *   while making stock exhaustion and order spam expensive.
 * - Order status reads are cheap and read-only. 60/minute supports refreshes
 *   and status polling while bounding enumeration attempts.
 *
 * Buckets are scoped to the host-resolved business AND the trusted client IP.
 * One storefront cannot consume another's allowance, and changing the URL
 * business id has no effect on the bucket (the cart/order handlers never use it
 * for tenant identity).
 *
 * These limits reuse lib/rate-limit.ts, whose counters live in MongoDB. That
 * makes them shared by every app instance/serverless invocation using the same
 * database, unlike an in-memory limiter. Operational limits of that design:
 * - It is a fixed window, so a burst can straddle a window boundary and briefly
 *   allow up to roughly twice the configured limit. Bucket keys include the
 *   window, so old counters never leak into a later window.
 * - Every limiter call is a MongoDB round trip. The limiter therefore adds
 *   database load under abuse and can be a hot document for one tenant/IP.
 * - A missing production `TRUSTED_IP_HEADER`, or an unverifiable unique index,
 *   fails closed (503) rather than silently allowing traffic.
 * - Guests behind a shared NAT share a bucket. Distributed attackers get one
 *   bucket per IP; there is no global cross-tenant quota in this phase.
 * - TTL cleanup is eventual only; correctness does not depend on it.
 */
export const CART_READ_WINDOW_MS = 60 * 1000;
export const CART_READ_LIMIT = 120;

export const CART_WRITE_WINDOW_MS = 60 * 1000;
export const CART_WRITE_LIMIT = 60;

export const ORDER_CREATE_WINDOW_MS = 10 * 60 * 1000;
export const ORDER_CREATE_LIMIT = 10;

export const ORDER_READ_WINDOW_MS = 60 * 1000;
export const ORDER_READ_LIMIT = 60;

export const ORDER_CANCEL_WINDOW_MS = 10 * 60 * 1000;
export const ORDER_CANCEL_LIMIT = 10;

export async function enforceCartReadRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:cart:read:${businessId}:${getClientIp(request)}`,
    limit: CART_READ_LIMIT,
    windowMs: CART_READ_WINDOW_MS,
  });
}

export async function enforceCartWriteRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:cart:write:${businessId}:${getClientIp(request)}`,
    limit: CART_WRITE_LIMIT,
    windowMs: CART_WRITE_WINDOW_MS,
  });
}

export async function enforceOrderCreateRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:order:create:${businessId}:${getClientIp(request)}`,
    limit: ORDER_CREATE_LIMIT,
    windowMs: ORDER_CREATE_WINDOW_MS,
  });
}

export async function enforceOrderReadRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:order:read:${businessId}:${getClientIp(request)}`,
    limit: ORDER_READ_LIMIT,
    windowMs: ORDER_READ_WINDOW_MS,
  });
}

export async function enforceOrderCancelRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:order:cancel:${businessId}:${getClientIp(request)}`,
    limit: ORDER_CANCEL_LIMIT,
    windowMs: ORDER_CANCEL_WINDOW_MS,
  });
}

export const ORDER_PAY_WINDOW_MS = 10 * 60 * 1000;
export const ORDER_PAY_LIMIT = 20;

/** Starting an online payment (creates a provider Payment Link). */
export async function enforceOrderPayRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:order:pay:${businessId}:${getClientIp(request)}`,
    limit: ORDER_PAY_LIMIT,
    windowMs: ORDER_PAY_WINDOW_MS,
  });
}

export const COUPON_CHECK_WINDOW_MS = 10 * 60 * 1000;
export const COUPON_CHECK_LIMIT = 20;

/** Coupon code checks in the cart (limits guessing codes). */
export async function enforceCouponCheckRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:coupon:check:${businessId}:${getClientIp(request)}`,
    limit: COUPON_CHECK_LIMIT,
    windowMs: COUPON_CHECK_WINDOW_MS,
  });
}

export const REVIEW_SUBMIT_WINDOW_MS = 60 * 60 * 1000;
export const REVIEW_SUBMIT_LIMIT = 10;

/** Review submissions (spam protection). */
export async function enforceReviewSubmitRateLimit(
  request: Request,
  businessId: string,
): Promise<void> {
  await enforceRateLimit({
    key: `storefront:review:submit:${businessId}:${getClientIp(request)}`,
    limit: REVIEW_SUBMIT_LIMIT,
    windowMs: REVIEW_SUBMIT_WINDOW_MS,
  });
}
