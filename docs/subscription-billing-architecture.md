# SaaS subscription billing: provider-independent architecture

Status: **Razorpay Subscriptions is implemented, and has only ever run against a mocked
Razorpay.** No real test or live charge has been made. See "Razorpay Subscriptions" at
the end for what is implemented and what is not yet proven. Background:
`docs/subscription-billing-audit.md`.

## Principle

The provider is the source of truth for money; SiteForge is the source of
truth for access. Access changes ONLY from verified provider facts, through one
pure reducer, persisted with idempotent conditional writes. Entitlements are
always decided on the server by `backend/lib/billing.ts`.

## Components and boundaries

```
 Owner (browser)                 Provider                      SiteForge
 ───────────────                 ────────                      ─────────
 Choose plan ───────────────────────────────────────▶ (A) Checkout route
                                                        creates provider checkout
 Hosted checkout ◀─────────── redirect ─────────────────┘ (amount from DB plan)
 Return page (display only) ◀───────────────────────────
                                 Webhook ─────────────▶ (B) Webhook route
                                                        verify signature + window
                                                        (C) Adapter: re-read object,
                                                        map to NormalizedBillingEvent
                                                        (D) reduceSubscription (pure)
                                                        (E) Persist: event id unique,
                                                        conditional update, 1 txn
                                                        (F) backend/lib/billing.ts decides access
 Cancel / change plan ─────────────────────────────────▶ (G) Owner actions call the
                                                        provider; state still changes
                                                        only via (B)–(E)
                                                        (H) Reconciliation job
```

| # | Boundary | Exists today | Provider adapter must supply |
|---|---|---|---|
| A | `POST /api/businesses/[id]/subscription` (owner, verified email) | Manual mode only; other providers → 501 | `createCheckout({ businessId, planKey, returnUrl })` → hosted URL. Amount and currency from the `Plan` document, never the client. |
| B | Webhook route | `api/webhooks/payments` (generic HMAC, no timestamp; see "Legacy webhook") | Provider signature scheme with a replay window. `verifyTimestampedSignature` (`backend/lib/billing-lifecycle.ts`) implements the generic `timestamp.body` form (default ±300 s). |
| C | Adapter mapping | — | `toNormalizedEvent(providerEvent)` → `NormalizedBillingEvent` (event id, type, provider `occurredAt`, provider subscription id, plan key from the provider price id, period, amount, currency). Re-read the subscription/invoice from the provider API where supported. |
| D | Lifecycle reducer | `reduceSubscription` (pure, unit-tested; not wired) | Nothing: provider-independent. |
| E | Persistence | `Payment.providerEventId` unique index; transactions | Store `providerSubscriptionId` (field and unique partial index already exist on `Subscription`, unused today), `cancelAtPeriodEnd` (exists, unused), plus new `graceUntil` and `lastEventAt` fields. |
| F | Entitlements | `getEntitlements` (active/trialing + period end) | Add the grace period for `past_due` (`grantsAccess` in `backend/lib/billing-lifecycle.ts` shows the rule). |
| G | Owner actions | — | `cancelAtPeriodEnd(subId)`, `resume(subId)`, `changePlan(subId, planKey, proration)`, `refund(paymentId, amount)` calls. Their effect is applied only when the provider's webhook arrives. |
| H | Reconciliation | — | `listSubscriptions(updatedSince)` for a daily comparison job. |

## Lifecycle rules (implemented in `reduceSubscription`)

| Event | Effect |
|---|---|
| `subscription.activated` / `subscription.renewed` | Requires a known plan, `amount == plan price`, same currency, and a valid period; sets `active` and the period, clears grace. Otherwise rejected (state unchanged). |
| `payment.failed` | `past_due` with a grace period (default 3 days); ignored when already `canceled`. |
| `subscription.cancel_scheduled` | `cancelAtPeriodEnd = true`; access continues to period end. |
| `subscription.canceled` | `canceled`; access ends. |
| `subscription.plan_changed` | New plan key (must be known). Limits follow the new plan immediately. |
| `payment.refunded` | No access change on its own; whether a refund also cancels is a business policy expressed as a separate `canceled` event. |
| Any event older than the newest applied one | Ignored (`out_of_order`), so a late failure cannot undo a renewal. |
| A repeated event id | Ignored (`duplicate`); the unique index is the authoritative guard. |
| An event for another subscription id | Rejected. |

Out of scope for the reducer (decisions needed): proration amounts, trials,
downgrade below current usage (block new items vs read-only), tax/GST.

## Payment records and refunds

- A `Payment` is written only from a verified provider fact (event id
  unique), never from the checkout return page or an admin action.
- Refunds are initiated in the provider (or through G) and recorded from the
  provider's webhook; the admin views stay read-only.
- Disputes for subscriptions follow the order-dispute pattern
  (`backend/lib/payments/disputes.ts`): signed webhook → API re-read → append-only
  history.

## Reconciliation and audit

- Daily job (H): for every business with a provider subscription, compare the
  provider's status/period/plan with the local state; record mismatches for
  super admins (do not auto-correct paid access upward).
- Every manual correction is an audited super-admin action
  (`runAuditedAdminAction`), never a direct database edit.

## Tests required when a provider is chosen

- Adapter mapping fixtures for every event type (recorded test-mode payloads).
- Signature tests including replay (outside window) and body tampering.
- Webhook route: duplicate deliveries, concurrent deliveries, out-of-order
  events, wrong amount/currency, unknown subscription.
- Entitlement checks at each lifecycle state (including grace).
- No network in automated tests (mocked provider), as for Razorpay.

## Razorpay Subscriptions

`backend/lib/billing-razorpay.ts`, `backend/lib/payments/razorpay.ts`, `app/api/webhooks/razorpay-billing`,
`app/api/businesses/[id]/subscription`, `app/api/admin/plans/razorpay`.

Platform billing uses SiteForge's own Razorpay account (`RAZORPAY_BILLING_*`). It shares
no keys, webhook or records with store checkout, which uses each store's own account
through `BusinessPaymentAccount` and `OrderPayment`. Subscription payments are `Payment`
records with `paymentDomain: "subscription"`.

### Flow

1. **Plans.** A Super Admin presses "Set up at Razorpay" on a paid plan: `POST /plans`
   (`period`, `interval`, `item`) with the plan's current price. Razorpay plans have a fixed
   price, so a price change needs this again; subscribers stay on what they agreed to.
2. **Checkout.** The owner picks a plan: `POST /subscriptions` (`plan_id`, `total_count`,
   `customer_notify`, `expire_by`, `notes`), then a redirect to Razorpay's `short_url`. The
   CSP does not change. The current plan is untouched until payment is confirmed.
3. **Webhook.** `POST /api/webhooks/razorpay-billing`: HMAC-SHA256 of the raw body in
   `X-Razorpay-Signature`; duplicates by `x-razorpay-event-id`. The event only prompts a re-read
   of `GET /subscriptions/:id` and `GET /payments/:id`, so delivery order does not matter,
   which matters because Razorpay does not guarantee it.
4. **State.** The re-read status becomes a normalized event for `reduceSubscription`, saved
   with the event id and payment in one transaction.

| Razorpay status | SiteForge |
|---|---|
| `created`, `authenticated` | Nothing changes; no charge has been made |
| `active` | `active`, with the plan Razorpay names, the period and the agreed price checked. An unknown plan id or wrong amount changes nothing |
| `pending`, `halted`, `paused` | `past_due`. Paid features continue for `BILLING_GRACE_DAYS` from the first failure, then stop |
| `cancelled`, `completed` | `canceled`, or the free plan the owner chose (see below). Paid access ends |
| `expired`, or cancelled with nothing paid | The payment page is dropped; the current plan is untouched |

Retries are Razorpay's own while `pending`. After a failure the billing page offers the
oldest unpaid invoice's hosted page, and Razorpay emails the customer. A store whose period
has ended keeps access for 24 hours while the renewal is reported.

Owner actions: choose a plan, cancel at period end (`cancel_at_cycle_end`), change plan at the
cycle end (`PATCH` with `schedule_change_at: "cycle_end"`), refresh status, cancel an unfinished
payment, view invoices (`GET /invoices?subscription_id=`, read live, never stored).

**Legacy webhook.** `POST /api/webhooks/payments` is the older generic contract. It has no provider API to re-read, so it
can only believe its signed payload, which is not how Razorpay billing works. So it answers `400 not_configured`, before reading
the body, unless `PAYMENT_WEBHOOK_SECRET` is set, and always with `PAYMENT_PROVIDER=razorpay`; in production it also
needs `LEGACY_PAYMENT_WEBHOOK_ENABLED=true`. When it does run, a subscription with `provider: "razorpay"`, a
`providerSubscriptionId` or a Razorpay payment page waiting is left alone, for success and failure events alike:
the event is acknowledged (`ignored: true`) and nothing is written. That is read inside the transaction. Its signature check and
`providerEventId` dedupe are unchanged. Keep its secret empty unless an integration really needs it.

**A pending plan and a cancellation.** A cancellation can never turn into a free or permanent paid plan.
`pendingPlan` is applied on `cancelled` or `completed` only if that plan's price, read inside the same transaction,
is 0. Anything else is dropped, and the store stays on the plan and period it paid for, as `canceled`, which grants no
access. A plan with no period end never expires (`isEntitlingSubscription`), which is why a paid plan is never
applied here. Cancelling also clears a paid plan change that was waiting, and a new payment page that gets
activated clears any older one. Once a store has moved to a free plan, its record no longer names the Razorpay
subscription, so a repeated or later event for it finds nothing to change. Webhooks are once-only through
`billingevents`; reconciliation reads carry no event id and are safe to repeat, since they set the same values.

Not verified against the real API: what Razorpay does with a scheduled plan change when the same subscription is
then cancelled at the cycle end. SiteForge reads the outcome and grants nothing either way, but the stored plan and the
plan Razorpay names could differ until then.

### Reconciliation

`reconcileBusinessSubscription` re-reads a store's subscription from Razorpay through the same
`syncProviderSubscription` a webhook uses, so it can only bring a store in line with what Razorpay
reports. It runs from an owner's "Refresh status", from an audited Super Admin action
(`POST /api/admin/billing/reconcile`), and from a scheduler (`POST /api/cron/billing-reconcile`, off
until `BILLING_RECONCILE_SECRET` is set; the least recently checked stores first, at most 50 a run,
none checked again within 6 hours; see `docs/scheduled-jobs.md`). Runs cannot overlap, and each one's outcome
is recorded. The read time is taken before the request, so a slow read older
than something already applied is refused by the reducer and leaves the stored fields alone.
`lastReconciledAt`, `lastReconcileOutcome` and `lastReconcileError` (a code only) record each run.
A browser redirect never does any of this.

### Refunds and disputes on subscription payments

The billing webhook also takes `refund.*` and `payment.dispute.*`. Each is re-read from the API and
recorded in `BillingAdjustment` only against a `Payment` already known as a subscription payment, so
a store-order refund cannot land here (those use a store's own account and `backend/lib/payments/order-refunds.ts`).
`Payment.refundedAmount` is worked out from the processed refunds, so a repeated event cannot count
twice. Neither ever changes a store's access: that stays a separate decision. Open refunds and disputes
are re-read during reconciliation. Whether Razorpay sends these events to a subscriptions webhook
has to be confirmed when the webhook is configured.

### Invoices

Invoices are read live from Razorpay and are its billing records. SiteForge does not issue GST tax
invoices or add tax details to them, and the billing page says so.

### Not verified against the real API

Every item below comes from Razorpay's documentation or is an assumption, and needs a run
in test mode before relying on it:

- The whole flow: no real test-mode subscription has ever been created.
- `GET /invoices?subscription_id=`: the subscriptions documentation lists this endpoint
  incorrectly, and the path comes from Razorpay's general Invoices API.
- Whether an invoice's `short_url` can really be used to pay after a failure. Razorpay documents
  that the customer can retry or change card, but not this link.
- Whether `x-razorpay-event-id` is always present on subscription events. A hash of the signed
  body is used if not.
- Which payment methods support what. Razorpay documents that eMandate subscriptions cannot be
  updated, and does not say the same or otherwise for UPI AutoPay; a refused change reports an error
  and asks the owner to cancel and subscribe again.
- `total_count` limits: SiteForge uses 60 monthly or 10 yearly cycles. A store reaching the end
  has to subscribe again.

### Not implemented

- Undoing a scheduled cancellation: Razorpay documents cancelling pending updates, not this. The
  page says so, rather than offering a button that may not work.
- Proration, trials, coupons on subscriptions, GST invoices issued by SiteForge.
- Starting a refund, or answering a dispute, from SiteForge: both are done in Razorpay's dashboard.
- A scheduler. `POST /api/cron/billing-reconcile` is ready for one, and none is set up.
- Keeping a webhook secret during rotation: Razorpay signs retried older events with the old secret,
  so those are refused after a change and need "Refresh status".

