# Ecommerce and payments: current status

This describes what the code actually does today. Three levels are kept
separate on purpose: **local checkout** (works), **provider sandbox readiness**
(online payment through each business's own Razorpay account is implemented and
tested against a mocked Razorpay only; never run against Razorpay's real test
API) and **production payments** (not available: off by default, live mode
refused).

## Shopper flow (storefront host)

| Step | Where | Notes |
|---|---|---|
| Product page + add to cart | `app/store/product/[slug]`, `AddToCartButton` | Out-of-stock products cannot be added. |
| Cart | `app/store/cart`, `CartCheckout` | Quantity edit/remove, unavailable-item and price-change notices. |
| Checkout | `POST /api/businesses/[id]/orders` | Name + email, optional payment method. Server re-prices from the DB (coupon, delivery area, tax), reserves stock in a transaction, one idempotency key per attempt (double clicks/retries return the same order). |
| Pay online (optional) | `POST /api/storefront/orders/[orderId]/pay` → Razorpay hosted page → `GET /api/storefront/payments/razorpay/return` | Only when enabled and the store connected Razorpay; INR only. See `docs/payments-architecture.md`. |
| Confirmation / status / cancel | `app/store/order/[orderId]`, `OrderStatusView` | Access via the httpOnly `order-access` cookie; other browsers get the same 404 as a missing order. Pending online orders show **Pay now**. |
| Account order history / cancel | `app/store/account/orders`, `POST /api/storefront/account/orders/[orderId]/cancel` | Signed-in customers (flag on) see orders scoped by business AND customer and can cancel their own unpaid orders (stock restored once). |

Cart and order creation use `resolveCommerceBusiness`: the store must be
published **and** hold an active subscription (same rule as the public
storefront). Order status/cancel keep working after a store goes offline so a
customer can always release their reservation.

## Owner flow (dashboard)

`Orders` tab (owners and managers; staff excluded because orders contain
customer PII). API: `GET/PATCH /api/businesses/[id]/manage/orders[/orderId]`.

- **Mark paid** is allowed only for cash-on-delivery orders
  (`paymentMethod: "cod"`, via `confirmCodPayment`). Online orders are paid only
  after server-side Razorpay verification (automatic), and orders without a
  recorded payment method (guest and older orders) are refused with 409
  `manual_payment_not_allowed`. See `docs/payments-architecture.md`.
- Each order shows **Registered customer** or **Guest** (`placedBy`; the
  account id never leaves the server) and a **Cash on delivery** badge.
- An online payment Razorpay confirmed after the order could no longer be paid
  (reservation released / order cancelled) shows a red **refund or fulfil
  manually** notice (`paymentNeedsReview`).

### Uncollected cash-on-delivery orders (owner guidance)

COD orders hold their stock with no automatic expiry. When a delivery fails or
the customer refuses it: open **Orders**, filter **Awaiting payment**, find the
order (badge **Cash on delivery**, note "stock stays reserved until you mark it
paid or cancel it") and press **Cancel order**. Its items go back into stock
exactly once and the customer sees it as cancelled. Only press **Mark paid**
after the cash was actually received; a paid order can then only be marked
refunded (stock is not restored automatically). Customers can also cancel
their own unpaid orders from their account.

## Cash on delivery (Phase 4B)

- **Store setting:** `Business.codEnabled`, default `false`; existing stores
  read as off. Only the **owner** may change it (`PATCH /api/businesses/[id]`
  with `{ codEnabled }`; managers and staff get 403). Dashboard: Settings,
  **Payments** panel.
- **Who can use it:** a signed-in customer of THIS store with a confirmed
  email, while `CUSTOMER_ACCOUNTS_ENABLED` is on and the store enabled COD.
  Guests can choose COD only if the owner also turns on `Business.guestCodEnabled`
  (see "Guest cash on delivery" in `docs/commerce-operations.md`).
- **Checkout request:** optional `paymentMethod`: `"cod"` or `"online"`
  (online: see `docs/payments-architecture.md`); anything else is 400
  `invalid_payment_method`. Without it, checkout is the unchanged guest flow
  (no payment method recorded).
- **Server checks, in order:** flag on and store COD on (else 403
  `cod_unavailable`); same-origin JSON request (`assertSameOriginJsonRequest`:
  415 / 403 `csrf_failed`); a verified, active customer session of this store
  (else 401 `customer_sign_in_required` or 403 `customer_email_unverified`).
- **What is stored:** `paymentMethod: "cod"` and `customer` (the account id),
  set by the server on both creation paths (`claimIdempotentOrder` and
  `Order.create`). A retry with the same idempotency key returns the original
  order unchanged.
- **Reservation policy:** COD orders are created with
  `reservationExpiresAt: null`, so the 30-minute expiry sweep never cancels
  them. Stock stays reserved until the owner marks the order paid (stock
  consumed) or cancels it (stock restored once). To bound held stock, a
  customer may have at most `MAX_OPEN_COD_ORDERS_PER_CUSTOMER` (3) pending COD
  orders per store (409 `cod_limit_reached`). The count runs inside the order
  transaction after a write to the customer document, so parallel checkouts of
  one customer are serialised and cannot exceed the limit (tested).
- **Limits an owner can set:** a largest COD order, and which delivery areas
  offer it (Shipping page). Both are enforced in the order transaction
  (409 `cod_not_available_for_order`) and hidden at checkout.
- **Limitation:** an abandoned COD order holds its stock until the owner
  cancels it. There is no automatic COD expiry.

## Signed-in customers at checkout

- While customer accounts are on, a request carrying a customer session cookie
  must be same-origin JSON (sibling store subdomains are "same-site", so
  `SameSite` cookies alone do not stop cross-store form posts).
- A valid, verified, active session of THIS store ties the order to the account
  (`Order.customer`) for any payment choice, and the account's email replaces
  the typed one. An invalid, revoked, other-store, inactive or unconfirmed
  session is ignored for non-COD orders (plain guest order).
- Guest checkout, guest order proofs and cookies, and older orders (no
  `customer`, never back-filled) are unchanged.
- Customers see their own orders at `/account/orders`
  (`GET /api/storefront/account/orders`), scoped by the Host-resolved store AND
  the session's customer. Guest orders are not listed.
- **Cancel** restores stock once. Refunds are in `docs/payments-architecture.md`:
  through Razorpay for online orders, or recorded for money returned another way.

## Customers (owner dashboard)

`Customers` tab (owners and managers; staff excluded, same as Orders). API:
`GET /api/businesses/[id]/manage/customers[?q=&page=&limit=]` and
`GET /api/businesses/[id]/manage/customers/[customerId]`. Logic: `lib/customers.ts`.

- **Source of truth:** existing orders. No customer records are written;
  `models/Customer.ts` stays unused (no checkout change, no backfill).
- **Identity:** within one business, orders with the same `customerEmail`
  (ordinary whitespace trimmed, ASCII letters lower-cased) are one customer.
  Nothing else is merged (no Gmail dot/plus folding, no Unicode case folding,
  no name matching). Orders with a missing, non-string, over-long or malformed
  email (including control characters) are not grouped; the list shows how many
  exist (they remain visible under Orders).
- **Displayed name:** the name on the customer's most recent order.
- **Totals (per currency, never summed across currencies):** "paid" = orders
  with status `paid`; "awaiting payment" = `pending` (expired reservations are
  released first, as on the Orders list); `cancelled` and `refunded` count as
  orders but add nothing to either total.
- **Customer id:** the id of the customer's first order in that business
  (opaque, no personal data in URLs). Ids from another business, malformed ids
  and orders without a usable email all return the same 404.
- **Search:** case-insensitive, literal (regex-escaped) match on email or the
  displayed name; max 100 characters. Pagination: 1–50 per page.
- **Limits:** computed on each request from the business's orders (no new
  indexes, no caching), which is fine for pilot-sized shops but scans every
  order of the business; the detail view shows the newest 100 orders. Name
  search uses only the most recent name. Guest-only checkout means a customer
  who uses two emails appears twice.

## Stock reservations

Orders reserve stock for 30 minutes (`ORDER_RESERVATION_TTL_MS`). There is no
scheduler; expired reservations are released on demand (bounded, per business)
when a cart is written, an order is placed, or the owner opens the order list.
Products have a stock field in the dashboard; edits are compare-and-set
(`expectedStock`) so a concurrent order is never overwritten.

## Payments

- **Storefront orders:** cash on delivery (owner-confirmed), or online payment
  through the business's own Razorpay account via hosted Payment Links (off by
  default; `ORDER_ONLINE_PAYMENTS_ENABLED`, `PAYMENT_CREDENTIALS_KEY`; live keys
  refused unless `ORDER_PAYMENTS_LIVE_ALLOWED`). Tested only with a mocked
  Razorpay; no real payment has been made.
- **SaaS subscriptions:** `PAYMENT_PROVIDER=manual` (sandbox) activates plans
  server-side with no real payment. In production paid plans are refused unless
  `ALLOW_MANUAL_BILLING=true`. Any other provider value returns 501 from
  checkout — there is no provider integration.
- **Webhook** (`/api/webhooks/payments`): generic contract, HMAC-SHA256 of the
  raw body in `x-signature`, dedupe on `providerEventId` (unique index), single
  transaction, amount/currency must equal the plan. Unknown event types are
  acknowledged and ignored; `payment.failed` does not suspend free plans. It is off
  unless configured, never runs with `PAYMENT_PROVIDER=razorpay`, needs
  `LEGACY_PAYMENT_WEBHOOK_ENABLED=true` in production, and leaves Razorpay-billed
  subscriptions alone (`docs/subscription-billing-architecture.md`).

### Not production-ready — required before taking real money

1. Choose a provider and map its real event schema and signature scheme
   (most providers sign `timestamp.body`; add a replay window).
2. Event ordering: events are applied in arrival order. A late
   `payment.failed` can still mark a paid subscription `past_due`; this needs
   provider event timestamps / object versions to fix.
3. Order payments (Razorpay, implemented with mocks): verify end to end against
   Razorpay test mode (`docs/payments-architecture.md`, "Enabling it"), create
   the two documented indexes, set `PAYMENT_CREDENTIALS_KEY`. Order payments use
   `models/OrderPayment.ts`, not `Payment`.
4. Reconciliation reports and tax invoices. Order emails and provider refunds
   exist (`docs/commerce-operations.md`, `docs/payments-architecture.md`); both need
   an email provider or Razorpay test mode to be exercised for real.

## Compatibility / migration

No migration is required. New behaviour only reads existing fields. Notes:

- Page slugs `cart`, `checkout`, `order`, `orders` are now reserved. An existing
  page with slug `cart` or `order` is shadowed by the new storefront routes;
  rename it if one exists.
- Products created before this change via the dashboard have `stock: 0` and
  are not purchasable until the owner sets a stock amount.
- `Cart` documents have no TTL index; abandoned carts accumulate (reads no
  longer create them). Adding a TTL index would delete data and needs approval.
