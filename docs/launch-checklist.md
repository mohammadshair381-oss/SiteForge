# Launch checklist

Use this before you call any environment "ready". Passing one stage never
implies the next. Detailed procedures live in the linked documents; this page
says what must be true and where to check it.

Legend: **Verified** = exercised by this repository's automated tests or by a
real headless-browser run against an isolated in-memory database. **Mocked** =
verified only against a fake provider. **Not verified** = nothing here has
exercised it.

## 1. Code changes completed

| Area | Status | Reference |
|---|---|---|
| Storefront, cart, guest checkout, 9 themes | Done | `docs/ecommerce-payments-status.md` |
| Commerce homepage, header/footer, product discovery, owner Storefront settings (draft, preview, publish), sale prices | Done | `docs/storefront-commerce.md` |
| Product variants, inventory history/adjustments/low stock, managed categories, coupons, verified reviews, shipping charges and fulfilment tracking, product/category SEO | Done | `docs/commerce-operations.md` |
| Customer accounts, COD, order history, self-cancel | Done (flag off by default) | `docs/customer-accounts.md` |
| Online order payments (Razorpay Payment Links) | Done (flag off by default) | `docs/payments-architecture.md` |
| Payment disputes (Razorpay) | Done | `docs/payments-architecture.md`, "Disputes" |
| Super Admin control center, user management, audit log | Done | `docs/admin-control-center.md` |
| Security monitoring (platform + storefront sign-ins, password resets, revoked customer sessions) | Done | `docs/security-monitoring.md` |
| Owner insights | Done | `backend/lib/business-insights.ts` |
| Billing visible to the owner only (API + page) | Done | `app/api/businesses/[id]/subscription` |
| Favicon (platform and stores) | Done | `app/icon.svg`, `app/favicon.ico` |
| AI provider safety (M0: kill switch off, header key, origin, verified email, limits, error hygiene) | Done | `docs/ai-website-builder-plan.md` |
| Website change proposals (M1: review, preview, draft-only apply, history) without external AI | Done | `docs/ai-website-builder-plan.md` |
| AI generation of content (M2+) | **Not built** | `docs/ai-website-builder-plan.md` |
| SaaS billing: provider-independent lifecycle reducer + replay-protected signature helper | Done (not wired) | `docs/subscription-billing-architecture.md` |
| SaaS billing with a real provider | **Not built** | `docs/subscription-billing-audit.md` |
| Order emails (confirmation, shipping) | **Not built** | — |
| Custom-domain routing (A/CNAME, TLS) | **Not built** | `docs/domain-lifecycle-migration.md` |

## 2. Verified locally

| Item | How |
|---|---|
| Typecheck, lint, production build | `npm run typecheck`, `npm run lint`, `npm run build` (build run in an isolated copy without `.env` files) |
| Unit and integration tests | `npm run test:unit`, `npm run test:integration` (in-memory replica set; never reads `.env*`; no network) |
| Shopper journey, all themes at 375/768/1280 px | Headless Chrome: browse, search, filter, sort, cart, guest checkout and cancel, sign-in, COD, history, self-cancel |
| Owner dashboard, insights, orders, settings, billing (owner-only) | Headless Chrome at 375 and 1280 px |
| Admin pages, user actions (forced sign-out, password step-up), dispute notes, security page | Headless Chrome |
| Favicon served on platform and store hosts | Headless Chrome |
| Cross-feature: role separation, lapsed plan vs captured payment, payment/cancel/expiry races, insights vs admin totals | `tests/integration/cross-feature.test.ts` |

Not verified locally: other browsers, real phones, screen readers, HTTPS and
production (`__Host-`) cookies, real subdomains.

## 3. Mocked integrations (never exercised against the real service)

| Integration | Mock |
|---|---|
| Razorpay order payments and webhooks | Fake Razorpay API (`order-online-payments.test.ts`) |
| Razorpay disputes | Fake dispute API (`payment-disputes.test.ts`) |
| Email delivery (Resend) | Mocked `fetch`, in-memory outbox |
| AI provider (Gemini) | Mocked `fetch`; provider paused |
| SaaS billing webhook | Generic signed contract only; no provider |

## 4. Operations requiring approval (persistent database)

- Create the commerce indexes listed in `docs/commerce-operations.md`
  ("Database operations") for `inventorymovements`, `coupons`,
  `couponredemptions`, `productcategories`, `productreviews`.

Run the read-only preflight first (`docs/customer-accounts.md`, Part A). Get
explicit approval before every write. Nothing here has been performed.

| Operation | Reference |
|---|---|
| Customer and customer-token indexes | `docs/customer-accounts.md`, Part B |
| Customer order-history index | `docs/customer-accounts.md`, "Known limitations" |
| `businesspaymentaccounts`, `orderpayments`, `paymentdisputes` indexes | `docs/payments-architecture.md`, "Database prerequisites" |
| `securityevents` indexes (TTL retention) | `docs/security-monitoring.md`, "Database prerequisites" |
| `websiteproposals` index | `docs/ai-website-builder-plan.md`, "Implemented (M0 + M1)" |
| Backup and restore drill before the first index operation | `docs/backup-and-disaster-recovery.md`, section 7 (Operator, Atlas admin) |
| Other models still build indexes automatically at startup | `docs/customer-accounts.md`, "Automatic collection and index creation" |

## 5. External credentials and service configuration

Set in the secret manager only; never committed, never read by agents.

| Variable / service | Needed for |
|---|---|
| `MONGODB_URI` (replica set), `SESSION_SECRET` (32+ chars) | Everything. `SESSION_SECRET` also keys hashes stored in the database: escrow it (`docs/backup-and-disaster-recovery.md`, section 4) |
| `TRUSTED_IP_HEADER` | Rate limits and security-event source fingerprints (mandatory in production) |
| Resend account, verified sender domain, `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM`, HTTPS `APP_URL` | **Mandatory in production** (without them the startup check fails and requests answer HTTP 500; the process may keep running): the password reset code (signup and login need no email), team invitations and order emails, verification and reset emails. See `docs/email-delivery.md` |
| `S3_*` bucket | Media uploads |
| `PAYMENT_CREDENTIALS_KEY` (32 random bytes, escrowed in two places with a recorded fingerprint, never changed while encrypted records exist) | Encrypting each business's Razorpay secrets. A wrong key is caught by the payment key check once its record exists (`docs/payments-architecture.md`, "Payment key check"); a lost key means every store must reconnect Razorpay (`docs/backup-and-disaster-recovery.md`, section 3) |
| Per business: Razorpay test keys and a webhook (payment-link and `payment.dispute.*` events) | Online order payments and disputes |
| Billing provider account, plans and prices | SaaS subscriptions (after the decisions in `docs/subscription-billing-audit.md`) |
| AI provider and data-sharing approval, then `GEMINI_API_KEY` + `AI_PROVIDER_ENABLED=true` | AI builder (after the decisions in `docs/ai-website-builder-plan.md`) |
| Wildcard DNS and TLS for store subdomains | Storefronts |

## 6. Staging requirements

| Item | Reference |
|---|---|
| Isolated staging database and credentials; section 4 operations applied there first | — |
| Restore drill into an isolated cluster: inventory, indexes, key fingerprints, canary sign-in and tenant checks, measured RTO and RPO recorded | `docs/backup-and-disaster-recovery.md`, section 7 |
| Health check rejects a deployment without `EMAIL_PROVIDER` (marked unhealthy, no traffic) and passes once it is restored | `docs/email-delivery.md`, "Staging tests", step 0 |
| Platform email with real delivery: password reset code; signup and login work without email; no codes or links in logs | `docs/email-delivery.md`, "Staging tests" |
| Customer accounts end to end with real email (register, verify, login, reset, tenant isolation, HTTPS cookies) | `docs/customer-accounts-staging-runbook.md` |
| Razorpay **test mode**: connect, pay, return, webhook, duplicate delivery, link expiry, a test dispute | `docs/payments-architecture.md` |
| Admin actions with two real admins (force sign-out, role change, last-admin refusal) | `docs/security-monitoring.md` |
| Security events appear for failed sign-ins and resets, with source fingerprints (needs `TRUSTED_IP_HEADER`) | `docs/security-monitoring.md` |
| COD end to end, including cancelling an uncollected order | `docs/ecommerce-payments-status.md` |
| Storefronts on real subdomains over HTTPS | Operator |
| Flags: `CUSTOMER_ACCOUNTS_ENABLED` and `ORDER_ONLINE_PAYMENTS_ENABLED` only after their indexes exist; `ORDER_PAYMENTS_LIVE_ALLOWED=false`; `AI_PROVIDER_ENABLED` unset | — |

## 7. Production blockers

Production must not be called ready while any of these is open:

- Every staging item in section 6 passed, with evidence.
- Hosting, wildcard DNS, TLS and ingress configured; `NODE_ENV=production`
  start-up validation passes (`instrumentation.ts`), including the mandatory
  email configuration. Passing it shows the configuration is complete and
  well-formed, not that mail arrives: a real password reset code must also have been
  received (`docs/email-delivery.md`).
- A health or readiness check configured **in the hosting platform** (SiteForge
  does not set one up) that requests `/login` and requires HTTP 200, so an
  instance whose startup check failed is marked unhealthy and receives no
  traffic. A failed check makes requests answer 500 but does not end the
  process, which may still print "Ready". On serverless hosting, check the new
  deployment before promoting it. It was shown on staging to reject a
  deployment without `EMAIL_PROVIDER` (`docs/email-delivery.md`, "Staging
  tests", step 0).
- Backups and a tested restore for MongoDB; `PAYMENT_CREDENTIALS_KEY` and
  `SESSION_SECRET` escrowed. Production on a tier with managed backups
  (Atlas Free has none; M10+ with Continuous Cloud Backup recommended), an
  offsite encrypted export, media bucket versioning or copies, and one passed
  restore drill. See `docs/backup-and-disaster-recovery.md`, section 9. None of
  this is in place yet, and the real Atlas configuration has not been checked.
- Monitoring and alerting on `[payments]`, `[customer-auth]`, `[security]` and
  `[api] unhandled error` log lines, and on failed platform email
  (`login_code_email_failed`, `[forgot-password] reset email could not be sent`,
  `[register] could not finish a registration`).
- Legal pages (`/terms`, `/privacy`) reviewed; disclosure of payment and (if
  enabled) AI processors.
- SaaS billing: either a real provider integrated and verified, or paid plans
  kept unavailable (`ALLOW_MANUAL_BILLING` off).
- Live Razorpay (`ORDER_PAYMENTS_LIVE_ALLOWED=true`) only after a business
  decision and a completed test-mode run; refunds stay manual in Razorpay.
- Payment key check **Verified** on staging and then production (Super Admin →
  Settings, or `npm run payment-key-check -- status`). With stored Razorpay
  secrets and no record, an operator must adopt the key with its escrow
  fingerprint, as an approved action on each environment separately. The code
  being deployed does not by itself mean production is verified.

## Known gaps (code)

- Online payment links are not cancelled at Razorpay when an order is
  cancelled; a late payment is flagged for a manual refund.
- No scheduler: expired reservations are released on demand.
- No order confirmation emails.
- No wishlist, quick view or newsletter sign-up (the storefront shows none).
- No carrier integration, shipping zones or taxes; one coupon per order.
- Security events do not record rate-limited attempts or invalid session
  signatures.
- `Cart` documents have no TTL index (abandoned carts accumulate).
