// @ts-nocheck
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { resolveCommerceBusiness } from "@/lib/tenant";
import { getClientIp } from "@/lib/rate-limit";
import { validationMessage } from "@/lib/validation-messages";
import { enforceOrderCreateRateLimit } from "@/lib/storefront-rate-limit";
import { Product } from "@/models/Product";
import { Cart } from "@/models/Cart";
import { Order } from "@/models/Order";
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import crypto from "node:crypto";
import {
  MAX_OPEN_COD_ORDERS_PER_CUSTOMER,
  ORDER_RESERVATION_TTL_MS,
  releaseExpiredOrdersOnDemand,
} from "@/lib/orders/lifecycle";
import { isCustomerAccountsEnabled } from "@/lib/env";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { resolveCheckoutCustomer } from "@/lib/auth/customer-guards";
import { readCustomerSessionCookie } from "@/lib/auth/customer-session";
import { Customer } from "@/models/Customer";
import { assertOnlinePayable, isOnlinePaymentAvailable } from "@/lib/payments/order-payments";
import { recordMovements, reserveStock } from "@/lib/inventory";
import { effectivePrice, variantLabel } from "@/lib/product-variants";
import { assertCanAcceptOrder } from "@/lib/usage-limits";
import { SHIPPING_REFUSALS, addressRequired, guestCodAddressSchema, priceOrder, readShippingSettings, readTaxSettings, shippingAddressSchema } from "@/lib/checkout-pricing";
import { GUEST_COD_RESERVATION_MS, MAX_OPEN_COD_ORDERS_PER_GUEST, guestCodKeys } from "@/lib/orders/guest-cod";
import { resolveShopperCart } from "@/lib/cart/shopper-cart";
import { saveAddressFromOrder } from "@/lib/customer-addresses";
import { Business } from "@/models/Business";
import { assertGuestCouponPace, checkCoupon, claimCouponUse, couponIdentityKeys, customerKeyFor, emailKeyFor, recordRedemption } from "@/lib/coupons";
import { queueOrderEmail } from "@/lib/orders/notifications";
import { notifyOrder } from "@/lib/notification-events";
import {
  appendOrderAccessCookie,
  generateOrderProof,
  hashOrderProof,
  orderProofMatches,
  readOrderAccessCookie,
} from "@/lib/orders/ownership";

/**
 * Resolve the business from the trusted storefront Host header. The [id] route
 * parameter is intentionally ignored for tenant identity: a guest must never be
 * able to address a different tenant by editing the URL. This matches the cart
 * API and means rate-limit buckets, cart ownership and created orders all use
 * the same trusted tenant.
 */
async function resolveBusiness(request: Request) {
  const business = await resolveCommerceBusiness(request.headers.get("host"));
  if (!business) {
    throw new HttpError(404, "Business not found", "not_found");
  }
  return business;
}

/**
 * Payment methods a storefront request may ask for: cash on delivery, or
 * online payment through the business's own Razorpay account (each further
 * gated below). Omitting the field keeps the existing guest checkout, whose
 * orders have no payment method.
 */
const SELECTABLE_PAYMENT_METHODS = ["cod", "online"] as const;
type SelectablePaymentMethod = (typeof SELECTABLE_PAYMENT_METHODS)[number];

function parsePaymentMethod(value: unknown): SelectablePaymentMethod | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && (SELECTABLE_PAYMENT_METHODS as readonly string[]).includes(value)) {
    return value as SelectablePaymentMethod;
  }
  throw new HttpError(400, "This payment method is not available", "invalid_payment_method");
}

/** Keyed by field, so the checkout form can show each problem beside its input. */
function shippingAddressError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = ["shippingAddress", ...issue.path].join(".");
    if (!fields[key]) fields[key] = validationMessage(issue);
  }
  return new HttpError(400, error.issues[0] ? validationMessage(error.issues[0]) : "Enter a delivery address.", "invalid_shipping_address", undefined, fields);
}

/**
 * Validate every cart item against the database and price it server-side.
 * Read-only: no inventory is touched. Throws HttpError for a missing,
 * cross-business, or unavailable product.
 */
async function priceCartItems(
  cartItems: any[],
  businessId: string,
  session: mongoose.ClientSession
) {
  const validatedItems: Array<{
    product: any;
    productName: string;
    quantity: number;
    priceSnapshot: number;
    currency: string;
    variant: any;
    variantLabel: string;
    sku: string;
    category: string;
    imageUrl: string;
  }> = [];

  for (const cartItem of cartItems) {
    const quantity = cartItem.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new HttpError(
        400,
        "Quantity must be a positive integer",
        "invalid_quantity",
      );
    }

    const product = await Product.findById(cartItem.product).session(session);
    if (!product) {
      throw new HttpError(404, `Product ${cartItem.product} no longer exists`, "product_gone");
    }

    if (product.business.toString() !== businessId) {
      throw new HttpError(403, `Product ${cartItem.product} does not belong to this business`, "cross_business_product");
    }

    if (product.status !== "active") {
      throw new HttpError(404, `Product ${cartItem.product} is not available for purchase`, "product_unavailable");
    }

    // Variant products are bought per variant: the line must name a live
    // variant of THIS product; its price and label are snapshotted.
    const hasVariants = Array.isArray(product.options) && product.options.length > 0;
    const variantIdValue = cartItem.variant ? String(cartItem.variant) : "";
    let variant: any = null;
    if (hasVariants) {
      variant = (product.variants ?? []).find((v: any) => String(v._id) === variantIdValue && !v.archived) ?? null;
      if (!variant) {
        throw new HttpError(409, "A product option in your cart is no longer available", "variant_unavailable");
      }
    } else if (variantIdValue) {
      throw new HttpError(409, "A product option in your cart is no longer available", "variant_unavailable");
    }

    validatedItems.push({
      product: product._id,
      productName: product.name,
      quantity,
      priceSnapshot: effectivePrice(product.price, variant),
      currency: product.currency || "USD",
      variant: variant ? variant._id : null,
      variantLabel: variant ? variantLabel(variant.options) : "",
      sku: (variant ? variant.sku : product.sku) || "",
      category: product.category || "",
      imageUrl: variant?.imageUrl || product.imageUrl || product.images?.[0] || "",
    });
  }

  return validatedItems;
}

/** Shape validated items for the order document. */
function toOrderItems(items: Array<{ product: any; productName: string; quantity: number; priceSnapshot: number; currency: string; variant?: any; variantLabel?: string; sku?: string; imageUrl?: string }>) {
  return items.map((item) => ({
    product: item.product,
    productName: item.productName,
    quantity: item.quantity,
    unitPrice: item.priceSnapshot,
    currency: item.currency,
    // Exact purchased variant, kept even if the product changes later.
    ...(item.variant ? { variant: String(item.variant), variantLabel: item.variantLabel } : {}),
    ...(item.sku ? { sku: item.sku } : {}),
    ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
  }));
}

/**
 * Derive the single order-level currency. Payment reconciliation must never
 * sum mixed-currency line items into one total.
 */
function resolveOrderCurrency(
  items: Array<{ currency: string }>
): string {
  const currencies = new Set(
    items.map((item) => (item.currency || "USD").toUpperCase())
  );
  if (currencies.size === 0) {
    throw new HttpError(400, "Cart is empty, cannot create order", "empty_cart");
  }
  if (currencies.size > 1) {
    throw new HttpError(
      400,
      "All items in an order must use the same currency",
      "currency_mismatch"
    );
  }
  return [...currencies][0];
}

/** Set order-number cookie in the response. */
function setOrderNumberCookie(
  response: NextResponse,
  orderNumber: string
): NextResponse {
  // append, not set: the response already carries the cart-token clearing
  // cookie, and `set` would overwrite it.
  response.headers.append(
    "Set-Cookie",
    `order-number=${orderNumber}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );
  return response;
}

/** Get order-number from the response (for backward compatibility). */
function getOrderNumberFromResponse(response: NextResponse): string | null {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(/order-number=([^;]+)/);
  return match ? match[1] : null;
}

/** Parse customer name, email, and idempotency key from request body.
 *  Reads the Content-Type header first and consumes the body exactly once
 *  with the matching parser:
 *    - application/json                -> request.json()
 *    - application/x-www-form-urlencoded -> request.formData()
 *  The body stream can only be consumed once, so the parser must be chosen
 *  before touching it. Unsupported/malformed payloads become a 400.
 */
async function parseRequestBody(request: Request): Promise<{
  customerName: string;
  customerEmail: string;
  idempotencyKey?: string;
  orderProof?: string;
  paymentMethod?: SelectablePaymentMethod;
  couponCode?: string;
  shippingAddress?: unknown;
  saveAddress?: boolean;
}> {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  let customerName: string | null = null;
  let customerEmail: string | null = null;
  let idempotencyKey: string | null = null;
  let paymentMethod: SelectablePaymentMethod | undefined;
  let couponCode: string | undefined;
  let shippingAddress: unknown;
  let saveAddress = false;
  // The proof may travel as a header (preferred for retries) or in the body.
  let orderProof: string | null = request.headers.get("x-order-proof")?.trim() || null;

  if (contentType.includes("application/json")) {
    let json: any;
    try {
      json = await request.json();
    } catch {
      throw new HttpError(400, "Invalid request payload: failed to parse JSON", "invalid_payload");
    }
    // Only strings are accepted: `String({})` would otherwise become a name.
    if (typeof json?.customerName === "string") customerName = json.customerName.trim();
    if (typeof json?.customerEmail === "string") customerEmail = json.customerEmail.trim();
    if (typeof json?.idempotencyKey === "string") idempotencyKey = json.idempotencyKey.trim();
    if (typeof json?.orderProof === "string" && json.orderProof.trim()) {
      orderProof = json.orderProof.trim();
    }
    paymentMethod = parsePaymentMethod(json?.paymentMethod);
    if (typeof json?.couponCode === "string" && json.couponCode.trim()) couponCode = json.couponCode.trim().slice(0, 64);
    if (json?.shippingAddress !== undefined) shippingAddress = json.shippingAddress;
    saveAddress = json?.saveAddress === true;
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new HttpError(400, "Invalid request payload: failed to parse form data", "invalid_payload");
    }
    const cn = formData.get("customerName");
    const ce = formData.get("customerEmail");
    const ck = formData.get("idempotencyKey");
    const cp = formData.get("orderProof");
    if (cn != null) customerName = cn.toString().trim();
    if (ce != null) customerEmail = ce.toString().trim();
    if (ck != null) idempotencyKey = ck.toString().trim();
    if (cp != null && cp.toString().trim()) orderProof = cp.toString().trim();
    const pm = formData.get("paymentMethod");
    paymentMethod = parsePaymentMethod(pm == null ? undefined : pm.toString());
    const cc = formData.get("couponCode");
    if (cc != null && cc.toString().trim()) couponCode = cc.toString().trim().slice(0, 64);
  } else {
    throw new HttpError(
      400,
      "Unsupported Content-Type: expected application/json or application/x-www-form-urlencoded",
      "invalid_payload",
    );
  }

  if (!customerName || !customerEmail) {
    throw new HttpError(400, "Invalid request payload: customerName and customerEmail are required", "invalid_payload");
  }

  // Validate here, before any write: the keyed path upserts without running
  // Mongoose validators, and a ValidationError on the keyless path would
  // otherwise surface as a 500.
  if (customerName.length > 100) {
    throw new HttpError(400, "Name must be 100 characters or fewer", "invalid_customer_name");
  }
  if (customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    throw new HttpError(400, "Enter a valid email address", "invalid_customer_email");
  }
  customerEmail = customerEmail.toLowerCase();
  if (idempotencyKey && idempotencyKey.length > 128) {
    throw new HttpError(400, "Invalid idempotency key", "invalid_idempotency_key");
  }

  if (orderProof && orderProof.length > 512) {
    throw new HttpError(400, "Invalid order proof", "invalid_order_proof");
  }

  return {
    customerName,
    customerEmail,
    idempotencyKey: idempotencyKey || undefined,
    orderProof: orderProof || undefined,
    paymentMethod,
    couponCode,
    shippingAddress,
    saveAddress,
  };
}

/** Detect a MongoDB duplicate-key error (unique index violation). */
function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      ((error as { code?: number }).code === 11000 ||
        (error as { code?: number }).code === 11001)
  );
}

/**
 * A retry may prove ownership with any proof transport the request carries
 * (header/body/order-access cookie) or with the original cart-token cookie
 * (the pre-existing guest credential). The 12-char order number is never
 * accepted as authority.
 */
function guestOwnsOrder(
  order: any,
  providedProofs: Array<string | null | undefined>,
  cookieOwnerToken: string | null
): boolean {
  if (providedProofs.some((proof) => orderProofMatches(proof, order.orderProofHash))) {
    return true;
  }
  return Boolean(cookieOwnerToken) && order.ownerToken === cookieOwnerToken;
}

/** Echo a proof only when it genuinely belongs to this order. */
function proofForResponse(
  order: any,
  providedProofs: Array<string | null | undefined>
): string | undefined {
  return providedProofs.find((proof) => orderProofMatches(proof, order.orderProofHash)) ?? undefined;
}

/**
 * Rotate a proof after a cookie-authenticated replay that did not carry a
 * recoverable proof (for example the browser kept the consumed cart-token but
 * lost the order-access cookie). The compare-and-swap on the old digest makes
 * rotation atomic: a concurrent rotation cannot be overwritten, and the caller
 * that loses returns the order without inventing an already-invalid proof.
 * Only the new raw proof is returned, through the response body/cookie.
 */
async function rotateOrderProofForCookie(
  order: any,
  businessId: string,
  ownerToken: string
): Promise<{ order: any; proof?: string }> {
  const replacement = generateOrderProof();
  const replacementHash = hashOrderProof(replacement);
  const updated = await Order.findOneAndUpdate(
    {
      _id: order._id,
      business: businessId,
      ownerToken,
      orderProofHash: order.orderProofHash ?? null,
    },
    { $set: { orderProofHash: replacementHash } },
    { new: true },
  );

  if (updated) {
    return { order: updated, proof: replacement };
  }

  // Another request rotated first. Re-read for the response, but do not issue
  // a second replacement: the winner's proof is the only valid one.
  const latest = await Order.findOne({
    _id: order._id,
    business: businessId,
  }).select("+orderProofHash");
  return { order: latest ?? order, proof: undefined };
}

/**
 * Atomically claim an idempotency key.
 *
 * Runs BEFORE any inventory is decremented. `$setOnInsert` makes concurrent
 * claims race on the `{business, idempotencyKey}` unique index: exactly one
 * request inserts, every other one matches the existing order. The returned
 * `reused` flag tells the caller whether it must skip inventory changes.
 */
async function claimIdempotentOrder(
  session: mongoose.ClientSession,
  businessId: string,
  ownerToken: string,
  customerName: string,
  customerEmail: string,
  items: any[],
  subtotal: number,
  finalTotal: number,
  idempotencyKey: string,
  orderProofHash: string | null,
  currency: string,
  reservationExpiresAt: Date | null,
  accountFields: Record<string, unknown>,
  pricingFields: Record<string, unknown>
) {
  const result = await Order.findOneAndUpdate(
    { business: businessId, idempotencyKey },
    {
      // $setOnInsert only: a retry with the same key never changes an existing
      // order's customer or payment method.
      $setOnInsert: {
        business: businessId,
        idempotencyKey,
        ownerToken,
        customerName,
        customerEmail,
        items: toOrderItems(items),
        subtotal,
        total: finalTotal,
        status: "pending",
        currency,
        inventoryState: "reserved",
        reservationExpiresAt,
        orderProofHash,
        ...accountFields,
        ...pricingFields,
      },
    },
    { upsert: true, new: true, session, includeResultMetadata: true }
  );

  const metadata = (result as any)?.lastErrorObject;
  const order = (result as any)?.value ?? result;
  return { order, reused: Boolean(metadata?.updatedExisting) };
}

/** Build the public order response (same shape as before, plus the proof cookie). */
function buildOrderResponse(order: any, orderProof?: string) {
  const resp = ok({
    orderId: order._id,
    orderNumber: order.orderNumber,
    businessId: order.business,
    status: order.status,
    items: order.items,
    subtotal: order.subtotal,
    ...(order.discountTotal ? { discountTotal: order.discountTotal } : {}),
    ...(typeof order.shippingTotal === "number" ? { shippingTotal: order.shippingTotal } : {}),
    ...(order.taxTotal ? { taxTotal: order.taxTotal, taxLabel: order.taxLabel, taxInclusive: order.taxInclusive } : {}),
    total: order.total,
    customerName: order.customerName,
    ...(order.paymentMethod ? { paymentMethod: order.paymentMethod } : {}),
    ...(orderProof ? { orderProof } : {}),
  });
  resp.headers.append(
    "Set-Cookie",
    "cart-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  setOrderNumberCookie(resp, order.orderNumber);
  if (orderProof) {
    appendOrderAccessCookie(resp, orderProof);
  }
  return resp;
}

/** Export the POST handler. */
export async function POST(request: Request) {
  return handle(async () => {
    // Resolve the trusted tenant before any order/cart/inventory work, then
    // throttle the attempt before parsing the body or touching inventory.
    const business = await resolveBusiness(request);
    const businessId = business._id.toString();
    await enforceOrderCreateRateLimit(request, businessId);
    // Free stock held by abandoned unpaid orders before reserving more.
    await releaseExpiredOrdersOnDemand(businessId);

    // Parse the request body for customer details, key, proof and payment.
    const parsed = await parseRequestBody(request);
    const { customerName, idempotencyKey, orderProof, paymentMethod, couponCode } = parsed;
    // Shipping: settings from the store; the address is validated before any
    // write (and required only when the store ships with an address step).
    const shippingSettings = readShippingSettings(business.shippingSettings);
    const taxSettings = readTaxSettings(business.taxSettings);
    let shippingAddress: Record<string, string> | null = null;
    if (addressRequired(shippingSettings)) {
      const address = shippingAddressSchema.safeParse(parsed.shippingAddress);
      if (!address.success) throw shippingAddressError(address.error);
      shippingAddress = address.data;
    }
    let customerEmail = parsed.customerEmail;

    // The cookie is optional: a retry may arrive after it was cleared. When it
    // is absent we fabricate a token for a *new* cart only; it is never used to
    // authorize an existing order.
    // A signed-in customer's own cart, or the guest cart the cookie names.
    const { token: cookieOwnerToken } = await resolveShopperCart(request, business);
    const ownerToken = cookieOwnerToken ?? crypto.randomUUID();
    const proofCandidates = [orderProof, readOrderAccessCookie(request)];

    // ---- Replay fast path -------------------------------------------------
    // Resolve an existing order before requiring a cart, so retries still work
    // after the cart was consumed or the cookie was cleared. Ownership must be
    // proven with a proof or the original cart-token cookie; a mismatched
    // request gets a generic conflict and never sees the order.
    if (idempotencyKey) {
      const existing = await Order.findOne({ business: businessId, idempotencyKey })
        .select("+orderProofHash");

      if (existing) {
        if (!guestOwnsOrder(existing, proofCandidates, cookieOwnerToken)) {
          throw new HttpError(
            409,
            "This idempotency key is already in use",
            "idempotency_conflict",
          );
        }

        const matchingProof = proofForResponse(existing, proofCandidates);
        if (matchingProof) {
          return buildOrderResponse(existing, matchingProof);
        }

        // The cart-token proves ownership, but no usable proof arrived. Rotate
        // atomically and return the replacement through the body + cookie.
        if (cookieOwnerToken && existing.ownerToken === cookieOwnerToken) {
          const rotated = await rotateOrderProofForCookie(
            existing,
            businessId,
            cookieOwnerToken,
          );
          return buildOrderResponse(rotated.order, rotated.proof);
        }
      }
    }

    // A quick answer, after the replay above so a retried order still gets its own.
    // The exact check is inside the transaction below.
    await assertCanAcceptOrder(businessId);

    // ---- Customer-aware checkout (Phase 4B) --------------------------------
    // Only while customer accounts are enabled. A request that selects cash on
    // delivery, or carries a customer session cookie, must be a same-origin
    // JSON request: sibling store subdomains are "same-site", so SameSite
    // cookies alone would not stop another store's page from submitting a
    // form here with this customer's cookies.
    const accountsEnabled = isCustomerAccountsEnabled();
    const isCod = paymentMethod === "cod";
    // Guests need the store's own say-so on top of cash on delivery being on.
    const guestCodAllowed = business.guestCodEnabled === true;
    if (isCod && (business.codEnabled !== true || (!accountsEnabled && !guestCodAllowed))) {
      throw new HttpError(403, "Cash on delivery is not available for this store", "cod_unavailable");
    }
    if (isCod) assertSameOriginJsonRequest(request);
    const isOnline = paymentMethod === "online";
    if (isOnline) {
      // Starting a payment redirects the shopper off-site, so the order must
      // come from this store's own page (same-origin JSON).
      assertSameOriginJsonRequest(request);
      if (!(await isOnlinePaymentAvailable(business._id))) {
        throw new HttpError(403, "Online payment is not available for this store", "online_payment_unavailable");
      }
    }
    let customerId: string | null = null;
    if (accountsEnabled && (isCod || readCustomerSessionCookie(request) !== null)) {
      assertSameOriginJsonRequest(request);
      const resolution = await resolveCheckoutCustomer(request, business);
      if (resolution.status === "customer") {
        customerId = resolution.customer.id;
        // The account's email is authoritative for an order tied to it.
        customerEmail = resolution.customer.email;
      } else if (isCod && !guestCodAllowed) {
        if (resolution.status === "unverified") {
          throw new HttpError(403, "Please confirm your email address to pay with cash on delivery", "customer_email_unverified");
        }
        throw new HttpError(401, "Sign in to your account to pay with cash on delivery", "customer_sign_in_required");
      }
      // Otherwise an invalid, revoked, foreign-store, inactive or unverified session is
      // ignored: the order is a plain guest order.
    }

    // A guest paying cash: the store has only their details to deliver and confirm with,
    // so the address and phone are required, even if the store collects no address otherwise.
    const isGuestCod = isCod && customerId === null;
    let guestKeys: string[] = [];
    if (isGuestCod) {
      const raw = parsed.shippingAddress && typeof parsed.shippingAddress === "object" ? parsed.shippingAddress : {};
      const address = guestCodAddressSchema.safeParse({ name: "", line1: "", city: "", postalCode: "", country: "", phone: "", ...raw });
      if (!address.success) throw shippingAddressError(address.error);
      shippingAddress = address.data;
      guestKeys = guestCodKeys(businessId, { email: customerEmail, phone: address.data.phone });
    }
    // Server-assigned only. Guest orders without a selected method keep NO
    // payment method and no customer (unchanged); with `$setOnInsert` a retry
    // can never add or change them later.
    const accountFields: Record<string, unknown> = {
      ...(customerId ? { customer: new mongoose.Types.ObjectId(customerId) } : {}),
      ...(isCod ? { paymentMethod: "cod" } : {}),
      ...(isOnline ? { paymentMethod: "online" } : {}),
      ...(isGuestCod ? { guestCodKeys: guestKeys } : {}),
    };

    // Every new order, keyed or keyless, receives its own proof. Only the
    // digest is persisted; the raw proof is returned in the response and set
    // as a host-only cookie.
    const generatedProof = generateOrderProof();
    const generatedProofHash = hashOrderProof(generatedProof);
    // Stable across withTransaction retries: the reservation starts when this
    // request began, not when a retry happened. Cash-on-delivery orders do
    // not expire automatically (payment happens on delivery, possibly days
    // later); the owner confirms or cancels them, and each customer may hold
    // at most MAX_OPEN_COD_ORDERS_PER_CUSTOMER of them. A guest's hold does end, if the
    // store never confirms it (lib/orders/guest-cod.ts): nobody verified stands behind it.
    const reservationExpiresAt = isGuestCod
      ? new Date(Date.now() + GUEST_COD_RESERVATION_MS)
      : isCod
        ? null
        : new Date(Date.now() + ORDER_RESERVATION_TTL_MS);
    let proofToReturn: string | undefined;
    // True only for the request that created the order, never for a replay.
    let createdNewOrder = false;

    // Start a MongoDB session for atomic inventory, order, and cart changes.
    const session = await mongoose.startSession();
    let order: any = null;

    try {
      // withTransaction retries transient errors (e.g. the write conflict two
      // requests cause when they touch the same product document) and aborts
      // automatically whenever the callback throws.
      await session.withTransaction(async () => {
        order = null;
        proofToReturn = undefined;
        createdNewOrder = false;

        // Re-check the key inside the transaction. This closes the race where
        // another request inserted the order between the fast path and here.
        if (idempotencyKey) {
          const existing = await Order.findOne({
            business: businessId,
            idempotencyKey,
          })
            .select("+orderProofHash")
            .session(session);

          if (existing) {
            if (!guestOwnsOrder(existing, proofCandidates, cookieOwnerToken)) {
              throw new HttpError(
                409,
                "This idempotency key is already in use",
                "idempotency_conflict",
              );
            }
            order = existing;
            proofToReturn =
              proofForResponse(existing, proofCandidates) ??
              (existing.orderProofHash === generatedProofHash
                ? generatedProof
                : undefined);
            return; // commit the no-op transaction; inventory stays untouched
          }
        }

        // A guest token may be consumed by exactly one order. This blocks a
        // stale cart (or a replayed cookie) from creating a second purchase
        // even if a legacy cart document survived the first order.
        const priorOrder = await Order.findOne({
          business: businessId,
          ownerToken,
        })
          .select("_id")
          .session(session);

        if (priorOrder) {
          throw new HttpError(
            409,
            "This cart has already been used for another order",
            "cart_conflict",
          );
        }

        // Read the cart inside the transaction so pricing and deletion see the
        // same version of the cart.
        const cart = await Cart.findOne({ business: businessId, ownerToken }).session(
          session,
        );
        if (!cart) {
          throw new HttpError(404, "Cart not found for this guest", "cart_not_found");
        }
        if (cart.items.length === 0) {
          throw new HttpError(400, "Cart is empty, cannot create order", "empty_cart");
        }

        // Server-side validation + pricing (read-only, no inventory change).
        const validatedItems = await priceCartItems(cart.items, businessId, session);
        let subtotal = 0;
        for (const item of validatedItems) {
          subtotal += item.priceSnapshot * item.quantity;
        }
        const orderCurrency = resolveOrderCurrency(validatedItems);
        // Coupon validated here (no use consumed yet); totals computed on the
        // server only. One coupon per order (no stacking).
        const lines = validatedItems.map((item) => ({ product: String(item.product), category: item.category, lineTotal: item.priceSnapshot * item.quantity }));
        const coupon = couponCode
          ? await checkCoupon({ session, businessId, code: couponCode, subtotal, currency: orderCurrency, lines, signedIn: customerId !== null })
          : null;
        const totals = priceOrder({ subtotal, eligible: coupon?.eligible, coupon, shipping: shippingSettings, tax: taxSettings, destination: shippingAddress });
        if (!totals.shipping.deliverable) {
          throw new HttpError(422, SHIPPING_REFUSALS[totals.shipping.refusal], "shipping_unavailable");
        }
        subtotal = totals.subtotal;
        const finalTotal = totals.total;
        if (isCod && (!totals.shipping.codAvailable || (shippingSettings.enabled && shippingSettings.codMaxOrder !== null && finalTotal > shippingSettings.codMaxOrder))) {
          throw new HttpError(409, "Cash on delivery is not available for this order. Please choose another way to pay.", "cod_not_available_for_order");
        }
        const customerKey = customerKeyFor({ customerId, email: customerEmail });
        const emailKey = emailKeyFor(customerEmail);
        const couponIdentity = coupon ? couponIdentityKeys(coupon, shippingAddress) : {};
        const pricingFields: Record<string, unknown> = {
          ...(coupon
            ? { discount: { coupon: coupon.couponId, code: coupon.code, type: coupon.type, value: coupon.value, amount: totals.discountTotal }, discountTotal: totals.discountTotal }
            : {}),
          ...(shippingSettings.enabled ? { shippingTotal: totals.shippingTotal } : {}),
          ...(totals.shipping.zone ? { shippingZoneName: totals.shipping.zone.name } : {}),
          ...(taxSettings.enabled ? { taxTotal: totals.taxTotal, taxLabel: totals.taxLabel, taxInclusive: totals.taxInclusive } : {}),
          ...(shippingAddress ? { shippingAddress } : {}),
        };
        if (isOnline) assertOnlinePayable(finalTotal, orderCurrency);

        if (isGuestCod) {
          // Take turns on the store's own document (write conflict -> withTransaction
          // retry), so two orders at once cannot both pass the count below.
          await Business.updateOne({ _id: business._id }, { $set: { lastGuestCodOrderAt: new Date() } }, { session, timestamps: false });
          const openGuestCod = await Order.countDocuments({
            business: businessId,
            paymentMethod: "cod",
            status: "pending",
            guestCodKeys: { $in: guestKeys },
          }).session(session);
          if (openGuestCod >= MAX_OPEN_COD_ORDERS_PER_GUEST) {
            throw new HttpError(409, "You already have open cash-on-delivery orders at this store. Please wait until one is delivered or cancelled.", "cod_limit_reached");
          }
        } else if (isCod) {
          // Serialize concurrent COD checkouts of one customer on the account
          // document (write conflict -> withTransaction retry), re-check that
          // the account is still active and verified, then cap open COD orders.
          const lock = await Customer.updateOne(
            {
              _id: new mongoose.Types.ObjectId(customerId),
              business: business._id,
              active: true,
              emailVerifiedAt: { $type: "date" },
            },
            { $set: { updatedAt: new Date() } },
            { session, timestamps: false },
          );
          if (lock.matchedCount !== 1) {
            throw new HttpError(401, "Sign in to your account to pay with cash on delivery", "customer_sign_in_required");
          }
          const openCod = await Order.countDocuments({
            business: businessId,
            customer: new mongoose.Types.ObjectId(customerId),
            paymentMethod: "cod",
            status: "pending",
          }).session(session);
          if (openCod >= MAX_OPEN_COD_ORDERS_PER_CUSTOMER) {
            throw new HttpError(
              409,
              `You already have ${MAX_OPEN_COD_ORDERS_PER_CUSTOMER} open cash-on-delivery orders at this store. Please wait until one is completed or cancelled.`,
              "cod_limit_reached",
            );
          }
        }

        if (idempotencyKey) {
          // Claim the key BEFORE decrementing stock. A replayed request finds
          // the existing order and returns it without touching inventory.
          const claim = await claimIdempotentOrder(
            session,
            businessId,
            ownerToken,
            customerName,
            customerEmail,
            validatedItems,
            subtotal,
            finalTotal,
            idempotencyKey,
            generatedProofHash,
            orderCurrency,
            reservationExpiresAt,
            accountFields,
            pricingFields,
          );

          if (claim.reused) {
            // A concurrent request won the claim. It must own the order, and
            // it (not this request) is responsible for consuming the cart.
            const winner = await Order.findById(claim.order._id)
              .select("+orderProofHash")
              .session(session);

            if (!winner || !guestOwnsOrder(winner, proofCandidates, cookieOwnerToken)) {
              throw new HttpError(
                409,
                "This idempotency key is already in use",
                "idempotency_conflict",
              );
            }

            order = winner;
            proofToReturn = proofForResponse(winner, proofCandidates);
            return;
          }

          order = claim.order;
          proofToReturn = generatedProof ?? undefined;
        }

        // Take the store's turn and count this month's orders, so orders at the same moment
        // cannot pass the plan's limit. A keyed order was inserted just above: not itself.
        await assertCanAcceptOrder(businessId, { session, alreadyCounted: idempotencyKey ? 1 : 0 });

        // This request owns the new order: claim the coupon use now (a
        // concurrent winner above returned before consuming anything).
        if (coupon) {
          if (!customerId && coupon.perCustomerLimit !== null) await assertGuestCouponPace(coupon.couponId, getClientIp(request));
          await claimCouponUse({ session, businessId, coupon, customerKey, emailKey, identity: couponIdentity });
        }

        // Reserve inventory atomically for all cart items. Any failure throws,
        // aborting the transaction and rolling back every decrement.
        const reserved = await reserveStock(validatedItems, businessId, session);

        if (!idempotencyKey) {
          const created = await Order.create(
            [
              {
                business: businessId,
                ownerToken,
                customerName,
                customerEmail,
                items: toOrderItems(validatedItems),
                subtotal,
                total: finalTotal,
                status: "pending",
                currency: orderCurrency,
                inventoryState: "reserved",
                reservationExpiresAt,
                orderProofHash: generatedProofHash,
                ...accountFields,
                ...pricingFields,
              },
            ],
            { session },
          );
          order = created[0];
          proofToReturn = generatedProof;
        }

        // Stock history and coupon redemption, in the same transaction.
        await recordMovements(businessId, reserved, { reason: "order_reserved", order: order._id }, session);
        if (coupon) {
          await recordRedemption({ session, businessId, coupon, orderId: order._id, customerKey, emailKey, identity: couponIdentity, amount: totals.discountTotal, currency: orderCurrency });
        }

        // Consume the cart in the same transaction as the order and stock
        // changes. A null result means another request already consumed this
        // guest token; abort so no duplicate order or decrement survives.
        const consumed = await Cart.findOneAndDelete({
          business: businessId,
          ownerToken,
        }).session(session);

        if (!consumed) {
          throw new HttpError(
            409,
            "This cart has already been used for another order",
            "cart_conflict",
          );
        }
        createdNewOrder = true;
      });

      if (!order) {
        throw new HttpError(500, "Order was not created", "order_missing");
      }

      if (createdNewOrder) notifyOrder("placed", businessId, String(order._id));
      // An online order is confirmed when it is paid; the others are placed now.
      if (createdNewOrder && !isOnline) {
        queueOrderEmail("placed", businessId, String(order._id));
        queueOrderEmail("owner_new_order", businessId, String(order._id));
      }
      if (createdNewOrder && customerId && parsed.saveAddress === true && shippingAddress) {
        await saveAddressFromOrder(business._id, customerId, shippingAddress);
      }

      return buildOrderResponse(order, proofToReturn);
    } catch (error) {
      // A concurrent request with the same key won the unique-index race.
      // The transaction is already aborted; return the winner's order only if
      // this request can prove it belongs to the same guest.
      if (idempotencyKey && isDuplicateKeyError(error)) {
        const existing = await Order.findOne({ business: businessId, idempotencyKey })
          .select("+orderProofHash");

        // No order for this key means the duplicate came from another unique
        // constraint (e.g. the random orderNumber); surface the original error.
        if (!existing) {
          throw error;
        }

        if (guestOwnsOrder(existing, proofCandidates, cookieOwnerToken)) {
          return buildOrderResponse(existing, proofForResponse(existing, proofCandidates));
        }

        throw new HttpError(
          409,
          "This idempotency key is already in use",
          "idempotency_conflict",
        );
      }
      throw error;
    } finally {
      session.endSession();
    }
  });
}
