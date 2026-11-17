# AGENTS.md

Guidance for AI agents working in this repository.

## Project

**SiteForge** — a multi-tenant SaaS website builder. Business owners subscribe,
create a business profile, add products, pick one of nine themes, customize and
publish a storefront on a platform subdomain (custom domains prepared for the
future). A platform admin panel manages businesses and plans.

Do **not** rebuild from scratch, delete files, restructure folders, or break
working features. Make small, focused changes and inspect before editing.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript** (strict)
- **MongoDB** via **Mongoose 8** — the only database. Never introduce MySQL/PostgreSQL.
- Auth: cookie session (`httpOnly` JWT via `jose`) + `bcryptjs` password hashing
- Validation: **zod**
- Styling: **Tailwind CSS**
- Do not add unnecessary dependencies or services.

## Commands

```bash
npm run dev          # start dev server (http://localhost:3000)
npm run build        # production build
npm run lint         # eslint (next/core-web-vitals)
npm run typecheck    # tsc --noEmit
npm run seed         # seed categories + plans (needs MongoDB)
npm run create-admin -- --email you@x.com --name "You" --password "secret123"
```

Always run `npm run typecheck`, `npm run lint`, and `npm run build` after changes.
Never claim tests passed unless they actually ran.

## Environment

Copy `.env.example` to `.env.local` (never overwrite or commit `.env*`).
Required: `MONGODB_URI`, `SESSION_SECRET` (at least 32 characters). Optional:
`ROOT_DOMAINS`, `NEXT_PUBLIC_ROOT_DOMAIN`, `PAYMENT_PROVIDER`,
`PAYMENT_WEBHOOK_SECRET`, `ALLOW_MANUAL_BILLING` (defaults off; required to
manually activate paid plans in production), `TRUSTED_IP_HEADER` (name of the
proxy-set client-IP header, e.g. `x-real-ip`; forwarding headers are NEVER
trusted unless this is set). In **production** `TRUSTED_IP_HEADER` is
mandatory: if it is missing — or a request does not carry it — rate-limited
endpoints fail closed with `503 rate_limit_misconfigured` instead of sharing one
global bucket. Outside production an unset header falls back to the shared
bucket. Rate-limit keys are HMAC-hashed with `SESSION_SECRET`; raw IPs/emails
are never stored. Never expose secrets to the browser or invent production
credentials.

Media storage (see `backend/lib/s3.ts`): S3-compatible (AWS S3 or Cloudflare R2 via
`S3_ENDPOINT`). Prefer `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`S3_BUCKET`, `S3_PUBLIC_URL`; legacy `AWS_*` names are a fallback (credentials
only outside production and never on Vercel). Uploads are capped at 4 MiB.
During a storage migration, optional `S3_LEGACY_PUBLIC_URL` keeps media
ownership checks applying to URLs stored under the old bucket's public URL.
`MONGODB_MAX_POOL_SIZE` (1-50, default 10) caps the per-instance pool.

Email (see `backend/lib/email.ts`, no SDK, native `fetch`): `EMAIL_PROVIDER`
(`resend` | `console` | `memory`), `EMAIL_API_KEY`, `EMAIL_FROM`,
`EMAIL_REPLY_TO` (optional), `APP_URL`. Empty `EMAIL_PROVIDER` means `console`
in development. In production a real provider is MANDATORY: `instrumentation.ts`
(`assertEmailStartupConfig`) fails with an empty provider, `console`, `memory`,
or Resend settings that are missing or malformed (`EMAIL_API_KEY` starting `re_`,
`EMAIL_FROM`, an absolute HTTPS base `APP_URL`), because password reset needs an emailed code.
Requests then answer 500, but the process may keep running ("Ready"): never add `process.exit()`;
deployments rely on a hosting-platform health check of `/login`. The check is structural and
never contacts the provider. See `docs/email-delivery.md`.

`dbConnect` falls back to public DNS only when a `mongodb+srv://` lookup is refused
by a loopback DNS server (`querySrv ECONNREFUSED`, seen on some Windows machines).

`MONGODB_URI` must point at a **replica set**, not a standalone `mongod`. Never add a fallback that writes
without a transaction: `handle()` answers `503 transactions_unavailable` (`backend/lib/db-errors.ts`).
Multi-document transactions are used by the payments webhook
(`api/webhooks/payments`) and the membership `PATCH`/`DELETE` routes
(`api/businesses/[id]/members/[memberId]`); a standalone server rejects them
with `Transaction numbers are only allowed on a replica set member or mongos`.
Atlas (`mongodb+srv://…`) is always a replica set and works unchanged. For local
development run a single-node replica set (`mongod --replSet rs0`, then
`rs.initiate()`; a container works too) and append `?replicaSet=rs0` to the URI.
The integration tests already use a single-node replica set via
`MongoMemoryReplSet`.

## Architecture

```
app/            routes (pages + API route handlers)
  api/          REST endpoints (all wrapped in backend/lib/api.ts handle())
  dashboard/    business owner/staff UI (auth-gated)
  admin/        super-admin UI
  store/        public storefront (resolved from Host header)
backend/
  lib/          env, db, auth, guards, billing, tenant, validation, helpers
  models/       Mongoose models (business-scoped)
  scripts/      seed + create-admin (run via tsx)
frontend/
  components/   client + server UI components
  themes/       9 reusable themes + registry; skins/ holds each theme's design system
middleware.ts   host -> storefront rewrite
```

Import aliases (`tsconfig.json`) keep their old spelling: `@/lib/*` resolves to
`backend/lib/*`, `@/models` and `@/models/*` to `backend/models`, `@/scripts/*` to
`backend/scripts/*`, `@/components/*` to `frontend/components/*` and `@/themes/*` to
`frontend/themes/*`. `backend/lib` also holds modules shared with client components
(for example `api-errors.ts`, `use-link-token.ts`), so "backend" does not mean server-only:
keep using `server-only` and `import type` as before.

## Design system

Platform pages (marketing, auth, dashboard, admin) follow `docs/design-system.md`:
the `.app-surface` root switches `slate` and `brand` to the platform identity,
and `ThemeRenderer`'s `.store-surface` restores the storefront values, so themes
never change with the platform. Use `frontend/components/ui/*`, `confirmDialog` rather than
`window.confirm`, and never put platform fonts or branding on a shopper's store
(store pages mount `<ConfirmHost inline />`, which stays neutral and takes the theme's font).

## Core Conventions

### Multi-tenant security (critical)

- Every business-owned resource carries a `business` ref.
- **Always** resolve access with `requireBusinessRole(businessId, roles)` from
  `backend/lib/auth/guards.ts` before reading/writing tenant data. Never trust a
  `businessId` from the browser.
- Platform roles (`user` | `super_admin`) are separate from membership roles
  (`owner` | `staff` | `manager`). A user may belong to many businesses.
- Team invitations (`backend/lib/team-invitations.ts`, `TeamInvitation`, `autoIndex` off): nobody joins
  until they accept, signed in with a confirmed account on the invited address. Inviting never
  looks up the address, so it cannot reveal an account. Tokens are hashed, single-use and expire
  in 7 days; the inviter, store and plan are checked again on accepting. Owners invite to any role;
  managers only to staff, and only with the owner's `Business.managersCanInvite`.
- Business membership roles:
  - `owner`: full business control, billing, members, domains, publishing, settings, content.
  - `manager`: business settings, branding, pages, products, media, and publishing; no billing, member management, domains, or ownership transfer.
  - `staff`: operational product/media tasks and reads only; no settings, pages, publishing, billing, domains, or member management.
- `manager` is a business membership role only and never grants platform-level
  `super_admin` privileges.
- Super admins manage platform resources only and are not implicit business members.
- Enforce limits (products, staff, publishing) on the server via `backend/lib/billing.ts`.
- The dashboard customer list is DERIVED FROM ORDERS (`backend/lib/customers.ts`),
  the single source of truth for customer order history. `backend/models/Customer.ts`
  is now the business-scoped customer ACCOUNT model (no routes yet; see
  `docs/customer-accounts.md`) and is not used by that list. Identity =
  `customerEmail` with ordinary whitespace trimmed and ASCII lower-cased,
  within one business (no other merging; missing/malformed emails, including
  control characters, are only counted). Never put a stored value into an
  aggregation expression without `$literal`. Access: owners and managers only
  (same as order management), via `requireBusinessRole`.
- Public storefronts expose only published data (`backend/lib/tenant.ts`).
- Website editor and homepage presets (`docs/storefront-commerce.md`,
  "version 2"): the editor preview MUST use the storefront renderer
  (`ThemeRenderer`/`CommerceShell`/`CommerceHome` + `buildCommerceData`) with
  draft settings; never build a second renderer. Never auto-generate
  placeholder sections. Presets are keyed by `Business.category` (business
  type), never by product category, and contain no data. The editor renders
  the store inside `PreviewFrame` (an iframe at the device width), so
  storefront client components must use their element's `ownerDocument`
  (listeners, portals, scroll lock), never the global `document`.
- Storefront homepage/header/footer (`docs/storefront-commerce.md`): themes
  wrap `frontend/components/storefront/commerce/CommerceShell.tsx` with a per-theme
  skin (`frontend/themes/skins/<id>.ts`: tokens plus a choice of shared layout
  variants; no two themes share a header, section heading, product rail,
  benefits, promotion, story or footer composition; add a theme by adding a skin
  and a registry entry, never a new renderer; `THEME_IDS` is append-only; skin
  classes must be literal strings for Tailwind). Themes arrange content and
  never move, hide or invent it: section order stays the owner's. Motion is CSS only plus `MotionRoot` (never hides
  server-rendered or on-screen content; off with reduced motion and in the
  editor); no animation libraries. Public routes build data with `loadStorefrontFrame`
  (`backend/lib/storefront-commerce.ts`). Owner settings live in
  `themeSettings.storefront` (draft) and `themeSettings.publishedStorefront`
  (public), written only via `backend/lib/storefront-settings.ts` (owner/manager;
  publish needs verified email + `assertCanPublish`). Never render fabricated
  reviews, ratings, sales, discounts or stock: best sellers only from PAID
  orders, sale only when `compareAtPrice > price`, availability only as the
  derived `availability` (never the raw stock count in the public view), and
  owner links only through `resolveInternalHref`.
- Theme access (`docs/theme-marketplace-and-pages.md`): the default tiers
  (Free 3, Starter 6, Max/Pro 9) live ONLY in `backend/lib/theme-tiers.ts`;
  `Plan.features.themes` (Super Admin plan manager) overrides them. Read
  access through `getEntitlements().themes` / `getThemeAccess`, and call
  `assertCanUseTheme` wherever `themeId` is written (`PATCH /api/businesses/[id]`,
  `POST /api/businesses`, and the design draft in `backend/lib/design-service.ts`). Keeping the
  current theme is always allowed (never silently change a downgraded store).
  All nine themes stay visible; locked ones show upgrade information.
- Website builder history and drafts: the design (theme, colours, fonts, buttons,
  text size) has a draft (`themeSettings.designDraft`, `backend/lib/design-service.ts`)
  that ONLY previews may read (`toStorefrontView` with `useDraft`); the editors and
  the Design page never change the live theme on save. Website revisions
  (`backend/lib/website-revisions.ts`, `WebsiteRevision`, `autoIndex` off) are best-effort,
  scoped by business, and restoring only changes drafts. Everything waiting to go
  live is listed by `backend/lib/website-publish.ts`, which publishes only chosen items.
  Old page addresses redirect through `Page.previousSlugs`. Menus resolve only
  through `resolveNavItems` (`backend/lib/navigation.ts`): public menus never show draft
  pages. Homepage `block` sections stay out of `HOME_SECTION_TYPES` (the AI list)
  and render through `SectionRenderer`. Rich text uses `RichText`, never raw HTML.
  See `docs/storefront-commerce.md` and `docs/theme-marketplace-and-pages.md`.
- Publishing rules (`docs/storefront-commerce.md`): clients can never write a
  published copy (`publishedNavigation` and friends are refused by
  `themeSettingsSchema`). A live store's theme and colours change only through the
  design draft (`updateDesignDraft`) and publishing; `PATCH /api/businesses/[id]`
  refuses them. Other changes that show at once, such as publishing a page, pass
  `assertCanChangeLiveWebsite` (`backend/lib/publish-gates.ts`). Taking content down needs no
  plan or verified email, but a suspended store cannot. A homepage kept only in
  `themeSettings.sections` moves to a Home page record through
  `backend/lib/legacy-homepage.ts` and is never edited in place on a live store.
- Draft preview links (`backend/lib/preview-links.ts`, `app/preview/view`): only a hash of
  the token is stored; never log the raw token or a link. They are served on the
  platform address only and must stay `noindex`. They need an active plan to create
  and to open. Never pass the business document or anything beyond the allowlisted
  storefront settings to the browser on that page, and never read drafts on a `/store`
  route. `toStorefrontView` keeps raw menus out of every view.
- Colours: a store still on the platform's starting colours shows its theme's
  palette (`themeBrandColors`, `backend/lib/storefront.ts`) and follows it when the theme
  changes; any colour the owner picks is used as it is. Words such as "Shop all"
  come from `storeVocabulary` (`backend/lib/storefront-presets.ts`) by business type.
- Website builder additions (`docs/storefront-commerce.md`, "Website builder additions"): add a ready-made section only in
  `backend/lib/section-library.ts`, and never give a template wording of its own: text an owner must write is a `[[placeholder]]`, which
  publishing refuses on any visible section. Screen size settings go through `backend/lib/section-responsive.ts` (media queries, `data-rs`),
  never a second renderer. Read design choices only through `pickStoreDesign`; "theme" must keep adding no class. A header or
  footer layout may be offered only if it uses the skin's own tokens (`HEADER_LAYOUTS`, `FOOTER_LAYOUTS`). The `reviews` section
  shows only `recentApprovedReviews`, read only when the rendered sections need it (`reviewsWanted`), never in `loadStorefrontFrame`. Homepage,
  design and menu saves from an editor send `x-expected-version` (`backend/lib/draft-version.ts`). Write draft menus only through `saveNavigationDraft`,
  and move `navigationDraftVersion` on anywhere else that changes them. Never answer a page's older fields from a hydrated document: the model
  fills in an absent `publishedSections`, so read it lean (`liveCopyToKeep`, `resolvePublishedPageSections`).
- Default pages (`backend/lib/page-presets.ts`, `backend/lib/page-generation.ts`): drafts
  only, never the home page, never over an existing slug or kind, never
  overwriting owner pages or non-empty navigation; text only from the
  owner's data, unknowns as `[[placeholders]]`; pages only for real data
  (categories, sale prices, products). Generated pages publish only with no
  placeholders left, and policy templates only with `confirmReviewed`.
  `SectionRenderer` renders content pages through the theme skins; never add
  a second renderer. `/` renders the commerce homepage until a published Home
  page exists (`backend/lib/storefront-pages.ts`): never a 404, never a draft. The
  website editor opens that same homepage (`selectEditorPage`).
- Commerce (`docs/commerce-operations.md`): EVERY stock change goes through
  `backend/lib/inventory.ts` (reserve/restore/adjust) and records an
  `InventoryMovement` in the same transaction; never `$set` stock or rewrite
  a product's `variants` array (use `backend/lib/product-variant-service.ts`). A product
  edit that changes stock must send `expectedStock`.
  Variant products: `Product.stock` = sum of variant stock; variants are
  archived, never deleted; cart/order lines carry the exact variant. Order
  totals (coupon, shipping) are computed ONLY server-side
  (`backend/lib/checkout-pricing.ts`, `backend/lib/coupons.ts`); a coupon use is claimed in
  the order transaction after the order is owned, and released on
  cancel/expiry. Reviews only from paid orders proven by the order proof,
  moderated before publishing; ratings count approved reviews only.
  Managed categories (`ProductCategory`) link by the product category text.
  Per-customer coupon limits also match the phone, and the address if the coupon says so, as
  keyed hashes bound to that coupon (`couponIdentityKeys`); never store these values plainly.
  The new models have `autoIndex` off (indexes are an approved operation).
- Starter samples (owner decision 2026-11-17, `backend/lib/sample-products.ts`): the quick start
  (`addSamples: true`) and `POST products/samples` add a few products from the theme preview
  catalogue (`sampleCatalogFor`, by business type, none for service types) as DRAFTS marked
  `Product.sample`, within the plan limit, with stock 0 and no description, sale price or rating.
  A sample can never be made active as it is: changing its name, price or photo clears the mark
  (server-only). Its bundled photo is never stored as `imageUrl`. Removing samples archives them.
- Pricing: `priceOrder` (`backend/lib/checkout-pricing.ts`) is the only order calculation,
  used by the cart preview and checkout, so a shopper is charged what they saw.
  Refunds go through `backend/lib/payments/order-refunds.ts`: an amount is held on the order
  before the provider is called, and counts as refunded only from Razorpay's answer,
  re-read from its API. One provider refund is one record: Razorpay refunds stay off until the
  unique `orderrefunds` index exists (`order_refunds`). Razorpay refunds are owner-only; recording one made another
  way is owner or manager. Only an owner may release a stuck refund's hold (`recoverStuckRefund`): Razorpay refunds with no
  Razorpay id, a day old, with a reason and an explicit statement, recorded in `OrderRefund.recovery` in the same transaction.
  Never start a refund from it, and never release a hold automatically or because a request timed out. Order emails go through `queueOrderEmail` and must never
  change an order or an API answer. Team notes (`Order.internalNote`) never reach a
  shopper-facing view or the CSV export.
- Customer accounts are NOT platform users. Customer sessions use the
  `sf_customer` cookie (`__Host-sf_customer` in production) and an HKDF-derived key (`backend/lib/auth/customer-session.ts`);
  authorize them only with `requireCustomer(request)`
  (`backend/lib/auth/customer-guards.ts`), which resolves the business from the Host,
  never from a client id. Never read `sf_customer` in platform guards or
  `swb_session` in customer code. `Customer` has `autoIndex`/`autoCreate` off:
  its indexes need an approved operation (see the doc).
- Customer registration/login/verification/recovery live in
  `backend/lib/auth/customer-accounts.ts` behind `app/api/storefront/account/*` and
  `app/store/account/*`. Business comes only from the Host via
  `resolveCommerceBusiness`; responses never reveal whether an account exists;
  customer tokens use `CustomerActionToken` (never platform `AuthToken`);
  email verification also requires the current password (pre-hijacking
  defence). Gated by `CUSTOMER_ACCOUNTS_ENABLED` (default off; only `"true"`
  enables; checked server-side on every request): wrap new customer routes in
  `handleCustomerAuthRoute`, which also answers `503 feature_not_ready` until the unique indexes
  (`customer_accounts`, `backend/lib/required-indexes.ts`) exist, and never enable the flag before the indexes in
  `docs/customer-accounts.md` exist. Work whose cost depends on whether an
  account exists (lookups, tokens, email) runs after the response via
  `backend/lib/after-response.ts`; log only `event`/`operation`/`category`, never
  emails, tokens or error messages. The production cookie is `__Host-sf_customer`.
  These pages exist only on a store host (`<subdomain>.localhost:<port>/account/login`
  locally); `app/account/[[...rest]]` on the platform host only says where to go
  and must never become a sign-in without a store.
  Signed-in pages (`/account`, `/account/orders[/id]`, `/account/profile`) use
  `requireCustomerPage` (`backend/lib/auth/customer-page.ts`) and `AccountShell`, and take
  their look from the active theme (`accountVars`, `sf-acc-*` classes), never
  fixed colours. Profile updates change only the name and phone.
  Customer rate-limit keys use `customerRateLimitSource` (IPv4 address or IPv6
  /64 from the trusted header only). The known-device marker
  (`backend/lib/auth/customer-device.ts`) only selects a login failure budget and must
  never be treated as authentication; it is bound to a keyed fingerprint of
  the current password hash, so a password reset outdates every older marker.

### Auth

- Passwords hashed with bcrypt; never stored or returned in plaintext
  (`User.toJSON` strips `passwordHash`).
- No hidden/bypass admin accounts. Create super admins only via
  `backend/scripts/create-admin.ts`.
- Routes: `requireUser`, `requireSuperAdmin`, `requireBusinessRole`. Pass the
  roles explicitly: the default list leaves out managers. `middleware.ts` refuses
  cross-site writes to every `/api` route (`isAllowedApiOrigin`).
- Platform sign-in limits (`app/api/auth/login/route.ts`, `docs/security-monitoring.md`): only failures count against an
  account, reserved before the password check and returned after the right password. Sources are IPv4 addresses or IPv6 /64s
  (`rateLimitSourceKey`). No limit may reveal whether an account exists.
- Platform signup and login are EMAIL AND PASSWORD ONLY (an owner decision): `POST /api/auth/register` creates the account
  and signs in (`409 email_taken` for a registered address), `POST /api/auth/login` signs in with the right password. There
  is no emailed login/signup code and no email confirmation; new accounts have no `emailVerifiedAt`, and logging in clears an
  old `null`. Do not reintroduce a code step, a "remembered browser" or confirmation without a new owner decision.
- Password reset is the one emailed six-digit code (`backend/lib/auth/login-challenge.ts`, `backend/lib/auth/code-verification.ts`):
  `/api/auth/password/forgot` answers identically for every address with a pending code (own httpOnly cookie); when there
  is nothing to send to, it is a decoy bound to an id no account has, whose code never matches and whose answers equal a
  wrong code's. `/api/auth/password/reset {code, password}` sets the password, raises `tokenVersion` and `deviceTrustVersion`,
  and never signs in. Store codes only as their keyed hash (purpose included) and never return or log them: only
  `backend/lib/auth/dev-login-code.ts` prints one, and only with `NODE_ENV=development`, `AUTH_LOG_OTP=true` and
  `EMAIL_PROVIDER` `console`/`memory`. Keep the 5-minute, single-use limits, the 5 guesses per pending code and the daily
  reset budget (`backend/lib/auth/login-code-limits.ts`) reserved before every comparison, keyed by the pending code's account id.
- Platform admin (`/api/admin/*`): every handler calls `requireSuperAdmin()`
  first. Business status changes are explicit `suspend` / `reactivate` actions
  with a required reason (reactivation returns to `draft`; only the owner's
  validated publish flow can publish). Sensitive admin actions go through
  `runAuditedAdminAction` (`backend/lib/admin-audit.ts`), which writes the append-only
  `AdminAuditLog` in the same transaction. Never log secrets or request bodies.
- Super Admin control center (`/admin/*` pages, `backend/lib/admin/control-center.ts`,
  `docs/admin-control-center.md`): every page calls `requireSuperAdminPage()`
  and every API `requireSuperAdmin()`. Overview, users and payments are READ-ONLY, and
  business detail is too, apart from the audited status, account and plan actions; never add
  an admin control that marks payments paid or refunded. Plan assignment
  (`backend/lib/admin/plan-assignment.ts`) records no payment and refuses a subscription Razorpay
  is billing. Report money per currency and keep manual/sandbox, provider,
  online-order and COD amounts separate. Never return password hashes, token
  versions, payment secrets, order proofs or shopper names/emails from admin
  views; regex-escape search input.
- Platform account actions (`backend/lib/admin/user-actions.ts`): increment
  `tokenVersion` on every change, and `deviceTrustVersion` (cancels every pending reset code) on
  `force_signout`, `deactivate` and both role changes; never on an ordinary
  logout, and never bind device trust to `tokenVersion`. Never touch business memberships, refuse
  self-actions, keep at least one active super admin (serialised in the
  transaction), require the actor's password for role changes, audit in the
  same transaction. See `docs/security-monitoring.md`.
- Security events (`backend/lib/security-events.ts`, `SecurityEvent`, append-only,
  `autoIndex` off): store digests, never passwords, raw emails, IPs or tokens;
  recording is best-effort and must never change an auth response. Storefront
  events carry `scope: "storefront"` and the Host-resolved business; never add
  an account lookup to a customer auth path just to enrich an event (timing
  must not reveal whether an account exists). Revoked customer sessions are
  recorded throttled and after the response.
- Payment disputes (`backend/lib/payments/disputes.ts`, `PaymentDispute`, `autoIndex`
  off): state comes ONLY from Razorpay (signed webhook -> API re-read), only for
  a payment of the same business; never change orders/payments or record
  refunds from a dispute. Admins may only append audited notes.
- Billing (subscription API and the billing page) is owner-only; managers and
  staff see only the plan name, its limits and whether it is in force: send entitlements through
  `entitlementsForRole`, and never send them the status, a failed payment, a grace date or a period end. Their only
  warning is the neutral "may lose access to some features" banner, with a day from the owner's own banner dates and no reason. Razorpay Subscriptions
  (`backend/lib/billing-razorpay.ts`, `docs/subscription-billing-architecture.md`) uses SiteForge's own
  account, separate from store checkout. Access changes only from a signed webhook followed by
  an API re-read, through `reduceSubscription`; never from a redirect or a client message. Live
  keys need `BILLING_LIVE_ALLOWED`. Do not enable it without separate approval.
- AI provider layer (`backend/lib/ai-providers/*`, `docs/ai-website-builder-plan.md`, "Provider layer"): application code calls
  providers only through `runAiRequest` and `executeAiTask`, and never reads a provider's own format or picks a provider or model.
  A provider exists only as a registered `AiProviderAdapter`; a name in a setting never makes one available. Store data goes only to
  `AI_DISCLOSED_PROVIDER_IDS`: adding one means updating the consent disclosure and bumping `AI_CONSENT_VERSION`. `aiRouting` (platform
  settings, audited, `PUT /api/admin/ai-routing`) can only narrow what the environment allows: never add a setting that turns a provider
  on. API keys (owner decision 2026-11-17) may be set by a Super Admin only through `app/api/admin/ai-credentials` (password again, reason,
  audited with the last four characters only), stored only encrypted in `AiProviderCredential` (`backend/lib/ai-providers/credentials.ts`,
  key derived from `SESSION_SECRET` with its own HKDF purpose); never return, log or audit a key, and never let one turn AI on. Adapters
  read keys only through `aiProviderKey`, so every path that decides availability or calls a provider runs `loadAiCredentials()` first. Fallback happens only to providers the platform listed. A request is charged once and accepted once,
  whatever its attempts: never retry after `accept`. Show availability only from `aiReadiness` / `aiPlatformStatus`, never `aiBuilderStatus`
  alone. A plan's origin comes only from `assessPlanProvenance`, never from the browser; saving a plan must keep calling it.
- Complete website generation (`backend/lib/ai-website/*`, `docs/ai-website-builder-plan.md`, "Complete website generation"): generated data is ordinary CMS sections, storefront config,
  design draft and menus, so the normal editor edits all of it; never add an AI-only format. Every provider call goes through `runAiRequest`, and generation is one request per step. A
  whole-website proposal (`target: "website"`) is applied only by `applyApprovedWebsiteProposal`, in the proposal's transaction, through the draft services. It may change a published page's
  DRAFT fields, never its live copy, title or address, and never removes a page. Conversations are read by business AND person. Earlier messages reach a provider only as a delimited data
  block, and only the owner's words count as facts in the claims check. Conversations are private to the person: never show one to another member or copy it into a proposal, including its messages and the assistant's summary of them (a proposal describes itself with `describeWebsiteChanges`). A single suggestion's `request` goes only to its author. Validate an answer's templates and categories before keeping it (`findUnsupportedChoices`), so a stored step can always be built. A provider sees products and
  media only by reference (`p1`, `m1`), resolved on the server and checked again when applying. A proposal never retires an older custom homepage: only publishing from the website editor does.
- AI providers: Google Gemini, Anthropic Claude (`backend/lib/ai-providers/claude.ts`, official `@anthropic-ai/sdk`) and OpenAI
  (`openai.ts`, native `fetch`), all owner-approved (Claude and OpenAI 2026-11-17, consent `2026-11-17.1`). The Super Admin picks one
  or more on `/admin/ai-usage` (keys, then routing). The rules below for Gemini apply to every provider.
- AI provider: Google Gemini (owner-approved; OFF in production until the
  activation requirements in `docs/ai-website-builder-plan.md` are met; never
  enable production AI without that separate approval). `getWebsitePlanningProvider()` and
  `aiBuilderStatus()` (`backend/lib/ai-builder/provider.ts`) report unavailable unless
  `AI_PROVIDER_ENABLED` is exactly `"true"` (no trimming), a key exists and
  `GEMINI_MODEL` (optional) is valid. Every
  provider call goes through `backend/lib/ai-planning/gemini-http.ts` (key in a header
  only, one timeout including the body, fixed messages, scalar-only logs).
  AI routes use `guardAiRequest` (same-origin, owner/manager, verified email,
  kill switch BEFORE rate limits or data access, not suspended, the owner's
  consent) and make the call only through `runAiRequest`
  (`backend/lib/ai-builder/request.ts`: consent re-read, final data check, monthly
  allowance reserved, outcome recorded as success/rejected/failed; anything
  refused before reaching Gemini is not charged). Consent
  (`backend/lib/ai-builder/consent.ts`): owner-only grant/revoke of the current
  `AI_CONSENT_VERSION`, state in `Business.aiConsent`, history in append-only
  `AiConsentEvent` (same transaction); provider activation never implies
  consent. Store data reaches a prompt ONLY through the allowlist builders in
  `backend/lib/ai-builder/sanitize.ts` (redaction + `assertProviderPayloadSafe`):
  never customers, orders, payments, accounts, sessions, secrets, contact
  details, prices, stock or SKUs. This store's page titles, descriptions and
  section text are approved. The saved email, phone and address are removed by
  value from every text field sent (`knownContact` is required on every prompt
  builder; `runAiRequest` checks again). Real Gemini is tested only via
  `npm run test:staging-ai` (in-memory DB, staging key from the process
  environment). `AiUsage` stores counters only, never
  prompts or generated text. Prompts keep owner
  text and store data in escaped, delimited blocks (`backend/lib/ai-builder/prompts.ts`)
  and never include customers, orders, contact details, payments or
  credentials. Generated text that states facts the store has not provided is
  refused (`backend/lib/ai-builder/claims.ts`). Product-copy suggestions are never
  saved by the server: the owner uses them in the form and saves normally.
- AI Builder (`docs/ai-website-builder-plan.md`, "AI Builder"): requests are
  classified deterministically (`backend/lib/ai-builder/intent.ts`); the provider never
  picks a task. Add a task only behind `guardAiRequest` + `runAiRequest`, with a
  strict schema and the claims check. Page output goes through
  `backend/lib/ai-builder/page-builder.ts` into the existing editing actions and
  proposals: text fields only, contact sections filled from the business on the
  server, real categories and store links only, unknown facts as
  `[[placeholders]]`. SEO, theme and product suggestions are never saved by their
  routes. Page proposals change draft pages only (a published page gets a new draft
  copy). Changing what is sent to the provider means updating the disclosure and
  bumping `AI_CONSENT_VERSION`. Admin AI usage (`backend/lib/admin/ai-usage.ts`) is stored
  counters only: no prompts, generated text or estimated costs.
- Website change proposals (`backend/lib/ai-planning/proposal-service.ts`,
  `WebsiteProposal`, `autoIndex` off): the ONLY way a proposal changes data is
  an explicit approve then apply by an owner/manager, in one transaction with
  the status claim: draft pages through `applyApprovedEditingProposal`, or
  (target `storefront`) the DRAFT homepage through
  `applyApprovedStorefrontProposal` (`saveStorefrontDraft`, with brand colours and
  font going to the design draft). Homepage
  proposals are strict change sets (`backend/lib/ai-builder/storefront-changes.ts`) and
  go stale when the draft or brand changes. Never add a generic write path for
  AI output (AI plans only become proposals, never a direct "apply"), never
  publish from a proposal, and never accept status, reviewer or source from the
  client.
- Store setup wizard (`/dashboard/businesses/[id]/setup`, `backend/lib/store-setup.ts`):
  owners and managers; every step saves through the existing routes and
  components; `PUT /setup` stores only progress (`Business.setup`: step,
  confirmed and skipped steps). Step completion comes from real data where
  possible, and readiness mirrors the publish route exactly (verified email,
  active plan, not suspended); everything else is a recommendation. Publishing
  is always an explicit action.
- Owner insights (`backend/lib/business-insights.ts`, `/dashboard/businesses/[id]/insights`):
  owners and managers only; measured values only (no estimates or AI); keep
  definitions consistent with the Orders/Customers pages and `backend/lib/billing.ts`.
- Action tokens (`backend/models/AuthToken.ts`, `backend/lib/auth/action-tokens.ts`): only a
  SHA-256 hash of the raw token is stored; the raw value is returned to the
  caller once and must never be logged, serialized or persisted. Tokens are
  single-use and consumed atomically (`findOneAndUpdate`), so concurrent
  callers cannot both succeed. The TTL index is eventual cleanup only — always
  check `expiresAt` explicitly. Issuing a token invalidates prior unconsumed
  tokens for the same user and type; different types stay independent.
- Email verification state (`User.emailVerifiedAt`) is a tri-state: a `Date`
  means verified, `null` means explicitly unverified (new registrations), and
  an absent/`undefined` value means a legacy account that stays grandfathered as
  verified. The field has **no schema default** (a default would retroactively
  mark legacy accounts unverified) and is only ever written by the server.
- `requireVerifiedEmail()` (`backend/lib/auth/guards.ts`) rejects only explicit `null`
  and is applied to privileged writes (business creation, publish, team invite,
  checkout). Platform addresses are no longer confirmed (see "Platform signup and login" above), so in
  practice only sessions of accounts still marked `null` from before are refused.
- Registration (`backend/lib/auth/platform-registration.ts`) refuses a registered address with `409 email_taken`,
  which reveals that the address is registered (accepted with the decision above). Someone can sign up with an
  address they do not own; its owner takes it back with a reset code, which ends every session.
- One-time links carry their token after `#` (`backend/lib/use-link-token.ts`), so it never reaches a
  server log, proxy or referrer; never put a token in a query string, a path or server-rendered
  page data. Draft previews swap theirs for an httpOnly cookie scoped to `/preview`.
- Forms show a server's per-field messages beside the field: `readApiError`/`apiErrorFrom`,
  `summaryMessage`, `invalidProps` (`backend/lib/api-errors.ts`) and `FieldError`/`Field` (`frontend/components/ui/Field.tsx`).
  `HttpError` takes `fields` as its fifth argument. Store pages keep the theme's `sf-acc-error`.
- Validation errors go through `backend/lib/validation-messages.ts`: a schema's message is a full sentence,
  and defaults are completed with the field's plain name. Add a name to `FIELD_LABELS` rather than
  showing a code name. Zod 4: `.default()` skips parsing and applies inside `.partial()`, so use
  `.prefault()` and write partial-update schemas without defaults.

### Email

- `backend/lib/email.ts` is the only sending entry point: `sendEmail({ to, subject, text, html })`.
  It is server-only (reads `backend/lib/env.ts`) and must never be imported into a client component.
- Transports: `resend` (native `fetch` to the Resend HTTP API, no SDK), `disabled` (no email on
  purpose, allowed in production: every send throws `EmailDisabledError`; password reset answers
  `503 email_disabled`, invitations are refused, order emails are skipped; check `isEmailDisabled()`
  before starting anything that only works by email), `console`
  (development only, redacted), `memory` (in-memory outbox for tests). `console` and
  `memory` are refused in production, and a production server without a real provider
  fails its startup check (requests answer 500); should anything run without that check, `sendEmail` still throws
  instead of faking delivery. Never add a fallback to a non-delivering transport, and
  never a sign-in path that skips the emailed code because email failed.
- `backend/lib/email-templates.ts` holds the branded HTML + plain-text templates (the platform's
  password reset code email, and the storefront's links). Escape any user-controlled value with `escapeHtml` before
  interpolating it, and keep wording imperative — never claim an action succeeded before
  its token has been verified.
- **Never log raw action tokens, passwords, codes or complete reset/verification links** (the only exception is the
  development code aid in `backend/lib/auth/dev-login-code.ts`). The
  console transport logs only a masked recipient and the subject, and errors carry the
  HTTP status, never the API key, request body or recipient.
- No automatic retries: a failed send throws (`EmailSendError`) so callers can decide.
- Tests: `npm run test:unit` covers config resolution, transports (mocked `fetch`), the
  memory outbox and templates. Automated tests never make real network requests.

### Payments

- `PAYMENT_PROVIDER=manual` is sandbox only. Live checkout is gated in
  `api/businesses/[id]/subscription`.
- Webhooks (`api/webhooks/payments`) require a valid HMAC signature and dedupe on
  `providerEventId`. Never trust frontend payment-success messages. That legacy webhook cannot re-read a
  provider: it is off unless configured, never runs with `PAYMENT_PROVIDER=razorpay`, needs
  `LEGACY_PAYMENT_WEBHOOK_ENABLED` in production, and must never change a Razorpay-billed subscription.
- Storefront orders: `Order.paymentMethod` is `online` | `cod` with NO default
  (absent = unknown, never COD). Business users may mark an order paid only via
  `confirmCodPayment` (COD orders only); `markOrderPaid` is called only by
  `confirmPaymentLink` (`backend/lib/payments/order-payments.ts`) after re-reading the
  Razorpay Payment Link from the API (id, reference, amount, currency, paid).
  A redirect, client message or unverified webhook never marks an order paid.
- Online order payments use each business's OWN Razorpay account
  (`BusinessPaymentAccount`, owner-only, secrets AES-256-GCM encrypted with
  `PAYMENT_CREDENTIALS_KEY`, never returned or logged) and `OrderPayment` (not
  `Payment`). Gated by `ORDER_ONLINE_PAYMENTS_ENABLED` (default off); live keys
  need `ORDER_PAYMENTS_LIVE_ALLOWED`. Both models have `autoIndex`/`autoCreate`
  off; their indexes are an approved operation (`docs/payments-architecture.md`).
- Payment key check (`backend/lib/payments/key-check.ts`, `PaymentKeyCheck`, `_id` fixed, immutable,
  `autoIndex` off, read by `_id` only): call `assertPaymentKeyUsable` (or `checkPaymentKey` +
  `isBlockingPaymentKeyState`) BEFORE any new code decrypts a store's payment secret or causes a side
  effect with it (a refund hold, a provider request), and `assertPaymentKeyForEncryption` before
  encrypting one. Never write the record except by that insert, never update, replace or delete it to
  make payments work, never create it while encrypted secrets exist (only the operator's
  `npm run payment-key-check -- adopt --expected-fingerprint <escrow>` may), and never treat a
  database failure as a mismatch. Never add a mode that decrypts stored secrets to check the key.
  Owners see only the generic `payment_key_unavailable`; state and fingerprints are Super Admin only.
  Tests use a mocked Razorpay (global `fetch` replaced) and never hit the network.
- Do not enable live payments or invent provider credentials without authorization.

### Next.js 15 gotchas

- `params`, `headers()`, and `cookies()` are **async** — always `await` them.
- Route/API handlers must not import models into client components. Import model
  **types** with `import type` only; runtime model imports (mongoose) are server-only.
- `backend/lib/host.ts` is edge-safe (used by middleware) — never import mongoose there.
- MongoDB connection is cached globally in `backend/lib/db.ts`; call `dbConnect()` in server code. It creates no
  collection or index on a persistent database (`automaticIndexesAllowed`: only development or test, on this machine),
  and refuses to work if a core unique index is missing (`backend/lib/core-indexes.ts`). Never add `createIndexes`,
  `syncIndexes` or a setting that turns automatic creation on. See `docs/database-preparation.md`.
- Storefront resolution reads the `Host` header; middleware rewrites tenant hosts to `/store`.

## Data Safety

- Follow existing model conventions and add validation + indexes.
- Product deletes are **soft** (archived) — preserve data where possible.
- Business deletion is **soft** too (`backend/lib/business-deletion.ts`, `DELETE /api/businesses/[id]`, Settings →
  Delete business): only the primary owner (`Business.owner`), with the exact name and their password, rate limited.
  It sets `status: "deleted"`, disables every membership, revokes pending invitations and preview links, in one
  transaction; nothing is erased. It is refused while orders await payment or delivery, refunds are pending, a
  Razorpay plan bills, or the store is suspended (checked again in the transaction). `getMembershipsForUser` hides
  deleted businesses; admin suspend/reactivate never touch one. Never add a path that reopens or hard-deletes it
  without an owner decision.
- Never delete collections/production data or run destructive DB ops without approval.
- Never run `git reset --hard`, force-push, or delete branches without permission.
- Do not commit, push, deploy, or publish without authorization.

## Known Partial Areas

- Custom domain: TXT ownership verification, plan gating, 90-day freshness, lifecycle states,
  health, renewal tracking, history and the DNS and certificate checks behind activation are
  implemented (`backend/lib/domains/*`). `activatedAt` is set only by `backend/lib/domains/activation.ts`; never
  mark a domain active any other way. In production a new domain serves only with it; one with
  no `activationRequired` was verified earlier and keeps working. Never take a domain out of
  service for a temporary lookup or provider failure, or for a stored date alone. No ingress,
  DNS or issuing provider exists, and `tls_probe` only inspects: never claim automated renewal
  without a `ManagedCertificateProvider` (see `docs/domain-lifecycle-migration.md`).
- Plan limits (`docs/platform-management.md`): count usage only through `backend/lib/usage-limits.ts`
  (`getBusinessUsage`). On every creation path, check a limit in the same transaction as the write:
  `withUsageCheck`, or an `assert*` function given the session, which takes the store's turn
  (`takeUsageTurn`). A limit only ever stops something new: never delete, hide or change data on a
  downgrade. Absent optional limits mean no limit, so existing plans do not change.
- Entitlement: `isEntitlingSubscription` (`backend/lib/billing.ts`) is the only rule, and `backend/lib/store-access.ts`
  only combines its answer with a store's state. Never judge access from a subscription's status alone.
  Who may publish lives in `backend/lib/publish-gates.ts` (`PUBLISH_ROLES`, `getPublishFacts`): keep it with the guards.
- Local media addresses: section and homepage schemas check only their format, because they also read stored data. `assertMediaUrlsOwned` refuses them on every write and publish unless `localMediaServable()` (`backend/lib/media.ts`).
- Media: write the `Media` record (`uploadState: "pending"`) before storing a file, so no file exists without a
  record, and remove files only through `backend/lib/media-storage.ts` after `countMediaReferences` finds nothing.
- Product restoration goes through `restoreArchivedProduct`, one transaction; never rejoin its steps separately.
- Notifications (`backend/lib/notification-events.ts`): create them only through its `notify*` functions, called
  after the change is committed and never inside a transaction. The catch-up cursor moves only after a look succeeds. Give each event one fixed key, and add it to
  the catch-up in `backend/lib/notifications.ts`. Never put shopper details in their text or send email from them.
  In-app only, off until their index exists.
- Support contact: use `SupportContact` on platform pages, and never invent an address. It must never appear
  on a shopper's store, which shows the store's own contact details.
- Platform settings (`backend/lib/platform-settings.ts`): only the fields in `platformSettingsSchema`, audited.
  Never add a switch for live payments, production AI or an integration, or show a secret's value.
  Maintenance mode must never stop storefronts, checkout, webhooks, signing in or unpublishing.
- Media references (`backend/lib/media-references.ts`): every place that stores an image must be counted there,
  including order history, or deleting the file breaks it.
- Features resting on unique indexes (team invitations, subscription billing, custom
  domains, notifications, Razorpay refunds) stay off until those indexes exist (`backend/lib/required-indexes.ts`, which reads the database
  and never creates one). Call `assertFeatureReady` on new write paths of these features, and
  never treat a schema's index declaration as proof that it exists.
- Scheduled work goes through `runScheduledJob` (`backend/lib/scheduled-jobs.ts`: no overlap, at most 50
  items, outcomes recorded) behind `schedulerDenied`. No scheduler is set up; see `docs/scheduled-jobs.md`.
  Expired reservations are released by `order-expiry` through the same conditional step as every other release; it never decides expiry.
- Ecommerce: guest cart, checkout (stock reservation, idempotency), order
  status/cancel, owner order management, catalog search (`/products`) and
  cash on delivery for verified signed-in customers (owner-only
  `Business.codEnabled`, non-expiring COD reservations, max 3 open COD orders
  per customer) work locally. Guests can pay cash on delivery only with the owner's
  `Business.guestCodEnabled`: phone and address required, stock held 7 days unless the store
  starts preparing the order, max 2 open per phone or email (`backend/lib/orders/guest-cod.ts`).
  Whose cart a request means is decided only by `resolveShopperCart` (`backend/lib/cart/shopper-cart.ts`);
  a cart tied to a customer needs that customer's session, and account carts stay off until their
  index exists. Never declare an index on a model with `autoIndex` on without approval (`Cart`,
  `Order`, `Product`): it changes what local databases and tests build, and a persistent database then needs an approved operation. Carts never hold stock. Online payment (Razorpay Payment Links, INR
  only) is implemented and tested only against a mocked Razorpay. Checkout that
  uses a customer session, COD or online payment must stay same-origin JSON; set `customer` and
  `paymentMethod` only server-side, on BOTH order-creation paths. Customer
  order history must be scoped by business AND customer. See
  `docs/ecommerce-payments-status.md`.
- Online order payments and refunds: never exercised against Razorpay's real test
  API; no credential check at connect time, no audit entry for credential changes.
- SaaS subscription billing through Razorpay Subscriptions: implemented, and only ever run
  against a mocked Razorpay. See `docs/subscription-billing-architecture.md`. That includes
  reconciliation (`reconcileBusinessSubscription`) and refunds and disputes on subscription
  payments (`BillingAdjustment`), which reflect Razorpay and never change access; the Super Admin
  view (`/admin/billing`) is read-only apart from asking Razorpay again. `backend/lib/billing-status.ts`
  describes a state and never decides access.
