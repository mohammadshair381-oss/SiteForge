# Customer accounts

Status: **implemented, hardened (Phases 3A and 3C), DISABLED by default,
NOT production-ready.** Customers can register, confirm their email, sign in and
out, recover a password, see an account dashboard, edit their name and phone,
change their password, and read their order history and each order's details on
a storefront, but only when the server-side feature flag is on. There are no
saved addresses and the email cannot be changed. Guest checkout is unchanged.

> **Go-live gate.** Keep `CUSTOMER_ACCOUNTS_ENABLED` off until every item in
> "Before enabling" below is done in that environment. In particular, without
> the unique `{ business: 1, email: 1 }` index, concurrent registrations of one
> email can create duplicate accounts. The staging procedure is in
> [customer-accounts-staging-runbook.md](customer-accounts-staging-runbook.md).

## Decisions (fixed)

- Each business has its own customer accounts. The same email at two
  businesses is two unrelated accounts.
- Customer accounts are not platform users (owners, staff, admins).
- Guest checkout stays. Guests pay online only; COD only for registered
  customers of businesses that enabled it (disabled by default).

## Feature gate: `CUSTOMER_ACCOUNTS_ENABLED`

- Evaluated server-side on every request by `isCustomerAccountsEnabled()`
  (`lib/env.ts`). It is not cached, so switching it off takes effect without a
  code change.
- Only the exact value `true` (surrounding whitespace ignored) enables the
  feature. A missing, empty or other value (`1`, `TRUE`, `yes`, ...) keeps it
  off.
- While off:
  - every `/api/storefront/account/*` route returns **404** with the same body
    as an unavailable store (`{"error":"This store is not available","code":"not_found"}`)
    and `Cache-Control: no-store`. The gate runs before parsing, rate limiting
    and database access, so nothing is written: no account, token, rate-limit
    counter, email, session or cookie change;
  - the `/account/*` pages 404 (`app/store/account/layout.tsx` calls
    `notFound()` before reading headers or the database). Tested by calling
    the layout directly (`tests/integration/customer-account-layout.test.ts`);
    Next's own conversion of `notFound()` into a 404 page is not exercised;
  - `requireCustomer` throws the same 404, so future customer routes are gated
    too.
- `.env.example` documents it as `CUSTOMER_ACCOUNTS_ENABLED=false`. No
  environment enables it automatically.

**Future fail-closed index check (not implemented).** Checking indexes safely
needs a real database, which this phase does not touch. Proposed design:

- On the first gated request per process, call the read-only
  `Customer.collection.indexes()` and `CustomerActionToken.collection.indexes()`.
  Never `createIndexes`, `syncIndexes` or `ensureIndexes`.
- Require a unique index with key exactly `{ business: 1, email: 1 }` and one
  with key exactly `{ tokenHash: 1 }`.
- Cache a success for the process lifetime. On a missing index or a listing
  error, return 503 `customer_accounts_unavailable` and log
  `event=index_check_failed`, retrying the check on later requests.
- A missing collection also counts as "missing index", so it fails closed.
- See "Automatic collection and index creation" (approach 2) for the wider
  version of this idea, which needs its own design review.

## Session separation (`lib/auth/customer-session.ts`, `lib/auth/customer-guards.ts`)

| | Platform user | Customer |
|---|---|---|
| Cookie | `swb_session` | `__Host-sf_customer` in production, `sf_customer` elsewhere. Host-only, httpOnly, SameSite=Lax, Secure in production, 7 days. |
| Signing key | `SESSION_SECRET` bytes | HKDF-SHA256(`SESSION_SECRET`, info `siteforge:customer-session:v1`) |
| Claims | `userId`, `platformRole`, `tokenVersion` | `sub` (Customer id), `bid` (business id), `tv`, `typ: "customer"`, `iss: "siteforge"`, `aud: "siteforge:customer"` |
| Guard | `requireUser` / `requireBusinessRole` / `requireSuperAdmin` | `requireCustomer(request)` |

- **Cookie prefix.** The `__Host-` prefix (production only) makes browsers
  accept the cookie only with `Secure`, `Path=/` and no `Domain`, so a sibling
  tenant subdomain cannot plant or overwrite it. Production reads only the
  prefixed name.
  - Outside production the plain name is kept, because plain-http
    `*.localhost` cannot set `Secure` cookies.
  - The rename is safe because the feature has never been live. If it had
    been, existing production sessions would simply require a new sign-in.
- **Known-device marker (not a session).** `sf_device` (`__Host-sf_device` in
  production; httpOnly, SameSite=Strict, 90 days) from
  `lib/auth/customer-device.ts`. It is issued after a successful login or a
  successful password reset. Besides a random device id it carries two keyed
  hashes: one of (business, normalised email) and one of the account's
  current password hash. So it never contains the email, the password or the
  hash. It uses its own HKDF keys, type and audience, and `requireCustomer`
  never reads it. It is used only to pick the login failure budget (see Rate
  limits). It survives logout on purpose; a password reset outdates it (see
  "Bound to the current password").
- **Keys.** The signing keys differ, so a token from one system fails
  signature verification in the other (tested in both directions).
- **What `requireCustomer` checks.** It reads only the customer cookie. It
  resolves the business **only from the request Host**
  (`resolveBusinessByHost`) and requires `bid` to equal that business. It then
  loads `Customer { _id, business, active: true }` and compares
  `tokenVersion`.
  - Every failure is the same 401 (`customer_unauthenticated`).
  - `requireVerifiedEmail: true` adds a 403 (`customer_email_unverified`).
- **Revocation.** `revokeCustomerSessions` and any password change increment
  `tokenVersion`, which ends every session of the account. Logout does this
  too (it signs out every device).
- **Platform auth.** The platform session code and auth routes are unchanged.

## Endpoints (`app/api/storefront/account/*`)

The logic lives in `lib/auth/customer-accounts.ts`. Every route is wrapped by
`handleCustomerAuthRoute`, which:

- enforces the feature gate first;
- sets `Cache-Control: no-store` on **every** response, including errors;
- turns unexpected errors into a generic 500 and logs only
  `event=request_failed category=<category>`. Database error messages can
  contain customer emails, so they are never logged.

Every endpoint also:

- resolves the business **only from the Host** through the commerce gate
  (`resolveCommerceBusiness`). The platform host, unknown hosts and draft,
  suspended or lapsed stores get the same 404. No endpoint accepts a business
  id;
- for state-changing endpoints, requires `Content-Type: application/json`
  (415 otherwise). When the browser sends `Origin`, it must equal the
  storefront host, and only `https://` is accepted in production (403
  `csrf_failed`);
- never creates, reads or accepts a platform session, `User`, role or
  membership.

| Route | Behaviour |
|---|---|
| `POST register` `{name, email, password}` | Always **202** with the same generic message ("we will send", never "we have sent"). The request path validates, applies the rate limits and hashes the password. Everything else runs **after the response**. **New email:** create an unverified account and email a verification link. **Existing account, verified or not:** change **nothing** (no new name, password or token) and email an "account already exists" notice. For an unverified account the notice adds "not confirmed yet" guidance. **Inactive:** nothing. |
| `POST login` `{email, password}` | Unknown email, wrong password and an inactive account all get the same **401** `invalid_credentials`, with a dummy bcrypt compare when no account exists. A correct password on an unverified account gets **403** `customer_email_unverified` and no session. Success sets the customer session cookie **and** refreshes this browser's known-device marker (bound to the password just verified), and returns `{customer: {name, emailVerified}}`. |
| `POST logout` | If a valid session exists, revokes **every** session of the account. Always clears the cookie. Returns 200. |
| `GET me` | `{customer: {name, email, emailVerified}}` or `{customer: null}`. |
| `POST email/verify` `{token, password}` | 200, or 400 `invalid_token` / `invalid_password`. Does not sign in. |
| `POST email/resend` `{email}` | Always 202 with the generic message. After the response, sends a new link only for an active, unverified account. |
| `POST password/forgot` `{email}` | Always 202 with the generic message. After the response, sends a reset link only for an active account. |
| `POST password/reset` `{token, password}` | 200, or 400 `invalid_token`. The token is checked **before** any bcrypt work. Does not sign in. Every existing known-device marker of the account becomes outdated (they are bound to the old password). This browser gets a new marker for the new password (the reset proved inbox control), so the owner can sign in from it during an account-wide lock. |

### Pre-hijacking defence and re-registration

An unverified account's password was chosen by whoever first typed the email,
not necessarily its owner.

- `email/verify` requires the link token **and the current password**. A wrong
  password does not spend the token.
- The update is conditional on the `tokenVersion` that was checked, so a
  password changed in between (by a reset) cannot be verified with the old one.
- Re-registration **never** overwrites an existing account and never issues a
  new token, so repeated registrations cannot replace a pending password or
  invalidate the legitimate owner's link (this changed in Phase 3A).
- An owner who does not know the pending password uses **forgot password**.
  That proves inbox control, sets their password, marks the email verified and
  revokes everything else.
- The verify page never auto-submits, because mail scanners prefetch links.

### Action tokens (`models/CustomerActionToken.ts`, `lib/auth/customer-tokens.ts`)

These are separate from the platform `AuthToken` model.

- **Format.** 256-bit random, base64url. Only the SHA-256 hash is stored
  (`select: false`). The raw value exists only in the emailed link and is
  never logged.
- **Scope.** Always tied to a business **and** a customer, and consumed only
  with the Host-resolved business.
- **Single use.** Consumed with one conditional `findOneAndUpdate`
  (`usedAt: null`, not expired, same business and type). Expiry is checked
  explicitly; the TTL index is only cleanup.
- **Issuance.** Issuing runs in a transaction that first writes the customer
  document, invalidates the unused tokens of that type, then inserts the new
  one. Concurrent issuers conflict on the customer write and the loser is
  retried, so at most one token per type stays usable without needing a
  partial unique index (tested with 6 concurrent issuers). Issuance refuses
  inactive or unknown customers.
- **Reset.** A successful reset invalidates **all** open tokens of the
  account.
- **Lifetimes.** Verification links last 24 hours, reset links 1 hour.

### Email delivery: after the response

**How it is scheduled.**

- For register, resend and forgot, the account lookups, account creation,
  token issuance and sending run through `runAfterResponse`
  (`lib/after-response.ts`). Inside a Next request it uses Next 15's stable
  `after()`.
- If `after()` throws (outside a request scope, or an unexpected runtime), the
  task runs as a detached `setImmediate` task instead.
- In **production** that fallback logs a warning:
  `[after-response] event=after_fallback_used operation=<label> reason=<ErrorName> durable=false`.
  The log contains no email, token, link, request path or message.
- Every task failure is logged as `event=background_task_failed` (see below).

**What the request path guarantees.** Before responding, every email takes
the same steps: gate, store lookup, rate limits, validation, plus one bcrypt
hash for register. This removes the systematic difference that provider
latency used to cause.

**What it does not guarantee.**

- Response time is **not constant**: it still varies with network, database
  and runtime load.
- **Delivery is not guaranteed.** Neither `after()` nor the fallback is a
  durable queue. Nothing is retried, and a task that is lost leaves no log line.
  - On Vercel, `after()` is bounded by the function's maximum duration
    (`waitUntil`).
  - On `next start` it runs in the same process after the response; a restart
    or crash before it finishes loses it.
  - A detached fallback task on a serverless instance can be frozen or killed
    as soon as the response is sent.
- **Registration can be lost before the account exists.** The account is
  created in the after-response task, not before the 202. If that task is lost
  (or fails, e.g. a database error, logged as `background_task_failed`), **no
  customer record is created**. Resend and forgot-password then do nothing for
  that email, because they only act on existing accounts. The customer must
  **register again**, which is safe because registration never overwrites an
  existing account.
- **Resend and forgot.** If their task is lost, the customer can simply ask
  again, subject to the per-address caps.
- **Messages.** The public messages therefore say "we will send … if nothing
  arrives, check spam or try again", never "we have sent". A 202 means
  "accepted", not "created" or "delivered".

**Tested vs unverified.**

| Behaviour | Status |
|---|---|
| Choosing `after()` when it accepts the task | Tested, with an injected fake runtime (`tests/unit/after-response.test.ts`) |
| Falling back when `after()` throws; the production warning and its log-safety | Tested, with an injected fake runtime |
| Task rejection reaching `onError`; a throwing reporter being contained | Tested |
| The real `after()` outside a request scope selecting the fallback | Tested |
| All integration tests | Run on the fallback path |
| The real Next `after()` inside a live request (`next start`, Vercel `waitUntil`) | **Unverified.** Needs a running Next server and a production build, which this phase did not run. |
| Behaviour when the process or instance is terminated | **Unverified** |
| Real email-provider latency | **Unverified** |

**Before scaling,** add a durable outbox (a collection worked by a scheduled
job, with retries) or a managed queue.

### Email failure handling and observability

- A failed send never changes the public response and never reaches the
  customer.
- Every failure logs exactly one line with no recipient, token, link, body or
  provider message:
  `[customer-auth] event=email_delivery_failed operation=<verification|password-reset|account-exists> category=<category>`.
- Categories:

  | Category | Meaning |
  |---|---|
  | `email_configuration` | Email is not configured (`EmailConfigurationError`). |
  | `email_provider_unreachable` | The provider could not be reached (no HTTP status). |
  | `email_provider_unavailable` | The provider returned 5xx or 429. |
  | `email_provider_rejected` | The provider returned another 4xx. |
  | `database` | A database error. |
  | `unknown` | Anything else. |

- Other events:
  - `event=background_task_failed operation=<register|resend|forgot> category=<category>`
  - `event=email_suppressed operation=<scope> reason=address_rate_limited` (warn)
  - `event=request_failed category=<category>`
- **Operators must alert on `event=email_delivery_failed`,
  `event=background_task_failed` and `[after-response]
  event=after_fallback_used`.** A 202 response does **not** mean an email was
  delivered, or even that the account was created.

### Links

Links come from the business's canonical storefront origin
(`storefrontOrigin(subdomain)`), never from the request Host:
`/account/verify-email#token=…`, `/account/reset-password#token=…`,
`/account/login`, `/account/forgot-password`. Templates escape store and
customer names.

## Rate limits

### Sources: which client a request counts against

- **Where the address comes from.** `getClientIp` (`lib/rate-limit.ts`,
  unchanged) uses **only** the operator-configured `TRUSTED_IP_HEADER`. For
  `x-forwarded-for` it takes the **right-most** entry, the one appended by the
  nearest proxy. Any other header is used as-is.
  - It assumes the configured header is set or overwritten by exactly one
    trusted hop in front of the app. Behind a CDN plus a load balancer, the
    right-most `x-forwarded-for` entry may be the CDN's address, which would
    collapse many users into one source. Use a single-value header your edge
    sets (for example `x-real-ip`) instead.
  - In production a missing setting or missing header is a 503. Outside
    production it becomes the shared `unknown` bucket.
- **How the address becomes a source key.** The customer endpoints canonicalise
  it with `rateLimitSourceKey` (`lib/client-address.ts`), through
  `customerRateLimitSource`:

  | Address | Source key |
  |---|---|
  | IPv4 (port ignored; leading-zero octets rejected) | that one address, `ipv4:a.b.c.d` |
  | IPv6 (brackets, port and zone id stripped) | its **/64**, `ipv6/64:h:h:h:h`. Rotating addresses inside one /64 is one source. |
  | IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) | the embedded IPv4 address |
  | Missing or empty | shared `missing` bucket |
  | `unknown` | shared `unknown` bucket |
  | Anything unparseable | **one** shared `unparseable` bucket, so varying garbage cannot mint new sources |

- **Scope.** Platform rate limits (platform login and others) still use the
  raw address. Changing them is out of this phase's scope.

### Limits

Keys are HMAC-hashed and per business. Windows are fixed and clock-aligned
(`floor(now / windowMs)`), so all buckets with the same window length reset
together.

| Action | Per source | Per (email, source) | Account / address wide |
|---|---|---|---|
| register | 10 / 15 min | 5 / 15 min | max 5 registration emails / 60 min per address (silent) |
| login | 20 / 15 min, all attempts | 5 **failures** / 60 min | 50 **failures** / 60 min per account |
| login from a known device of that account (marker valid for the current password) | 20 / 15 min, all attempts | — | 5 **failures** / 60 min **per device** instead of the two failure buckets |
| resend + forgot | 10 / 60 min (shared bucket) | 3 / 60 min, per kind | max 3 emails / 60 min per address, per kind (silent) |
| verify + reset | 20 / 15 min | — | — |

### Login: only failures count

- Each attempt reserves one unit in its failure bucket(s) before the password
  check. This is atomic, so parallel guesses cannot overshoot.
- A correct password, including the 403 "unverified" case, releases the units
  in the **same** window bucket. Successful logins therefore never count as
  failures (tested). They do count against the 20-per-source "all attempts"
  limit.
- A source that is already blocked never consumes the account-wide budget.

### Known devices against distributed lockout

- **Who has a marker.** A browser that has signed in successfully, or
  completed a password reset, holds a marker for that (store, email).
- **What it changes.** Its login attempts use only that device's own failure
  budget (5 per hour). They neither check nor spend the (email, source) or
  account-wide budgets.
- **What still applies to known devices:**
  - the per-source limit, 20 attempts per 15 minutes with successes included,
    on every request (tested);
  - the correct password, always;
  - an inactive account always gets 401;
  - an unconfirmed email gets 403, with neither a session nor a marker
    (tested).
- **What it does not change.** The marker never authenticates (tested). The
  session is a separate cookie with a separate key, and the marker is
  rejected when presented as one.
- **What gives no exemption.** Markers for another account or store, and
  forged, malformed, expired or outdated markers, all fall back to the normal
  limits (tested; expiry in the unit tests).
- **Markers do add guessing capacity.** Each valid marker is a separate
  5-per-hour budget outside the account-wide cap, and the number of markers
  per account is not limited. Brute-force protection is therefore weaker for
  anyone holding markers. Binding markers to the password (below) limits
  this to markers issued for the **current** password.

#### Bound to the current password

- **How.**
  - The marker carries `cf`: an HMAC-SHA256 of
    `credential:<business id>:<password hash>` under its own HKDF-SHA256
    subkey of `SESSION_SECRET` (info `siteforge:customer-device:credential:v1`).
  - The (store, email) binding and the JWT signature use two other subkeys
    (`siteforge:customer-device:account:v1`, `siteforge:customer-device:v1`).
  - None of these keys is the customer-session or platform key.
  - Without the server secret, `cf` reveals nothing about the hash.
- **Checked at every login.**
  1. The login first checks the marker's signature, type, audience, expiry,
     store and email, with no database access.
  2. Only if all of those pass does it read the account's current password
     hash, once, and recompute the fingerprint.
  3. Only a match selects the device budget. Anything else, including an
     inactive account, gets the normal limits.
  - The extra read happens only for someone already holding a marker issued
    for that (store, email), so it reveals nothing new about which accounts
    exist.
- **Why a reset outdates every marker.**
  - Each successful login without a marker mints a new one, so anyone who
    once knew the password could collect any number of markers.
  - Before this binding, those markers survived a reset and kept their extra
    budgets for up to 90 days against the **new** password.
  - Now the new password hash (bcrypt hashes are salted) has a new
    fingerprint, and every marker issued before the reset falls back to the
    normal limits (tested, with several harvested markers).
- **Why other browsers sign in again.**
  - Only the browser that completed the reset gets a marker for the new
    password. Every other browser, including the owner's own, is treated as
    unknown until it signs in successfully with the new password.
  - If attackers hold the account-wide lock at that moment, such a browser
    stays locked out until the window ends.
  - Resetting again from that browser would recover it, but would in turn
    outdate the marker of the browser that reset first.
- **Logout** neither removes nor outdates the marker, because the marker is
  not a session (tested).

### Residual lockout risk (accurate as of password-bound markers)

- **Attack cost.** An attacker who knows a customer's email and controls at
  least **10 sources** (IPv4 addresses or IPv6 /64s) can spend the 50-failure
  account-wide budget at the start of each hourly window. Because the windows
  are clock-aligned, the attacker can **renew this every hour indefinitely** at
  a cost of about 50 requests per hour. Holders of a larger IPv6 allocation
  (a /48 contains 65,536 /64s) find 10 sources trivial.
- **Who is locked out.** **Browsers without a current known-device marker**
  for that account: a new device, a cleared or private browser, a first
  sign-in, and, right after a password reset, every browser except the one
  that reset. They get 429 for as long as the attack continues.
- **Who is not locked out.**
  - The owner's known browsers keep working, including while the lock is
    renewed (tested), as long as the password has not changed since they
    last signed in.
  - The owner can always recover a locked-out browser through "forgot
    password". A successful reset marks that browser as a known device
    (tested) and outdates the markers of every other browser. The
    per-address email cap (3 per hour) still applies, but the latest link
    already in the inbox stays valid.
- **Stolen or collected markers:**
  - Until the password changes or 90 days pass, a marker copied from a
    browser gives its holder that device's 5 guesses per hour, still subject
    to the per-source limit.
  - While the password is unchanged, the number of markers per account is
    unlimited. Only someone who knows the current password (and so can sign
    in anyway) or controls the inbox can mint them.
  - A single marker cannot be revoked on its own. Changing the password
    revokes all of them.
  - A marker holder can tell from the limits it gets whether the password has
    changed since its marker was issued.
- **Still open:**
  - An attacker on the **same source** as the owner (a shared IPv4 NAT, or the
    same /64) can exhaust the 20-per-15-minutes per-source limit, which also
    applies to known devices (tested).
  - Fixed windows allow up to twice the limit in a short span around a
    boundary (tested).
- **Not implemented.** Progressive delays: holding requests open costs server
  resources and would not stop renewal.

### Email caps are silent

Over a per-address cap, requests still get the generic 202 but nothing is sent
and no new token is issued. Flooding "forgot password" therefore cannot make
the owner's own request fail, and cannot invalidate the latest link already in
their inbox (tested).

## Pages (`app/store/account/*`)

These pages exist only on a store's own host, because the business comes only
from the Host: locally `http://<subdomain>.localhost:<port>/account/login`, for a
published store with an active plan. `/account/*` on the platform host
(`http://localhost:<port>/account/login`) is not a sign-in: it is a page with no
data access that says where to go (`app/account/[[...rest]]/page.tsx`).
Storefront navigation uses relative `/account/*` links, so it stays on the store.

**Hydration warnings from browser extensions.** A development warning that names
attributes such as `data-temp-mail-org` or a `background-image` style on an email
input comes from an extension changing the page before React hydrates, not from
these forms. In Chrome with extensions disabled, the account pages render no
warning and their controls match the server HTML; injecting those attributes
reproduces the warning, and sign-in still works. Check in a clean profile first.
Do not add `suppressHydrationWarning` or client-only rendering for this.

`/account/login`, `/account/register`, `/account/verify-email`,
`/account/forgot-password` and `/account/reset-password` share
`app/store/account/layout.tsx` and
`components/storefront/account/AccountForms.tsx`.

- **Availability.** Gated by the feature flag, and rendered only for an
  eligible storefront (404 otherwise). `noindex, nofollow`,
  `<meta name="referrer" content="no-referrer">`, and `/account` is disallowed
  in robots.
- **Labels and names.** Every input has a label, a stable `name` and the right
  `autocomplete`. Hints and errors are linked with `aria-describedby` and
  `aria-invalid`. After client-side validation fails, focus moves to the first
  invalid field.
- **Announcements.**
  - Errors use one persistent `role="alert"` region per form, mounted while
    empty so later messages are announced, with no nested live region.
  - Inline success (login's "link sent") uses a persistent `role="status"`
    region.
  - When a form is replaced by its success message, focus moves to that
    message (`tabIndex=-1`), so it is read once and keyboard position is kept.
- **Password toggle.** The accessible name changes between "Show <field>" and
  "Hide <field>" and contains the visible text. There is no `aria-pressed`.
- **Contrast.** Button text is black or white, whichever contrasts more with
  the theme's primary colour (`lib/color-contrast.ts`). For any hex colour this
  reaches at least 4.5:1, which meets WCAG AA for the button text (tested over
  the colour space).
  - **Not covered:** the store-name link in the header (primary colour on
    `slate-50`) and the focus ring colours depend on the theme colour and are
    not guaranteed AA.
  - Focus movement is implemented but only verified by static markup tests;
    no DOM test library is installed.
- **Navigation.** Link tokens are removed from the address bar on load. After
  login the browser goes to `?next=` only if it is a same-site path
  (`safeStorefrontPath`).
- **Slug.** `account` is a reserved page slug.

### Signed-in account endpoints

All wrapped in `handleCustomerAuthRoute`, so 404 while the feature is off, and
authorized with `requireCustomer` (business from the Host, customer from the
session).

- `GET /api/storefront/account/profile`, `PATCH` (same-origin JSON, 30 per 15
  minutes per source): only `name` and `phone`; anything else in the body is
  ignored.
- `POST /api/storefront/account/password/change` (same-origin JSON, 10 per 15
  minutes per source and 5 per hour per account): proves the current password.
  In one transaction it stores the new hash (bumping `tokenVersion`) and spends
  every open link; this browser gets a new session and known-device marker, every
  other session stops working. A wrong password records
  `password_change_failed` (scope `storefront`).
- `GET /api/storefront/account/orders/[orderId]`: allowlisted details, by business
  AND customer; another customer's or store's order is the same 404 as a missing one.

## `models/Customer.ts`

- **Fields:**
  - `business`, `name`, `email` (lowercase, trimmed), `phone`, `notes`.
  - `passwordHash` (`select: false`, removed from JSON).
  - `active` (default true).
  - `tokenVersion` (default 0, removed from JSON).
  - `emailVerifiedAt` (default null; written by the server only).
- **Behaviour:** a pre-save hook increments `tokenVersion` when the password
  changes. The legacy `user` field must stay null. `autoIndex: false` and
  `autoCreate: false`.
- **Emails:** normalised with `.trim().toLowerCase()`
  (`normalizeAccountEmail`). The dashboard customer list stays derived from
  orders (`lib/customers.ts`).

## Database prerequisites (NOT performed)

> **Status: no real database has been inspected.** Nothing in this section
> has been run against any staging or production database, so the index
> state, data quality and server version of every real environment are
> **unknown**. The automated tests create every index themselves in a
> throwaway in-memory replica set (MongoDB 8.2.6), so they say nothing about a
> real database.

The staging procedure that uses this section is
[customer-accounts-staging-runbook.md](customer-accounts-staging-runbook.md).

### Ground rules

- **Part A (read-only) and Part B (writes) are separate operations.** Never
  mix them in one session or script.
- **Part A runs as a read-only database user** (the `read` role on the app
  database only), so an accidental write fails instead of changing data.
- **Every write needs its own approval.** That covers each index creation,
  each data fix and each index drop. The approval names the operation, the
  cluster and the database. Immediately before the write, in the same
  session, the operator repeats A0 and confirms in writing that the target is
  **not production**.
- **Record counts and index specifications only.** Never copy emails,
  password hashes, token hashes or other customer data into tickets or chat.
- **Stop on anything unexpected.** Do not fix data on the spot; a fix is a
  separate, approved write.

### Connections and secrets

- **Where the connection string comes from.** Only from the approved staging
  secret store (for example the staging project's secret manager or its
  deployment settings), for the user the operation needs: read-only for
  Part A, the index operator for Part B. **Never** take it from `.env.local`,
  `.env` or any developer machine. `.env.local` may hold real credentials,
  and the project's scripts load it first (`scripts/load-env.ts`).
- **No project scripts.** Do not run `npm run seed`, `npm run create-admin`
  or `npm run domain-migration` as part of this work unless there is a
  separate written approval **and** the shell's `MONGODB_URI` has been
  checked against the approved staging target. These scripts load the models,
  so they also create collections and indexes (see "Automatic collection and
  index creation").
- **No secrets in commands or history.**
  - Start `mongosh` without a password on the command line
    (`mongosh "<uri without password>" --username <user>`, then type the
    password at the prompt).
  - Never paste a password, connection string with credentials, API key,
    token or cookie value into a command that is kept in shell history,
    a ticket or chat.
  - Clear or disable history for the session if a secret was typed by
    mistake, and rotate that secret.
- **One target per session.** Open a new session for each database. Never
  switch a session from staging to another cluster.

### Part A: read-only preflight (mongosh)

**A0. Positively identify the database before any other query.**

```js
db.getName()                    // must equal the approved database name
db.hello()                      // check .setName and .hosts
db.runCommand({ isMaster: 1 })  // fallback if db.hello() is unavailable: same .setName and .hosts
```

- `hello` exists from MongoDB 4.4.2 (and some older patch releases). On an
  older server, `db.hello()` fails; use the `isMaster` fallback, then A1
  stops the run anyway, because the version is below the minimum.
- Compare `setName` and `hosts` with values written in the approval by the
  infrastructure owner, not with the connection string you were handed. On
  Atlas, also confirm the project and cluster name in the Atlas UI.
- **Stop** if any value differs, if a host belongs to the production
  cluster or project, or if `setName` is missing (a standalone server is not
  supported).
- **Gate:** blocks everything, including every other Part A query.

**A1. MongoDB version and replica set.**

```js
db.version()
db.hello().isWritablePrimary              // fallback: db.runCommand({ isMaster: 1 }).ismaster
db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 }) // needs monitoring rights; skip if refused
```

- **Replica set (or sharded cluster) required.** Customer token issuance,
  email verification and password reset use multi-document transactions, as
  do the payments webhook and the membership routes.
- **MongoDB 4.4 or later.** Token issuance inserts into
  `customeractiontokens` inside a transaction. Before 4.4 that fails if the
  collection does not exist yet (Part B creates it). This minimum comes from
  MongoDB's documented transaction rules; it has **not** been tested in this
  project, and it is conservative once Part B has created the collection.
- Check the server version against the compatibility table of the MongoDB
  Node.js driver 6.20.0 (used through Mongoose 8.24.5). The tests run on
  MongoDB 8.2.6 only.
- **Stop** on a standalone server or a version below 4.4.
- **Gate:** blocks deployment, Part B and the flag.

**A2. Collection options and default collation.**

```js
db.getCollectionInfos({ name: { $in: ["customers", "customeractiontokens", "ratelimits", "pages"] } })
```

- A missing collection is fine; it is created later.
- Record `options.collation`. A non-simple default collation applies to every
  index built on that collection, including the unique indexes in Part B. For
  example, a case-insensitive collation would treat `Ada@x.com` and
  `ada@x.com` as duplicates. **Stop** and review if any of these collections
  has a default collation.
- Also record any `validator`, `capped` or `timeseries` option.
- **Gate:** a collation or unusual option on `ratelimits` blocks deployment.
  On `customers` or `customeractiontokens` it blocks Part B. On `pages` it is
  reviewed before the flag goes on.

**A3. Current indexes.**

```js
db.customers.getIndexes()
db.customeractiontokens.getIndexes()
db.ratelimits.getIndexes()
db.pages.getIndexes()
```

Compare with "Indexes" below. **Stop** and plan an approved replacement if:

- an index has the intended keys but different options, for example a
  non-unique `{ business: 1, email: 1 }`, a `{ expiresAt: 1 }` without TTL, or
  a partial, sparse or collated variant. Creating the intended index then
  fails with `IndexOptionsConflict`;
- an index with the intended name has different keys
  (`IndexKeySpecsConflict`);
- `ratelimits` lacks the unique `{ key: 1 }` or the TTL `{ expiresAt: 1 }`
  index (see "Automatic collection and index creation").

**Gate:** a missing unique `{ key: 1 }` on `ratelimits` blocks deployment,
because every rate-limited route would answer `503 rate_limit_unavailable`. A
conflict on `customers` or `customeractiontokens` blocks Part B.

**A4. Sizes.**

```js
db.customers.estimatedDocumentCount()
db.customeractiontokens.estimatedDocumentCount()
db.ratelimits.estimatedDocumentCount()
```

**Gate:** none; the sizes inform the A14 build window.

**A5. Exact duplicate customer emails.** These block the unique index.

```js
db.customers.aggregate([
  { $group: { _id: { business: "$business", email: "$email" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $count: "duplicateGroups" }
], { allowDiskUse: true })
```

Record only the count. Listing the records to resolve them is a separate,
approved review.

**Gate:** any result (a `duplicateGroups` value) blocks Part B (B1). An empty
result means there are none.

**A6. Duplicates after case and whitespace normalisation.** These do not
block the index, but they break sign-in: the app stores and looks up
`email.trim().toLowerCase()`, so only one record of such a group can ever be
found.

```js
db.customers.aggregate([
  { $match: { email: { $type: "string" } } },
  { $group: { _id: { business: "$business", email: { $toLower: { $trim: { input: "$email" } } } }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $count: "duplicateGroups" }
], { allowDiskUse: true })
```

**Gate:** any result blocks turning the flag on, until each group is resolved
by an approved data fix.

**A7. Non-ASCII emails (manual review).** MongoDB's `$toLower` is only well
defined for ASCII, while JavaScript's `toLowerCase()` handles Unicode, and
`$trim` and JavaScript's `trim()` use slightly different whitespace sets. A6
can therefore miss duplicates among these records; review them by hand.

```js
db.customers.countDocuments({ email: /[^\x00-\x7F]/ })
```

**Gate:** a count above 0 blocks turning the flag on, until the records have
been reviewed.

**A8. Emails not stored in normalised form.** Sign-in never finds these
records.

```js
db.customers.countDocuments({ email: { $type: "string" }, $expr: { $ne: ["$email", { $toLower: { $trim: { input: "$email" } } }] } })
```

**Gate:** a count above 0 blocks turning the flag on.

**A9. Missing, null, empty or wrong-type keys.**

```js
db.customers.countDocuments({ $expr: { $ne: [{ $type: "$email" }, "string"] } })      // missing, null, array, number...
db.customers.countDocuments({ email: "" })
db.customers.countDocuments({ $expr: { $ne: [{ $type: "$business" }, "objectId"] } }) // missing, null, string...
```

A unique compound index treats a missing field as `null`, so two records of
one store without an email block it. An array-valued email makes the index
multikey and changes what "unique" means. **Stop** until each record is
resolved.

**Gate:** any count above 0 blocks Part B (B1).

**A10. Legacy customer records** (from the original placeholder model).

```js
db.customers.countDocuments({ passwordHash: { $exists: false } })
db.customers.countDocuments({ active: { $exists: false } })
db.customers.countDocuments({ emailVerifiedAt: { $exists: false } })
db.customers.countDocuments({ tokenVersion: { $exists: false } })
db.customers.countDocuments({ user: { $ne: null } })
```

How the code treats them:

- **No `passwordHash`:** can never sign in (always 401). "Forgot password"
  would set a password, so decide whether these people should be able to.
- **No `active`:** behaves as inactive, because reads use `.lean()`, which
  does not apply schema defaults.
- **No `emailVerifiedAt`:** treated as unverified (403 after the correct
  password).
- **No `tokenVersion`:** read as `0`, so no effect.
- **`user` not null:** must be null. It is never read for authentication,
  but clearing it is a separate, approved data fix.

**Gate:** any count above 0 blocks turning the flag on, until a written
decision covers each kind of record.

**A11. Action tokens.**

```js
db.customeractiontokens.aggregate([
  { $group: { _id: "$tokenHash", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $count: "duplicateGroups" }
], { allowDiskUse: true })
db.customeractiontokens.countDocuments({ tokenHash: { $not: /^[0-9a-f]{64}$/ } })           // missing, null or malformed
db.customeractiontokens.countDocuments({ $expr: { $ne: [{ $type: "$expiresAt" }, "date"] } }) // not a date
```

- `tokenHash` is the SHA-256 hex digest of the raw token
  (`hashActionToken`, `lib/auth/action-tokens.ts`). Duplicates block the
  unique index, and a malformed hash can never match a link.
- The TTL index ignores an `expiresAt` that is not a date, so such tokens are
  never cleaned up. They are also never usable, because expiry is compared
  as a date.

**Gate:**

- Duplicate groups block Part B (B2).
- Missing or null `tokenHash` values also block B2 when there is more than
  one, because the unique index treats them all as `null`. Any malformed
  value blocks B2 until reviewed.
- An `expiresAt` that is not a date blocks turning the flag on, until it is
  cleaned up by an approved data fix.

**A12. Rate-limit keys.** Duplicates stop the unique index being created
(see below).

```js
db.ratelimits.aggregate([
  { $group: { _id: "$key", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $count: "duplicateGroups" }
], { allowDiskUse: true })
db.ratelimits.countDocuments({ $expr: { $ne: [{ $type: "$expiresAt" }, "date"] } })
```

**Gate:**

- Any duplicate group **blocks deployment** against this database. The unique
  index cannot be created until they are resolved, and without it every
  rate-limited route answers `503 rate_limit_unavailable`.
- An `expiresAt` that is not a date is reviewed, but blocks nothing: such
  counters are never cleaned up by the TTL index.

**A13. Pages using the reserved `account` slug, in any case or with
whitespace.** Such a page would clash with `/account/*`.
`pageSlugSchema` rejects new ones; existing ones must be renamed by their
owners or by an approved data fix.

```js
db.pages.find({ slug: /^\s*account\s*$/i }, { business: 1, status: 1, title: 1, slug: 1 })
```

**Gate:** any match blocks turning the flag on, until the page is renamed.

**A14. Database permissions and index-build capacity.**

- **Preflight user:** `read` on the app database only.
- **App user:** it does not need `createIndex`, because the app creates no
  indexes on this database (see "Automatic collection and index creation").
  `readWrite` includes it, so a custom role is what actually removes it.
  - **The Part A operator cannot prove what it has.** A `read`-only session can
    show its own privileges, but not another user's.
  - **Who confirms it:** the environment owner or a database administrator,
    in writing, through an approved administrative method. Examples are the
    hosting provider's database-access page (for example Atlas "Database
    Access") or `db.getUser("<app user>")` run by an administrator who is
    allowed to view users.
  - **What the confirmation states:** the application user's name, its
    roles, and the database they apply to.
  - **No secrets:** it never includes the password or connection string.
- **Index operator:** a separate account that can create indexes on the two
  collections, used only for Part B.
- **Capacity:**
  - Index builds on populated collections run online (MongoDB 4.2 and
    later), but take short exclusive locks at the start and end.
  - From 4.4 they wait for all voting, data-bearing members
    (`commitQuorum`), so check that every member is healthy.
  - Use the A4 sizes to choose a low-traffic window, and check any
    hosting-tier limits on index count or build size.

**Gate:**

- No written confirmation of the app user's roles blocks deployment.
- A missing index-operator account, an unhealthy replica-set member or no
  agreed build window blocks Part B.

#### What each Part A result blocks

| Blocks | Results |
|---|---|
| **Everything** | A0: the target is not positively the approved non-production database. |
| **Deployment** of the app against this database (so also the whole runbook) | A1: below 4.4 or standalone. A2: option on `ratelimits`. A3: index conflict on `ratelimits`. A12: duplicate rate-limit keys. A14: app user without `createIndex`, or its roles not confirmed in writing. |
| **Part B** (index creation) | A2: option on `customers` or `customeractiontokens`. A3: index conflict on those collections. A5: exact duplicates. A9: missing or wrong-type keys. A11: duplicate, missing or malformed `tokenHash`. A14: operator, member health or build window. |
| **Turning the flag on** | A2: unreviewed option on `pages`. A6: normalised duplicates. A7: unreviewed non-ASCII emails. A8: non-normalised emails. A10: undecided legacy records. A11: an `expiresAt` that is not a date. A13: `account` pages. |
| Nothing (information only) | A4: sizes. A12: an `expiresAt` that is not a date. |

#### If the database has already been used

Do not assume this is the first deployment. A staging database may already
have served a deployment of the app, even an older build or a short trial.
In that case:

- **Automatic creation has probably already happened.** Most collections and
  their indexes, including `ratelimits`, may exist because earlier app
  processes created them. Part A inspects that **existing** state: A3 shows
  the indexes that are actually there, and A12 shows duplicates that may
  already be breaking rate-limited routes.
- **Customer data may exist.** If `CUSTOMER_ACCOUNTS_ENABLED` was ever on
  there, `customers` and `customeractiontokens` may contain records, and
  even indexes created by someone else. Run A4 to A11 on whatever exists,
  and plan Part B from what A3 found.
  - An index with exactly the intended keys, options and name makes the
    matching Part B command unnecessary. Record it and skip that command.
  - Any difference, including the same keys under another name, is an A3
    conflict.
- **What the deployment gate means here.** "Blocks deployment" means: do not
  deploy the **build under test** (identified as in the runbook, section 4,
  "Build identity") against this database until the result is cleared. It
  also means: report the problem for the deployment that already runs
  there. The runbook does not stop or change an existing deployment;
  turning it off or replacing it is the environment owner's decision.
- **Record the history.** Note which build last ran against the database,
  if known, and whether the flag was ever enabled there. Both go into the
  evidence log at step 0.

### Indexes

| Collection | Index | Status | Purpose |
|---|---|---|---|
| `customers` | `{ business: 1, email: 1 }`, unique | **Required** | One account per store and email, so concurrent registrations cannot create duplicates. Every lookup by (store, email) uses it: register, login, resend, forgot and the known-device check. |
| `customeractiontokens` | `{ tokenHash: 1 }`, unique | **Required** | Verify and reset look a token up by its hash; one hash maps to exactly one token. |
| `customeractiontokens` | `{ business: 1, customer: 1, type: 1 }` | Recommended | Issuing a token cancels the earlier open tokens of that (store, customer, type). A reset closes every open token of (store, customer), which uses the first two fields of this index. |
| `customeractiontokens` | `{ expiresAt: 1 }`, `expireAfterSeconds: 0` | Recommended | Cleanup only. Expiry is always checked in code. |
| `customers` | `{ business: 1 }` and `{ email: 1 }` | **Not needed** | The compound index already covers lookups by store, and no customer flow looks up by email alone. They are declared in the schema but not built, because `autoIndex` is off for this model. |
| `ratelimits` | `{ key: 1 }` unique, and `{ expiresAt: 1 }` TTL | **Required** (the TTL is recommended) | Correct counting and cleanup of rate-limit counters. The app only checks for the unique one, and creates neither: see `docs/database-preparation.md`. |

### Part B: index creation (writes, NOT performed)

Preconditions for **each** command:

1. Part A finished, and nothing in the "Everything", "Deployment" or
   "Part B" rows of "What each Part A result blocks" is open.
2. A written approval for **this** command.
3. A0 repeated immediately before it, in the same session, with written
   confirmation that the target is not production.
4. Run as the index operator, one command at a time.

```js
// B1 (required)
db.customers.createIndex({ business: 1, email: 1 }, { unique: true, name: "business_1_email_1" })
// B2 (required)
db.customeractiontokens.createIndex({ tokenHash: 1 }, { unique: true, name: "tokenHash_1" })
// B3 (recommended)
db.customeractiontokens.createIndex({ business: 1, customer: 1, type: 1 }, { name: "business_1_customer_1_type_1" })
// B4 (recommended)
db.customeractiontokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "expiresAt_1" })
```

- **Names.** They match MongoDB's default names for the indexes declared in
  the models, so a later, explicit synchronisation recognises them.
- **Verify after each command.** `getIndexes()` must show the index with the
  expected `unique` or `expireAfterSeconds`.
- **Stop on an error:**
  - `E11000` means duplicates; go back to A5 or A11.
  - `IndexOptionsConflict` or `IndexKeySpecsConflict` means a conflicting
    index; go back to A3.
- **Never drop or replace an index here.** That, and any data fix, is a
  separate, approved write.
- **Rollback** (`dropIndex(name)`) is also a separate, approved write. Turn
  `CUSTOMER_ACCOUNTS_ENABLED` off before dropping B1 or B2; without them,
  concurrent registrations can create duplicate accounts.

### Automatic collection and index creation

Off for any persistent database. The policy, and everything an operator must
create, is in `docs/database-preparation.md` → "Automatic index policy". This
has **not been tested against a real database**. For customer accounts:

- **`Customer` and `CustomerActionToken` opt out everywhere.** They set
  `autoIndex: false` and `autoCreate: false`, so their collections appear only
  on the first insert, or when Part B creates their indexes.
- **Scripts follow the same rule.** They connect through `dbConnect`, so
  running one against a shared database creates no index, and it refuses to
  work if the core indexes are missing.
- **The rate limiter only checks.** On the first rate-limited request in each
  process, `ensureRateLimitIndexes` (`lib/rate-limit.ts`) looks for a unique
  `{ key: 1 }` index. Without one, or if the database cannot say, every
  rate-limited route answers `503 rate_limit_unavailable`, customer accounts,
  platform sign-in, pages, media, domains, planning and the storefront cart and
  order limits included. It looks again on the next request, so creating the
  index needs no restart.
- A production request without the trusted IP header is a separate case:
  503 `rate_limit_misconfigured`.
- **Local databases still build by themselves** (development or test, on this
  machine only). Mongoose's failures there are silent: a failed build leaves
  the app running without that index, so check `getIndexes()` if something
  behaves oddly.

## Before enabling (checklist)

1. Run the read-only preflight (Part A above). Resolve duplicates, legacy
   records and `account` pages through separately approved fixes.
2. Create and verify the required indexes (Part B), each with its own
   approval and a fresh non-production confirmation.
3. Production email: `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM`
   (a verified sender domain) and an https `APP_URL`. Send a real test email.
4. `TRUSTED_IP_HEADER` set to a header the proxy overwrites, and the proxy
   must preserve `Host`, which the Origin check compares against.
5. `ROOT_DOMAINS` / `NEXT_PUBLIC_ROOT_DOMAIN` set, so links point at the real
   storefront host.
6. Log alerts on `event=email_delivery_failed`,
   `event=background_task_failed` and `event=after_fallback_used`. The last
   one should never occur in production; if it does, background work is
   running outside Next's `after()`.
7. Decide whether best-effort `after()` delivery is acceptable, or add a
   durable outbox first.
8. Pass the staging smoke test
   ([customer-accounts-staging-runbook.md](customer-accounts-staging-runbook.md)).
9. Enable `CUSTOMER_ACCOUNTS_ENABLED=true` for a pilot first, and watch the
   logs.

## Known limitations

- Storefront pages show a small shopping bar (All products, Sign in or
  Account, Cart) above every theme; themes themselves are untouched.
- Account pages: dashboard (`/account`), orders (`/account/orders`, the newest
  50), one order (`/account/orders/[orderId]`) and profile (`/account/profile`:
  name, phone, password). They follow the active theme (`layout.account`,
  `accountVars`). There are no saved addresses, no change of email and no
  paging past the newest 50 orders. Orders placed while signed in are tied to the account
  (`Order.customer`); cash on delivery is available to verified customers of
  stores that enabled it (see `docs/ecommerce-payments-status.md`).
- Order history is queried by `{ business, customer }` without a dedicated
  index: the app declares no index for it, so nothing is built automatically.
  Before large stores use it, create
  `db.orders.createIndex({ business: 1, customer: 1, createdAt: -1 }, { partialFilterExpression: { customer: { $exists: true } }, name: "business_1_customer_1_createdAt_-1" })`
  through the approved index procedure (Part B rules).
- Per-business Razorpay (online payment) is not implemented.
- Browsers without a current known-device marker can be kept locked out,
  renewed every hour, by 10 or more attacking sources. After a password
  reset this includes every browser except the one that reset. Known devices
  and password recovery still work (see "Residual lockout risk").
- Delivery after the response is best-effort. A lost registration task means
  the account was never created; the customer must register again.
- The real Next `after()` path has not run in automated tests.
- `me`, logout and `requireCustomer` use the host lookup without the
  published/entitlement gate. Future customer routes that write data must use
  `resolveCommerceBusiness`.
- Links always use the subdomain origin. A customer of a custom-domain store
  signs in on the subdomain, and the host-only cookie does not carry over.
