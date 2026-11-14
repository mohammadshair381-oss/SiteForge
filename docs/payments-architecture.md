# Storefront payments: architecture

Status: **online payment for storefront orders is implemented against
Razorpay's documented REST API and tested only against a mocked Razorpay**
(`tests/integration/order-online-payments.test.ts`,
`tests/unit/payments-razorpay.test.ts`). It has **not** been exercised against
Razorpay's real test-mode API, and it is **off by default**
(`ORDER_ONLINE_PAYMENTS_ENABLED`). No real transaction has been made.

Subscription billing (`api/webhooks/payments`, `backend/models/Payment.ts`) is a
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
  `confirmPaymentLink` (`backend/lib/payments/order-payments.ts`) after Razorpay
  confirms the payment. No route lets a person mark an online order paid.

## Per-business Razorpay accounts

Each business is paid into **its own** Razorpay account; SiteForge is never the
merchant and never holds funds.

`backend/models/BusinessPaymentAccount.ts` (one per business per provider):

- `business`, `provider: "razorpay"`, `mode: "test" | "live"`,
  `status: "active" | "disabled"`, `keyId`, `connectedAt`, `rotatedAt`.
- `keySecretEnc`, `webhookSecretEnc`: AES-256-GCM `{ v, iv, tag, ct }`,
  `select: false`, removed by `toJSON`, never in an API response, log or error.

Encryption (`backend/lib/payments/credentials-crypto.ts`):

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
  (`frontend/components/dashboard/OnlinePaymentAccount.tsx`, shown to owners only), which
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

`backend/models/OrderPayment.ts` records each link: `business`, `order`, `mode`,
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
  business's own key (`backend/lib/payments/disputes.ts`). The webhook payload's status
  is ignored; the API's state is stored.
- A dispute is stored only if its `payment_id` matches an `OrderPayment` of the
  SAME business, with the same currency and an amount not above the payment.
  Unknown payments, other businesses' payments and mismatches are not stored.
- `backend/models/PaymentDispute.ts` keeps status (`open` / `under_review` / `won` /
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

`backend/lib/payments/order-refunds.ts`, `backend/models/OrderRefund.ts`,
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

### Releasing a stuck refund (owner only)

A refund whose first answer was lost, and that Razorpay never gave an id, can stay in
progress for good if Razorpay never reports it. Then the owner, and only the owner,
can release its hold (`POST /api/businesses/[id]/manage/orders/[orderId]/refund/recover`,
`recoverStuckRefund` in `backend/lib/payments/order-refunds.ts`), after checking the payment in
Razorpay's own dashboard.

- **Who:** an owner with a verified email (`requireBusinessRole(id, ["owner"])`), from the
  same site, at most 20 times an hour per store.
- **Which refunds:** a Razorpay refund still in progress, with no Razorpay id, started at
  least 24 hours ago. One with an id is decided by Razorpay's answer alone ("Check with
  Razorpay", after reconnecting the account if needed), never by an owner. A settled,
  failed or already released refund is refused with a reason.
- **What the owner gives:** a reason (5 to 500 characters, plain text) and the statement
  `confirmedNotRefunded: true`, checked by the server, after a checkbox and a confirmation
  in the dashboard.
- **What happens:** in one transaction, the refund and order are read again. One
  conditional update, which needs the refund still waiting with no id and no earlier
  recovery, moves it to `failed` (`failureCode: owner_confirmed_not_refunded`), and writes
  the record of it. Then the order's hold goes down by its amount. So it happens once, however
  often it is asked, and a concurrent change answers `409 refund_changed`.
- **Never while a matching report waits for review:** the same transaction reads the order's
  `refundReviews`. If any unresolved entry has the same Razorpay payment and amount as this refund
  (`blockingRefundReview`; any amount match for a refund that never recorded its payment), the release is
  refused with `409 refund_review_pending` and an explanation, because that report may be this very refund.
  Nothing about the review is changed. A report added while the owner is confirming changes the order
  document, so the release's own write to it conflicts, the transaction runs again and sees it. That write is a
  conditional claim on the order's `updatedAt` as read, and always moves it strictly forward (automatic
  timestamps off for that write), so it is a real write even when the hold is already 0, and the release is
  refused unless it modified the order. The order page
  hides the release button and explains why (`recoveryBlockedByReview`, display only).
- **The record** (`OrderRefund.recovery`, written only by that update and never changed):
  who (`by`), when (`at`), why (`reason`), the previous and resulting status, and the
  order's held amount before and after. With the refund's own business, order, payment and
  idempotency key, that identifies everything involved. Owners and managers see all of it on
  the order: who released it (by name), when, the reason, in progress → hold released, and
  the amount held on the order before and after.
- **Nothing is sent to Razorpay,** and no refund is started. Nothing releases a hold by itself.

#### Three outcomes, never shown alike

A released refund keeps `status: "failed"`, so totals and older reports still count nothing
refunded for it. Every screen and notice decides by more than that status:

| Outcome | How it is told apart | What the owner and managers see |
|---|---|---|
| Razorpay confirmed the refund | `processed` | "Refunded", "Refund completed" |
| Razorpay reported it failed, or it was never sent | `failed` with no `recovery` | "Failed", "did not go through", and whether Razorpay refused it or no account was available |
| The owner released the hold of an unknown outcome | `failed` with `recovery` | "Hold released by owner", "Refund hold manually released by the owner. The owner confirmed that no refund was visible in Razorpay's dashboard at the time. Razorpay never reported a result." It is never called failed. |

The order history, the order's refund list and its notifications (`refundEvent`, also used by
the notification catch-up, both selecting `REFUND_EVENT_FIELDS`) follow this table.

#### When Razorpay answers after a release

Its answer can come from a check that was already running, or from a webhook. Neither can settle
the released record, whose hold is gone, and `recovery` is never changed. What Razorpay said is
written beside it (`lateProviderReport`), and the owner and managers are told.

**Which refund a webhook means** (`syncRefundFromProvider`), always after re-reading the refund from
Razorpay with this store's key:

1. **Razorpay's refund id.** A record holding it, or a released refund that an earlier report bound to it.
2. **Otherwise, our own requests it could be:** on the same order and payment, for the same amount, either
   still waiting (its answer was lost) or released with no report yet. Both kinds are counted together.
   - **Exactly one:** that one is used. For one still waiting, `applyRemoteRefund` reports what happened:
     `attached` (it took the id now), `already_attached` (it held this id), `claim_lost` (it changed meanwhile:
     another Razorpay refund or no longer waiting), `duplicate_conflict` (the unique index: another record already
     holds this Razorpay refund id, which is different from this record holding it), `mismatch`, or `late_report`
     (released meanwhile, handled as below). Only the first two count as success. `claim_lost` and
     `duplicate_conflict` record a review with that reason and answer `needs_review`; no refund record is created.
   - **More than one:** none is used, never the oldest, newest or first found. The report is kept on the order
     (`Order.refundReviews`: Razorpay's refund id, payment, amount, Razorpay's status, the reason, the refunds
     it could have been, first and last seen), and shown on the order as "Razorpay reports to review". These are
     marked "not failures": nothing was attached, recorded or released.
3. **None of ours:** a refund started in Razorpay's own dashboard, recorded as a refund of its own.
   - **Processed, but it does not fit the order** (more than the order has left to refund, or the order is no
     longer paid or refunded): it is NOT recorded, because a made-up record would only hide a possible double refund.
     Instead it is kept on the order as a review with the reason `does_not_fit_order` (Razorpay's refund id, payment,
     amount, status, no candidates, first and last seen), and the webhook answers `needs_review`. The order shows it as
     "Refunded in Razorpay, not recorded" with an explanation that the customer may have been refunded twice; it is
     never shown as a failed refund. Delivered again, the same entry is updated. If the order later has room for it,
     a later delivery records it normally and the entry is marked matched.
   - **Refused by the unique index, with no record of this store holding it** (the id is held outside this store):
     kept as a `duplicate_conflict` review the same way, never dropped. For a released refund the release is listed
     as its candidate.
   - Not processed yet: nothing moved, so nothing is kept; Razorpay's later "processed" event is handled as above.

**Review entries** (`recordRefundReview`, `resolveRefundReviewIfAttached`):
- One per Razorpay refund id. Nothing is recorded for a refund already attached to a record of the order, or held
  by any refund record of this store (so a `duplicate_conflict` inside the store, where the refund is attached,
  makes no entry); an open entry left from earlier is then closed by the same confirmed check.
- After writing, the attachment is checked again: if another delivery attached the refund meanwhile, the entry is
  closed. Receiving a report never closes one by itself.
- Reported again, the open entry is updated: status, reason and candidates replaced, `lastSeenAt` only moves
  forward (`$max`) and `firstSeenAt` only backward (`$min`), so a slow or older delivery never hides the latest
  observation. Two deliveries adding the same new entry: the one whose add finds it present updates it instead.
- Never removed to make room. Past 20 entries, only the oldest RESOLVED ones are removed. If every entry is
  unresolved, all are kept, the new one is added, and a warning is logged.
- Resolved only once a refund record of the order is confirmed to hold that Razorpay refund id (its
  `providerRefundId`, or a released refund's settled report bound to it), checked again right before the
  conditional write, which needs `resolvedAt: null`, so it happens once. The entry, its details and
  `resolvedAt` are kept. A resolved entry is never reopened: a later or older report for that id leaves it alone.

**One Razorpay refund per released refund.** The first report binds a released refund to that Razorpay refund
id (`writeLateReport`). A report for any other id never replaces it: it is kept on the order for review as
"already linked to a different Razorpay refund". For the same id, a newer state replaces the report, and the
report it replaces is kept in `lateProviderReportHistory` (the last 10). A report that says nothing new is not
written, so retries neither change nor announce anything. Only a report for that same id can resolve a "Needs
review".

- **Processed:** the money did go back. If it fits what is left on the order, it is recorded as
  its own refund pointing back to the released one (`confirmsRecoveryOf`). That new record, the
  order's hold and the released refund's report are written in ONE transaction, so none can be
  left without the others. If a record for that Razorpay refund already exists, the report is
  linked to it in the same way. A record whose report is missing anyway, from before this or for
  any other reason, gets it back the next time Razorpay reports the refund. The released refund then
  shows "Refunded after release", and the new one "Reported by Razorpay after the owner released an
  earlier hold", never "Started in Razorpay". The notice asks the owner to check that the customer was not
  refunded twice. This replaces an earlier "failed" report for the same Razorpay refund.
- **Failed:** Razorpay confirms what the owner found. A later "processed" for the same refund still replaces it.
- **Still processing, no matching payment, or more than the order has left:** nothing is
  decided, recorded or released. It is marked "Needs review" with the reason, logged, and the
  owner is told. A later final answer for the same Razorpay refund is handled the same way. Once
  one is recorded, it is final.

#### The remaining double-refund risk

The release rests on the owner's word. If Razorpay did make the refund and the owner refunds the
order again before Razorpay's answer arrives, the customer is refunded twice, and only the owner can
recover that money. SiteForge cannot rule this out without asking Razorpay for the payment's refunds,
which it does not do. What limits it:
- the release is allowed only a day after the refund started, and only when Razorpay never gave it an id;
- the owner must state what Razorpay's dashboard shows, and is warned of exactly this before confirming;
- the release is refused while an unresolved Razorpay report on the order has the same payment and amount;
- if Razorpay's answer comes, the refund is recorded as made, and the owner is told to check.
If that answer never comes, the refund stays recorded as not made.

**Matching by amount only.** When Razorpay's answer to our own request was lost, a report is matched to our
refunds by order, payment and amount alone (never by notes). Two refunds of the same amount on the same payment
cannot be told apart: such a report is never attached, and stays a review. One that Razorpay processed but that
does not fit the order is kept as `does_not_fit_order`. SiteForge offers no way to attach a review to a refund
by hand.

**Escalating an open review.** An owner who sees "Needs review" or "Refunded in Razorpay, not recorded" should look
the Razorpay refund id up in Razorpay's dashboard, check whether the customer was refunded twice, and contact
support with that id and the order. While a review with the same payment and amount is open, the matching refund's
hold cannot be released. Closing a review without a confirmed attachment needs a reviewed database change.

## Failed attempts and cancelled orders

A signed `payment.failed` event only notes the attempt on the open `OrderPayment`
(`lastFailureAt`, `lastFailureCode`): the owner sees it and the shopper is told to try
again. It never changes the order. It finds the order through `notes.siteforge_order`
on the link; that Razorpay copies a link's notes to its payments has **not** been
verified against the real API, and without it the attempt is simply not noted.

Cancelling an unpaid order closes its open links at Razorpay, best-effort. The
late-payment path above still catches a payment that gets through.
