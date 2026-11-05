# Storefront payments: architecture

Status: **online payment for storefront orders is implemented against
Razorpay's documented REST API and tested only against a mocked Razorpay**
(`tests/integration/order-online-payments.test.ts`,
`tests/unit/payments-razorpay.test.ts`). It has **not** been exercised against
Razorpay's real test-mode API, and it is **off by default**
(`ORDER_ONLINE_PAYMENTS_ENABLED`). No real transaction has been made.

Subscription billing (`api/webhooks/payments`, `models/Payment.ts`) is a
separate system and is unchanged; order payments never touch `Payment`.

## Payment method on orders

- `Order.paymentMethod`: `"online"` | `"cod"`, **no default**. Orders without it
  (older orders, and guest checkouts that pick "arrange payment with the
  store") are "unknown" and are never treated as COD or as paid online.
- Checkout sets the method server-side only, on both order-creation paths:
  `"cod"` for eligible signed-in customers of stores that enabled it (Phase 4B),
  `"online"` when the shopper picks "Pay online" and the store has a usable
  Razorpay account (below).
- Business users can mark an order paid only through `confirmCodPayment`
  (COD orders only). `markOrderPaid` is called **only** by
  `confirmPaymentLink` (`lib/payments/order-payments.ts`) after Razorpay
  confirms the payment. No route lets a person mark an online order paid.

## Per-business Razorpay accounts

Each business is paid into **its own** Razorpay account; SiteForge is never the
merchant and never holds funds.

`models/BusinessPaymentAccount.ts` (one per business per provider):

- `business`, `provider: "razorpay"`, `mode: "test" | "live"`,
  `status: "active" | "disabled"`, `keyId`, `connectedAt`, `rotatedAt`.
- `keySecretEnc`, `webhookSecretEnc`: AES-256-GCM `{ v, iv, tag, ct }`,
  `select: false`, removed by `toJSON`, never in an API response, log or error.

Encryption (`lib/payments/credentials-crypto.ts`):

- Random 96-bit IV per value; key from `PAYMENT_CREDENTIALS_KEY` (32 random
  bytes, base64), deliberately not derived from `SESSION_SECRET`.
- Values carry key version `v` (only `1` exists). Rotation procedure when
  needed: add version 2 support, decrypt with the recorded version, re-encrypt
  with the current one.
- A missing/invalid key fails closed: online payment is hidden from shoppers
  and connecting returns `503 payment_encryption_unconfigured`.

Account API (`app/api/businesses/[id]/payment-account`): `GET` / `PUT`
(connect or replace) / `DELETE` (disconnect: status `disabled`, encrypted
secrets removed).

- **Owner only** (`requireBusinessRole(id, ["owner"])`); `PUT` also needs a
  verified email, same-origin JSON, and is rate limited (10/hour/business).
- `PUT` requires `ORDER_ONLINE_PAYMENTS_ENABLED=true` (409 otherwise) and a key
  id whose prefix matches the mode (`rzp_test_…` / `rzp_live_…`, 422).
- **Test vs live**: live keys are refused (`403 live_payments_disabled`) unless
  `ORDER_PAYMENTS_LIVE_ALLOWED=true`; an existing live account is also ignored
  at checkout while that flag is off.
- Responses contain at most `{ provider, mode, keyId, connectedAt, rotatedAt }`
  plus the platform flags.
- Dashboard: **Settings → Online payments (Razorpay)**
  (`components/dashboard/OnlinePaymentAccount.tsx`, shown to owners only), which
  also shows the business's webhook URL.

Not implemented from the original design: an audit-log entry when credentials
change, a credential test call at connect time, `lastVerifiedAt`.

## Flow (hosted Payment Links)

Razorpay **Payment Links** (a redirect to Razorpay's hosted page) are used
instead of the in-page Checkout script, so the storefront Content Security
Policy never has to allow Razorpay scripts or frames.

1. **Checkout** (`POST /api/businesses/[id]/orders`, `paymentMethod: "online"`):
   same-origin JSON only; the store must have a usable account; the order must be
   in **INR** with an exact number of paise (`400 currency_not_supported` /
   `invalid_amount`, stock untouched). The order is created `pending` with the
   normal 30-minute reservation. Checkout never calls Razorpay.
2. **Start payment** (`POST /api/storefront/orders/[orderId]/pay`): business from
   the Host only; ownership proven with the order proof (`x-order-proof` or the
   HttpOnly `order-access` cookie), exactly like the order status API;
   same-origin JSON; rate limited. The server creates the Payment Link with the
   business's key: `amount` from the stored order total (never from the client),
   `reference_id` = order id, `accept_partial: false`, Razorpay notifications
   off, `expire_by` = 60 s before the reservation ends (refused if less than
   16 minutes remain: `409 payment_window_closed`). One open link per order is
   reused. The response URL is accepted only if it is HTTPS on `rzp.io` /
   `razorpay.com`. Starting a payment never changes the order.
3. **Return** (`GET /api/storefront/payments/razorpay/return`): Razorpay
   redirects here with `razorpay_payment_link_id`, `…_reference_id`, `…_status`,
   `razorpay_payment_id`, `razorpay_signature`. The handler requires the link to
   belong to this Host's business and to the referenced order, verifies
   `HMAC-SHA256(link_id|reference_id|status|payment_id, key_secret)`, and then
   **still** calls `confirmPaymentLink`. It always redirects to
   `/order/[id]?payment=success|pending|failed|review`; `payment=` is a display
   hint only, the page shows the server's order status.
4. **Webhook** (`POST /api/webhooks/razorpay/[businessId]`): one URL per
   business, configured in that business's Razorpay dashboard with events
   `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`,
   `payment.failed`, `refund.created`, `refund.processed`, `refund.failed`. The path
   id only selects which secret to check; the HMAC-SHA256 of the exact raw body
   (`X-Razorpay-Signature`) must match (401 otherwise, identical for unknown
   businesses). Body limit 64 KiB. Other events return 200 and do nothing.
   A provider error returns 502 so Razorpay retries.
5. **Confirmation** (`confirmPaymentLink`): looks the link up **scoped to the
   business**, re-reads it from the Razorpay API with that business's key, and
   applies it only if the link id, `reference_id` (order id), `amount`,
   `currency` match the recorded `OrderPayment` and `status === "paid"` with
   `amount_paid === amount`. It then marks the `OrderPayment` paid (conditional
   update) and calls `markOrderPaid` (conditional on a live reservation).

Idempotency: every write is conditional, so duplicate webhooks, a webhook racing
the return redirect, and replays converge on one paid order, one consumed stock
reservation and one paid `OrderPayment` (tested with concurrent deliveries).
`x-razorpay-event-id` is recorded as `lastEventId` but is not needed for
correctness.

`models/OrderPayment.ts` records each link: `business`, `order`, `mode`,
`providerLinkId`, `shortUrl`, `providerPaymentId`, `amountMinor`, `currency`,
`status` (`created` | `paid` | `failed` | `cancelled`), `orderOutcome`
(`applied` | `needs_review`), `outcomeReason`.

### Late payments

If Razorpay confirms a payment after the order's reservation was released (or
the order was cancelled meanwhile), the order is **not** resurrected:
`OrderPayment.orderOutcome = "needs_review"`, and the owner's order list shows a
red notice to refund the customer in Razorpay or fulfil manually. The link's
`expire_by` (60 s before the reservation ends) makes this rare but not
impossible (webhook delays; a shopper cancelling and then paying an open link —
links are not cancelled at Razorpay when an order is cancelled).

## Database prerequisites (approved operation)

`BusinessPaymentAccount` and `OrderPayment` have `autoIndex` and `autoCreate`
**off**. Before setting `ORDER_ONLINE_PAYMENTS_ENABLED=true` on a persistent
database, an operator creates (mongosh, against the confirmed target):

```js
db.businesspaymentaccounts.createIndex({ business: 1, provider: 1 }, { unique: true });
db.orderpayments.createIndex({ providerLinkId: 1 }, { unique: true });
db.orderpayments.createIndex({ business: 1, order: 1 });
db.paymentdisputes.createIndex({ providerDisputeId: 1 }, { unique: true });
db.paymentdisputes.createIndex({ business: 1, createdAt: -1 });
db.orderrefunds.createIndex({ business: 1, order: 1, createdAt: -1 });
db.orderrefunds.createIndex({ providerRefundId: 1 }, { unique: true, partialFilterExpression: { providerRefundId: { $type: "string" } } });
```

The integration tests create these indexes explicitly in the in-memory replica
set.

**The unique `orderrefunds` index is required, and checked.** Without it, starting a
Razorpay refund answers `503 feature_not_ready` before anything is held or sent, and a
webhook for a refund started in Razorpay's dashboard answers 503 so that it is delivered
again. Concurrent deliveries are also serialised: the record is looked for again inside
a transaction that writes the order, so the later one is retried and finds the first
one's record. One provider refund is one record, settled once, and SiteForge never
starts a second refund at Razorpay from a webhook.

## Enabling it (staging first)

1. Create the indexes above.
2. Set `PAYMENT_CREDENTIALS_KEY` (32 random bytes, base64; store it in the
   secret manager; back it up — losing it means every owner must reconnect).
3. Set `ORDER_ONLINE_PAYMENTS_ENABLED=true`; keep
   `ORDER_PAYMENTS_LIVE_ALLOWED=false`.
4. As a store owner, create Razorpay **test-mode** API keys and a webhook (URL
   shown in Settings, the events listed there, a new secret), and connect them in
   Settings.
5. Place an INR order with "Pay online", pay with Razorpay test credentials,
   and confirm: the order becomes paid via the return redirect, the webhook is
   delivered (Razorpay dashboard), a duplicate delivery changes nothing, and an
   unpaid link expires. Then decline a test card, make a partial refund and a full
   refund from the Orders page, and start one from Razorpay's dashboard.
6. Only after that, and with an explicit business decision, consider
   `ORDER_PAYMENTS_LIVE_ALLOWED=true` with live keys.

## Disputes

Implemented against Razorpay's documented dispute API and webhooks; tested only
with a mocked Razorpay (`tests/integration/payment-disputes.test.ts`). **No
live dispute synchronisation has been exercised.**

- Add these events to each business's Razorpay webhook:
  `payment.dispute.created`, `payment.dispute.under_review`,
  `payment.dispute.action_required`, `payment.dispute.won`,
  `payment.dispute.lost`, `payment.dispute.closed`.
- The signed webhook only triggers a re-read: `GET /v1/disputes/{id}` with the
  business's own key (`lib/payments/disputes.ts`). The webhook payload's status
  is ignored; the API's state is stored.
- A dispute is stored only if its `payment_id` matches an `OrderPayment` of the
  SAME business, with the same currency and an amount not above the payment.
  Unknown payments, other businesses' payments and mismatches are not stored.
- `models/PaymentDispute.ts` keeps status (`open` / `under_review` / `won` /
  `lost` / `closed`), phase, reason code, amounts (disputed, deducted),
  respond-by, opened/closed dates, and an append-only `history` (each
  provider-observed transition once; duplicate and concurrent deliveries are
  idempotent).
- Super admins can add internal notes (`POST /api/admin/disputes/[id]/notes`,
  audited as `dispute.note`); notes never change status. Disputes are visible on
  `/admin/payments?domain=dispute`, `/admin/disputes/[id]`, the admin overview
  alert, the owner's order list (badge with respond-by date) and owner Insights.
- A dispute never changes the order or payment and never records a refund. The
  business responds and submits evidence in Razorpay.
- Subscription billing has no provider, so it has no disputes.

## Refunds

Implemented against Razorpay's documented refund API and tested only with a mocked
Razorpay. **No real refund has been made.**

`lib/payments/order-refunds.ts`, `models/OrderRefund.ts`,
`POST /api/businesses/[id]/manage/orders/[orderId]/refund`:

- **Through Razorpay** is owner-only, with a verified email and same-origin JSON. It
  uses the account of the same mode as the payment, so test and live never mix. A
  live refund also needs `ORDER_PAYMENTS_LIVE_ALLOWED`.
- **Recorded** (`manual`) is for owners and managers when money was returned another
  way, such as for cash on delivery. No money moves.
- The amount comes from the request but is checked on the server against what is
  left. It is reserved on the order in a transaction first (`refundHoldTotal`), so
  concurrent requests cannot refund more than was paid.
- Money counts as refunded (`refundedTotal`) only when Razorpay says `processed`:
  from its response, or a signed `refund.*` webhook that triggers a re-read
  (`GET /refunds/{id}`). Every settlement is conditional, so repeats apply once.
- A hold is given back only when something proves nothing was refunded: Razorpay reports
  the refund `failed`, or it definitely refuses the very first request (a 4xx other than
  408, 409, 425 or 429), or no account exists to send that first request with.
- Every other outcome is unknown, and keeps the hold, with the refund shown as in
  progress: a timeout, a 5xx, a lost response, or anything that goes wrong when checking
  again. That includes a refusal of a repeat, and a disconnected account, because the
  first request may have worked. Checking again re-sends with the same
  `X-Refund-Idempotency` key, and a later `refund.*` webhook settles it too.
- A refund started in Razorpay's dashboard is recorded from its webhook if its payment
  belongs to this same business and the amount fits what is left. Otherwise it is
  logged and the order is left alone.
- A refund of the whole remainder closes the order as `refunded` and can return its
  items to stock once. The order's coupon use is kept.

## Failed attempts and cancelled orders

A signed `payment.failed` event only notes the attempt on the open `OrderPayment`
(`lastFailureAt`, `lastFailureCode`): the owner sees it and the shopper is told to try
again. It never changes the order. It finds the order through `notes.siteforge_order`
on the link; that Razorpay copies a link's notes to its payments has **not** been
verified against the real API, and without it the attempt is simply not noted.

Cancelling an unpaid order closes its open links at Razorpay, best-effort. The
late-payment path above still catches a payment that gets through.
