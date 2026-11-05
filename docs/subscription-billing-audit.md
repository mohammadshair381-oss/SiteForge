# SaaS subscription billing: audit and provider requirements

Status (audited against the code): plans, subscriptions and server-side
entitlements exist and are enforced; **no real billing provider is
integrated**. Paid plans can only be activated through the manual/sandbox
switch, which is refused in production unless `ALLOW_MANUAL_BILLING=true`.
SiteForge has no real subscription revenue today; manual `Payment` records are
labelled "not real money" in the admin views.

This is separate from storefront order payments (each business's own Razorpay
account, `docs/payments-architecture.md`).

## What exists

| Area | Where | Behaviour |
|---|---|---|
| Plans | `models/Plan.ts`; admin `/admin/plans`, `api/admin/plans` | key, name, price, currency, `month`/`year`, `productLimit`, `staffLimit`, `customDomain`, `removeBranding`, `active`, `sort`. Create/update/activate/deactivate are super-admin only and audited. |
| Subscriptions | `models/Subscription.ts` | One current document per business (the newest by `createdAt` is authoritative): `plan`, `status` (`incomplete`/`trialing`/`active`/`past_due`/`canceled`), `provider`, `currentPeriodStart/End`. |
| Entitlements | `lib/billing.ts` `getEntitlements` | Active only for `active`/`trialing`; a paid plan also needs `currentPeriodEnd` in the future (free plans never expire). Read on every check, never cached. |
| Enforcement (server) | `assertCanAddProduct`, `assertCanAddStaff`, `assertCanPublish`, `assertCanAddCustomDomain`; storefront and commerce gates (`lib/tenant.ts`) | Limits and the "active subscription" requirement are enforced server-side; a lapsed plan takes the storefront and checkout offline. |
| Checkout | `POST /api/businesses/[id]/subscription` | Owner + verified email. Only `PAYMENT_PROVIDER=manual`; any other value returns 501. Paid plans additionally require `ALLOW_MANUAL_BILLING` in production. Writes a `succeeded` `Payment` with `provider: "manual"` for paid plans (sandbox record). |
| Webhook | `POST /api/webhooks/payments` | Generic contract: HMAC-SHA256 of the raw body (`x-signature`, `PAYMENT_WEBHOOK_SECRET`); `payment.succeeded` / `payment.failed`; dedupe on the unique `Payment.providerEventId`; one transaction; amount and currency must equal the plan; success activates and sets the period; failure marks paid plans `past_due`; unknown events are acknowledged. |
| Admin visibility | `/admin`, `/admin/payments`, `/admin/businesses/[id]` | Subscription status counts, manual vs provider-recorded money kept apart, past-due alert, "published without an active plan" alert. |

## Gaps

1. No provider: no hosted checkout session and no provider customer or
   subscription objects. (`Subscription.providerSubscriptionId`, with a unique
   partial index, and `cancelAtPeriodEnd` exist but nothing writes them yet.)
2. Renewal: nothing extends a period except a webhook. With no provider, paid
   access simply ends at `currentPeriodEnd`; there is no grace period, dunning,
   reminder email or scheduler.
3. Cancellation and plan changes: owners can cancel at period end and keep the
   plan again in manual mode (`POST /subscription { action }`), and a plan change
   warns when usage is above the new limit (limits only block NEW products/staff;
   existing ones stay). There is no proration, and a provider would have to carry
   out these changes itself.
4. Trials are a status only; nothing creates or ends a trial.
5. Refunds and disputes for subscriptions: `Payment.status = "refunded"`
   exists but nothing sets it; there is no subscription dispute tracking.
6. Event ordering: events apply in arrival order, so a late `payment.failed`
   can mark a paid subscription `past_due` (needs provider timestamps/versions).
7. The generic signature has no timestamp, so there is no replay window (most
   providers sign `timestamp.body`).
8. Price changes apply to existing subscribers immediately (the webhook checks
   the current plan price); there is no price versioning or grandfathering.
9. No invoices, receipts, tax/GST handling or reconciliation report.
10. Authorization: subscription GET and the billing page were readable by
    staff (fixed: both are now owner-only, tested in
    `tests/integration/subscription-api.test.ts` and
    `tests/integration/cross-feature.test.ts`).

## Requirements for a real provider integration

The provider-independent architecture, integration boundaries and the tested
lifecycle reducer are in `docs/subscription-billing-architecture.md` and
`lib/billing-lifecycle.ts`.

Decisions needed first (business, not code): which provider (for example
Razorpay Subscriptions for INR, or a global provider for USD); the legal
merchant entity; currencies and prices; tax/GST invoicing; refund policy;
grace period; whether trials are offered; and, for recurring card payments in
India, the provider's e-mandate requirements.

Then, for any provider:

- **Checkout**: server creates the provider checkout/subscription for the
  owner's business and plan (plan and amount from the database, never the
  client); the browser is redirected to the provider; the return URL is display
  only.
- **Verification**: activation only from a signed webhook (or a signed callback
  re-confirmed through the provider API), never from a client redirect, as the
  order-payment flow already does.
- **Data model**: add provider ids (`providerCustomerId`,
  `providerSubscriptionId`, provider plan/price id) to `Subscription`;
  version prices so existing subscribers keep theirs.
- **Lifecycle events**: activated, renewed (extend `currentPeriodEnd`),
  payment failed (`past_due` + grace period), cancelled (at period end or
  immediately), plan changed, refunded, disputed. Apply out-of-order events
  using the provider's event time or object version.
- **Idempotency**: keep the unique `providerEventId` and conditional updates;
  the provider's event id must be stored for every applied event.
- **Signature**: provider-specific scheme with a replay window; secrets in the
  secret manager only.
- **Entitlements**: keep `lib/billing.ts` as the single decision point; add the
  grace period there; never grant access from the client.
- **Downgrades**: define policy for usage above the new limit (block new items,
  read-only, or require cleanup before the change).
- **Refunds**: initiated in the provider, recorded from its webhook; never
  marked in SiteForge without provider confirmation.
- **Reconciliation and audit**: daily comparison of provider subscriptions
  vs local state, with mismatches surfaced to super admins; every manual
  correction through an audited admin action.
- **Testing**: provider test mode in staging with signed test webhooks;
  automated tests with a mocked provider (as for Razorpay order payments).

Until then: keep `PAYMENT_PROVIDER=manual`, keep `ALLOW_MANUAL_BILLING` off in
production, and do not describe subscriptions as paid.
