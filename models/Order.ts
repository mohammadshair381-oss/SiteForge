// @ts-nocheck
import { Schema, model, types, models, type Model } from "mongoose";

export type OrderStatus = "pending" | "paid" | "cancelled" | "refunded";
export type OrderInventoryState = "reserved" | "consumed" | "released";
export type OrderCancelReason = "customer" | "admin" | "expired" | "payment_failed";

/**
 * How the customer pays. NO default: orders created before this field existed
 * (and orders from the current checkout, until checkout sets it) have no
 * payment method and are treated as "unknown", never as COD.
 * - "online": paid through the business's payment provider; becomes paid ONLY
 *   after server-side provider verification (not implemented yet).
 * - "cod": cash on delivery; the business confirms payment manually.
 */
export const ORDER_PAYMENT_METHODS = ["online", "cod"] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export const ORDER_FULFILLMENT_STATUSES = ["unfulfilled", "processing", "shipped", "delivered"] as const;
export type OrderFulfillmentStatus = (typeof ORDER_FULFILLMENT_STATUSES)[number];

export interface OrderItem {
  product: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  /** Purchased variant id and its label at purchase time (variant products only). */
  variant?: string;
  variantLabel?: string;
  sku?: string;
  /** The image shown when it was bought (the variant's own, if it has one). */
  imageUrl?: string;
}

export interface OrderDoc {
  _id: string;
  orderNumber: string;
  business: string;
  ownerToken: string;
  customerName: string;
  customerEmail: string;
  /**
   * The signed-in storefront customer account (models/Customer.ts) that placed
   * the order, set server-side from a verified session of THIS business. NO
   * default: guest and historical orders have no value and are never
   * back-filled.
   */
  customer?: string | null;
  items: OrderItem[];
  subtotal: number;
  total: number;
  status: OrderStatus;
  notes?: string;
  /**
   * Order-level currency. Derived from the (single-currency) line items at
   * creation so payment reconciliation has one authoritative value.
   */
  currency?: string;
  /**
   * Inventory lifecycle marker. New orders start as "reserved" because stock
   * is decremented at creation. Legacy orders have no value, which keeps them
   * out of automatic expiry/release sweeps.
   */
  inventoryState?: OrderInventoryState | null;
  /**
   * Coupon applied at checkout (snapshot). Absent = no discount. `total` is
   * subtotal - discountTotal + shippingTotal, computed only on the server.
   */
  discount?: { coupon: string; code: string; type: "percent" | "fixed"; value: number; amount: number } | null;
  discountTotal?: number;
  shippingTotal?: number;
  /** Delivery area the shipping charge came from, for the owner. */
  shippingZoneName?: string;
  /**
   * Tax at checkout. `taxInclusive` means it is already part of the prices and
   * `total`; otherwise `total` includes it on top. Absent = no tax configured.
   */
  taxTotal?: number;
  taxLabel?: string;
  taxInclusive?: boolean;
  /** Settled refunds, and refunds waiting on the provider (lib/payments/order-refunds.ts). */
  refundedTotal?: number;
  refundHoldTotal?: number;
  /** The owner's own note. Never shown to the shopper. */
  internalNote?: string;
  /** Delivery address when the store ships (validated server-side). */
  shippingAddress?: {
    name: string;
    line1: string;
    line2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
    phone: string;
  } | null;
  /** Fulfilment, separate from payment. Absent = unfulfilled (legacy). */
  fulfillmentStatus?: OrderFulfillmentStatus;
  trackingCarrier?: string;
  trackingNumber?: string;
  /** Owner-provided https tracking link (no carrier integration). */
  trackingUrl?: string;
  /** Each delivery update as it was made. Orders before this have only the dates below. */
  fulfillmentEvents?: Array<{ status: OrderFulfillmentStatus; at: Date; carrier?: string; number?: string }>;
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
  /** See ORDER_PAYMENT_METHODS. Absent/null = legacy (unknown). */
  paymentMethod?: OrderPaymentMethod | null;
  /** When an unpaid reservation becomes eligible for release. */
  reservationExpiresAt?: Date | null;
  paidAt?: Date | null;
  cancelledAt?: Date | null;
  refundedAt?: Date | null;
  inventoryReleasedAt?: Date | null;
  cancelReason?: OrderCancelReason | null;
  /**
   * SHA-256 hex digest of the guest ownership proof returned once at order
   * creation. Only the digest is persisted; the raw proof is never stored.
   * `select: false` keeps it out of default query results and API payloads.
   */
  orderProofHash?: string | null;
  /**
   * Keyed digests of a guest's phone and email, on guest cash-on-delivery orders only, for
   * limiting how many they have open (lib/orders/guest-cod.ts). `select: false`.
   */
  guestCodKeys?: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Generate a unique, collision-resistant order number. */
function generateOrderNumber(): string {
  // 12-char hex string from crypto random UUID v4, truncated for readability
  const uuid = require("crypto").randomUUID().replace(/-/g, "");
  return uuid.substring(0, 12);
}

const orderDiscountSchema = new Schema(
  {
    coupon: String,
    code: String,
    type: { type: String, enum: ["percent", "fixed"] },
    value: Number,
    amount: Number,
  },
  { _id: false },
);

const orderAddressSchema = new Schema(
  { name: String, line1: String, line2: String, city: String, region: String, postalCode: String, country: String, phone: String },
  { _id: false },
);

const orderSchema = new Schema<OrderDoc>(
  {
    orderNumber: {
      type: String,
      unique: true,
      default: generateOrderNumber,
      index: true,
    },
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    ownerToken: {
      type: String,
      required: true,
      index: true,
    },
    // No default and no automatic index (see OrderDoc.customer): an index for
    // customer order history is an approved operation (docs/customer-accounts.md).
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
    },
    idempotencyKey: {
      type: String,
      index: true,
    },
    // Returned once to the guest as a raw proof; only its digest is stored.
    orderProofHash: {
      type: String,
      default: null,
      select: false,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    customerEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    items: {
      type: [
        {
          product: { type: String, required: true },
          productName: { type: String, required: true },
          quantity: { type: Number, required: true, min: 1 },
          unitPrice: { type: Number, required: true, min: 0 },
          currency: { type: String, required: true, uppercase: true, trim: true },
          variant: { type: String },
          variantLabel: { type: String },
          sku: { type: String },
          imageUrl: { type: String },
        },
      ],
      default: [],
      _id: false,
    },
    subtotal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "refunded"],
      default: "pending",
      index: true,
    },
    currency: {
      type: String,
      default: "USD",
      uppercase: true,
      trim: true,
      maxlength: 3,
    },
    // No defaults for lifecycle fields: a missing inventoryState marks an
    // order as legacy and keeps it out of automatic release sweeps.
    inventoryState: {
      type: String,
      enum: ["reserved", "consumed", "released"],
      default: null,
    },
    reservationExpiresAt: { type: Date, default: null },
    // No default (see ORDER_PAYMENT_METHODS): absence means "unknown/legacy".
    paymentMethod: {
      type: String,
      enum: ORDER_PAYMENT_METHODS,
    },
    paidAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    inventoryReleasedAt: { type: Date, default: null },
    cancelReason: {
      type: String,
      enum: ["customer", "admin", "expired", "payment_failed"],
      default: null,
    },
    notes: { type: String, default: "", trim: true },
    // Sub-schemas (the discount has its own `type` field). No defaults:
    // absent on orders without a coupon / without shipping.
    discount: { type: orderDiscountSchema, default: undefined },
    discountTotal: { type: Number, min: 0 },
    shippingTotal: { type: Number, min: 0 },
    shippingZoneName: { type: String, trim: true, maxlength: 80 },
    taxTotal: { type: Number, min: 0 },
    taxLabel: { type: String, trim: true, maxlength: 40 },
    taxInclusive: { type: Boolean },
    refundedTotal: { type: Number, min: 0 },
    refundHoldTotal: { type: Number, min: 0 },
    internalNote: { type: String, trim: true, maxlength: 1000 },
    shippingAddress: { type: orderAddressSchema, default: undefined },
    // No defaults: absent = legacy/unfulfilled, never back-filled.
    fulfillmentStatus: { type: String, enum: ORDER_FULFILLMENT_STATUSES },
    trackingCarrier: { type: String, trim: true, maxlength: 80 },
    trackingNumber: { type: String, trim: true, maxlength: 120 },
    trackingUrl: { type: String, trim: true, maxlength: 500 },
    fulfillmentEvents: {
      type: [{ status: { type: String, enum: ORDER_FULFILLMENT_STATUSES }, at: Date, carrier: String, number: String, _id: false }],
      default: undefined,
    },
    shippedAt: { type: Date },
    deliveredAt: { type: Date },
    guestCodKeys: { type: [String], default: undefined, select: false },
  },
  { timestamps: true, versionKey: false }
);

// Index for fast lookups.
orderSchema.index({ business: 1, ownerToken: 1 });
orderSchema.index({ business: 1, orderNumber: 1 }, { unique: true });
// Idempotency keys are unique per business, but only when a key is actually
// present. A compound `sparse` index would still index keyless orders as
// (business, null) because `business` is always present, so a second keyless
// order in the same business would violate uniqueness. A partial index on
// string keys only indexes genuine idempotent requests.
orderSchema.index(
  { business: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    // Distinct name so databases that still have the old sparse index do not
    // hit an IndexOptionsConflict on startup. The old index must be dropped by
    // an operator (see PHASE_B2.2.5 report) for keyless orders to work there.
    name: "uniq_business_idempotencyKey_string",
  }
);

// Reuse the compiled model across dev hot reloads (matches the other models).
export const Order: Model<OrderDoc> =
  (models.Order as Model<OrderDoc>) || model<OrderDoc>("Order", orderSchema);