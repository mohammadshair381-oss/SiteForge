# Customer accounts: staging smoke-test runbook

> **Status: PLANNED. Nothing in this runbook has been executed.** No staging
> environment has been confirmed, no database has been inspected, no index
> has been created and no email has been sent. Record each result in the
> evidence log (section 7) as you go, and never mark a step as passed from
> memory.

This runbook checks storefront customer accounts in **staging only**, against
a real Next.js runtime, a real MongoDB replica set and a sandbox email
provider. Background and design: [customer-accounts.md](customer-accounts.md).

**Written against:** Next.js 15.5.27, Mongoose 8.24.5, and the code as of the
password-bound known-device markers. If the code has changed since then,
re-check the expected results before starting.

**What it covers:** the real Next `after()` path, real email delivery, HTTPS
cookies in real browsers, and tenant isolation on real hosts.

**What it does not cover:**

- the distributed lockout (10 or more client addresses), which only the
  automated tests cover;
- a process or instance being stopped during background work;
- load.

## 1. Roles

| Role | Responsibilities |
|---|---|
| Approver | Gives the written approvals in section 2. |
| Environment owner | Sets staging environment variables, deploys, redeploys and restarts. Never pastes secret values into the ticket. |
| Database owner | Runs the read-only preflight and the approved index commands, and makes the read-only observations in this runbook. |
| Operator | Runs the HTTP and browser steps and keeps the evidence log. |

One person may hold several roles, but each approval stays separate.

## 2. Approvals

All approvals are written and given before the step that needs them. None of
them covers production. If any step would touch production, it is out of
scope. **Every write this runbook causes is covered by one of these
approvals. A write that no approval covers is out of scope: stop.**

| # | Approval | Covers these writes | Needed before |
|---|---|---|---|
| AP1 | The target is **staging**. The approval names the storefront and platform hosts, the deployment, the database cluster and the database. | None (identification only). | Anything |
| AP2 | Starting the staging deployment against the staging database. | Collections and indexes the app creates on its own when it starts and on its first requests (customer-accounts.md, "Automatic collection and index creation"), including the `ratelimits` indexes. | Step 0, sub-step 4 |
| AP3 | The read-only database preflight (customer-accounts.md, Part A). | None. | Step 0, sub-step 2 |
| AP4 | Each index creation in Part B, one approval per command. | One index, plus the collection it creates. | Step 0, sub-step 3 |
| AP5 | Writing test data in staging. | Rate-limit counters (from the step-0 login probe onward), customers, action tokens, carts and orders created by the steps, and the changes the steps make to them (verification, logout, reset, cancellation). | Step 0, sub-step 5 |
| AP6 | Turning `CUSTOMER_ACCOUNTS_ENABLED` on in staging, and off again. | Staging configuration only. | Steps 2 and 14 |
| AP7 | Setting an invalid `EMAIL_API_KEY` in staging for a short time, then restoring it. | Staging configuration only. | Step 9 |
| AP8 | Deleting the test data, with the counts from step 16. | Only the records matched by the step-16 filters. | Step 16, deletion sub-step |
| AP9 | **Only if the environment owner cannot provide prepared test stores** (section 4, "Stores"): creating stores A and B and their owner accounts through the platform UI. The approval must also name the supported, approved process that gives each store an active subscription. | Platform users, businesses, products and pages created through the UI, and the platform verification emails sent to their test inboxes. Never through `seed` or `create-admin`. | Step 0, sub-step 7 |

Approvals for data fixes found by Part A are outside this runbook. Each one
is a separate write, approved on its own (customer-accounts.md, "Ground
rules").

## 3. Stop conditions

Stop the run if **any** of these happens, in any step:

- a host, deployment or database that is not the approved staging one;
- a connection string, password, key or cookie value taken from anywhere but
  the approved staging secret store or the test itself (section 5.7);
- an unexpected 5xx response;
- a 409 `conflict` from a platform rate-limited route. This can mean the
  `ratelimits` unique index could not be built (customer-accounts.md,
  "Automatic collection and index creation");
- the log line `[after-response] event=after_fallback_used`;
- `event=background_task_failed`;
- `event=email_delivery_failed` outside step 9;
- a token, email address, password, password hash, API key or cookie value in
  the **application** logs (hosting access logs: see step 10);
- a request for one store accepted with another store's cookie, token or
  origin;
- a customer cookie accepted by the platform, or a platform session affected
  by a customer action;
- an email sent to an address that is not a team-controlled test inbox;
- the step's own "Stop if" conditions.

**When you stop:**

1. Turn the flag off (step 14), unless it is already off.
2. Record the step, time, request and result in the evidence log, with cookie
   and token values removed.
3. Do not retry, change data or change configuration on the spot. Report and
   wait for review.

An unexpected **429** alone is not a stop condition: check the rate-limit
budget (section 5.3) first. **Exception:** where a step defines one exact
expected response, that step's rule overrides this paragraph for that
request. This applies to the step-0 login probe (step 0, sub-step 5), which
must return exactly 401 and stops on a 429.

## 4. Staging environment

Set by the environment owner. Values are never pasted into the ticket.

| Setting | Requirement |
|---|---|
| Build | `next build` and `next start`, or a Vercel preview deployment, built in CI or a clean checkout. Never next to a development server, which shares `.next`. |
| Build identity | The project is **not** under version control, so the exact build under test must be identified another way. Before step 0, the environment owner records: a SHA-256 checksum of the source archive or build artifact that was deployed; how it was produced; and the hosting provider's deployment identifier, for example the Vercel deployment ID or URL. Every redeploy in this runbook (steps 2, 9 and 14) must deploy the **same** artifact. Record each new deployment identifier with the same checksum. Do not initialise a repository or change version-control settings for this runbook. |
| Existing deployment | State whether any deployment of the app already runs, or has run, against the staging database, and which build it was (if known). See customer-accounts.md, "If the database has already been used". |
| `NODE_ENV` | `production` (set by `next start` and by Vercel). The steps expect production behaviour: `__Host-` cookies, https-only origins, and no `console` or `memory` email. |
| `MONGODB_URI` | The approved staging **replica set**, MongoDB 4.4 or later. Never the production cluster. Set by the environment owner from the staging secret store, never from `.env.local` or `.env`. |
| `SESSION_SECRET` | New, staging-only, at least 32 characters. Never copied from production or development. |
| `ROOT_DOMAINS`, `NEXT_PUBLIC_ROOT_DOMAIN` | The staging root domain, plus its `www.` host if used. |
| `TRUSTED_IP_HEADER` | `x-vercel-forwarded-for` on Vercel. Elsewhere, a single-value header that the staging proxy overwrites. The proxy must keep the `Host` header. |
| `EMAIL_PROVIDER` | `resend` |
| `EMAIL_API_KEY` | A staging-only key. |
| `EMAIL_FROM` | An address on a sender domain verified for staging. |
| `APP_URL` | The staging platform URL, starting with `https://`. |
| `PAYMENT_PROVIDER` | `manual` |
| `CUSTOMER_ACCOUNTS_ENABLED` | **Unset** at the start. Only step 2 turns it on. |
| TLS | A valid certificate for the staging root and `*.<staging-root>`. Email links use `https://<store-subdomain>.<staging-root>`. |
| Stores | Two **existing, prepared** test stores, **A** and **B**, provided by the environment owner. Each must be published, have an **active subscription**, have at least one active product in stock, and have a platform owner test account whose inbox is team-controlled. **Preferred:** the environment owner provides them. **Otherwise:** they may be created only through the platform UI under AP9, never with `seed` or `create-admin`. **Subscriptions:** `PAYMENT_PROVIDER=manual` does **not** activate a subscription by itself. This runbook does not enable `ALLOW_MANUAL_BILLING` and does not bypass subscription checks. If no supported, approved process for an active subscription is named, the stores cannot be prepared: stop. **After cleanup:** stores A and B, their products and their owner accounts **remain** in staging. Step 16 does not delete them, and removing them is a separate decision outside this runbook. |
| Inboxes | Team-controlled test inboxes only, never real customers. **Required pattern:** every test inbox, `<qa1>` to `<qa6>`, has the form `qa+<label>@<team-domain>`. `<label>` is chosen by the operator (for example `a1`), and `<team-domain>` is the team's own mail domain, supplied by the environment owner. Write them in lower case. The step-16 cleanup guard checks exactly this pattern, and step 10 searches for `qa+`. The domain must accept plus-addressed mail. If it does not, stop: changing the pattern needs a reviewed change to this runbook **and** to the cleanup guard. Resend offers test addresses that simulate delivery events. Whether their message content and links can be opened has not been checked, so they are not relied on here. |
| Logs | Searchable application logs **and** the hosting provider's access logs. |
| Database access | A read-only user for the database owner's observations. A separate cleanup account, which can delete, is used only in step 16. The **application's** database user and its roles are confirmed in writing by the environment owner or a database administrator (customer-accounts.md, A14). The read-only operator cannot prove them. |
| Networks | One tester network is enough. A second one (for example a mobile hotspot) is needed only for the optional checks 8.5 and 13.2. |

## 5. Conventions

### 5.1 Shorthand

```sh
A=https://<store-a>.<staging-root>    # storefront A
B=https://<store-b>.<staging-root>    # storefront B
P=https://<staging-root>              # platform
J='content-type: application/json'
```

- **Origin header.** `curl` sends no `Origin` header, which the routes
  accept. Browsers send one, and in production it must be
  `https://<the same host>`.
- **Cookie jars.** Use one cookie jar per simulated browser
  (`-c jar1 -b jar1`), or send cookies explicitly with `-H 'cookie: …'`.
- **Test inboxes and passwords.** `<qa1>` to `<qa6>` are distinct test
  inboxes, each of the form `qa+<label>@<team-domain>` in lower case (section
  4, "Inboxes"). `<pw1>`, `<pw2>` and `<pw3>` are test-only passwords of at
  least 8 characters.
- **Store IDs for database checks.** The database owner finds a store's id
  with `db.businesses.findOne({ subdomain: "<store-a>" }, { _id: 1 })._id`.

### 5.2 Evidence and redaction

- **Record** status codes, response bodies, the names and attributes of
  headers, log lines and counts.
- **Remove** cookie values, tokens, link query strings and email addresses
  before saving evidence. Never paste a verification or reset link.
- **Decode markers locally only** (step 7):
  `node -e "console.log(Buffer.from(process.argv[1].split('.')[1],'base64url').toString())" '<marker>'`.
  Never upload a decoded marker.

### 5.3 Rate-limit budget for testers

All requests from one network share one client address. Limits are per store,
in fixed, clock-aligned windows:

| Action | Per client address | Per (email, address) | Per email |
|---|---|---|---|
| Register | 10 per 15 min | 5 per 15 min | 5 emails per hour (silent) |
| Login | 20 per 15 min, all attempts | 5 failures per hour | 50 failures per hour. A known device instead gets 5 failures per hour of its own. |
| Resend and forgot (one shared bucket) | 10 per hour | 3 per hour per kind | 3 emails per hour per kind (silent) |
| Verify and reset | 20 per 15 min | — | — |

The steps are ordered to stay inside these budgets. Store A uses up to 9 of
its 10 resend and forgot requests per hour; step 9 therefore runs on store B,
and step 13 deliberately uses up the login budget. If a 429 is explained by
this table, wait the number of seconds in `Retry-After` and continue.

### 5.4 Expected bodies

| Case | Status | Body |
|---|---|---|
| Feature off, or store unavailable | 404 | `{"error":"This store is not available","code":"not_found"}` |
| Register, resend, forgot | 202 | `{"message":"If an account can be created or recovered with this email, we will send instructions to it. If nothing arrives within a few minutes, check your spam folder or try again."}` |
| Login, success | 200 | `{"customer":{"name":"…","emailVerified":true}}` |
| Login, wrong password or unknown email | 401 | `{"error":"Invalid email or password","code":"invalid_credentials"}` |
| Login, email not confirmed | 403 | `{"error":"Please confirm your email address first. We can send you a new link.","code":"customer_email_unverified"}` |
| Verify, success | 200 | `{"message":"Your email address is confirmed. You can now sign in."}` |
| Verify, wrong password | 400 | `{"error":"That password does not match this account. If you did not choose it, reset your password instead.","code":"invalid_password"}` |
| Verify or reset, bad link | 400 | `{"error":"This link is invalid or has expired. Request a new one.","code":"invalid_token"}` |
| Reset, success | 200 | `{"message":"Your password has been changed. Please sign in."}` |
| Logout | 200 | `{"ok":true}` |
| Me | 200 | `{"customer":null}` or `{"customer":{"name":"…","email":"…","emailVerified":true}}` |
| Rate limited | 429 | `{"error":"Too many requests. Please try again later.","code":"rate_limited"}`, with a `Retry-After` header |
| Wrong origin | 403 | `{"error":"Request origin verification failed","code":"csrf_failed"}` |
| Not JSON | 415 | `{"error":"Expected a JSON request","code":"unsupported_media_type"}` |

Every customer-account response carries `Cache-Control: no-store`.

### 5.5 Cookies (production)

| Cookie | Set by | Attributes |
|---|---|---|
| `__Host-sf_customer` (session) | Login | `Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800` (7 days) |
| `__Host-sf_device` (known-device marker, never a session) | Login, password reset | `Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=7776000` (90 days) |
| `__Host-sf_customer=` (cleared) | Logout | `Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0` |

Neither cookie has a `Domain` attribute, so each is sent only to the host
that set it.

### 5.6 Log lines

| Line | Meaning |
|---|---|
| `[after-response] event=after_fallback_used operation=<label> reason=<ErrorName> durable=false` | Background work did not run through Next's `after()`. Never expected: stop. |
| `[customer-auth] event=background_task_failed operation=<register\|resend\|forgot> category=<category>` | A background task failed: stop. |
| `[customer-auth] event=email_delivery_failed operation=<verification\|password-reset\|account-exists> category=<category>` | The provider did not accept an email. Expected only in step 9. |
| `[customer-auth] event=email_suppressed operation=<register\|resend\|forgot> reason=address_rate_limited` | Warning: the per-email cap was reached, so nothing was sent. |
| `[customer-auth] event=request_failed category=<category>` | A request failed unexpectedly (500): stop. |

Categories: `email_configuration`, `email_provider_unreachable`,
`email_provider_unavailable`, `email_provider_rejected`, `database`,
`unknown`, `http_<status>`.

### 5.7 Connections, secrets and scripts

- **Connection strings.** Every database connection string comes only from
  the approved staging secret store, for the account the task needs:
  read-only for observations, index operator for Part B, cleanup account for
  step 16. **Never** take it from `.env.local`, `.env` or a developer
  machine. `.env.local` may hold real credentials, and the project's scripts
  load it first.
- **One target per session.** Run A0 (customer-accounts.md) at the start of
  every database session. Never switch a session to another cluster.
- **No project scripts.** Do not run `npm run seed`, `npm run create-admin`
  or `npm run domain-migration` for this runbook, for example to create
  stores or owner accounts. Those need a separate written approval **and** an
  explicitly checked staging `MONGODB_URI` in that shell. They load models,
  so even a dry run can create collections and indexes.
- **Nothing secret in shell history.**
  - Start `mongosh` without a password on the command line and type it at
    the prompt.
  - For `curl`, read test passwords, cookie values and tokens into shell
    variables with `read -rs`, so only the variable name is recorded:

    ```sh
    read -rs PW1    # type <pw1>, then Enter; nothing is echoed
    curl -s -i -X POST "$A/api/storefront/account/login" -H "$J" \
      --data-raw '{"email":"<qa1>","password":"'"$PW1"'"}'
    ```

  - Wherever a command in this runbook shows `<pw1>`, `<pw2>`, `<pw3>`,
    `<S0>`, `<M0>`, `<A session>` or a token, use such a variable.
  - If a secret was typed into a command by mistake, clear that history
    entry, and rotate the secret if it is a real credential.
- **Checkout email.** Use the test inbox `<qa6>` as the guest checkout email
  in step 15. Step 16 identifies the test order through it.

### 5.8 Read-only database observations

The database owner runs these in `mongosh` as the **read-only** user, after
A0 in the same session. They print no email address, password hash, token
hash or guest token. Only `aggregate` with `$match`, `$project`, `$group` and
`$sort`, plus `find`, `findOne` and `countDocuments`, are used, so nothing is
written.

```js
// Once per session. The test inboxes are lower-case, exactly as registered.
var storeA = db.businesses.findOne({ subdomain: "<store-a>" }, { _id: 1 })._id
var storeB = db.businesses.findOne({ subdomain: "<store-b>" }, { _id: 1 })._id
var qa = ["<qa1>", "<qa2>", "<qa3>", "<qa4>", "<qa5>"]

// O1. Test customers of one store (use storeA or storeB). inbox 1 = <qa1>, 2 = <qa2>, ...
db.customers.aggregate([
  { $match: { business: storeA, email: { $in: qa } } },
  { $project: { inbox: { $add: [{ $indexOfArray: [qa, "$email"] }, 1] }, active: 1, emailVerifiedAt: 1, tokenVersion: 1, user: 1, createdAt: 1 } },
  { $sort: { inbox: 1 } }
])

// O2. Action tokens of the test customers of one store. Match `customer` to the _id from O1.
var testIds = db.customers.find({ business: { $in: [storeA, storeB] }, email: { $in: qa } }, { _id: 1 }).toArray().map(d => d._id)
db.customeractiontokens.aggregate([
  { $match: { business: storeA, customer: { $in: testIds } } },
  { $project: { _id: 0, customer: 1, type: 1, open: { $not: [{ $ifNull: ["$usedAt", false] }] }, expiresAt: 1, createdAt: 1 } },
  { $sort: { customer: 1, createdAt: 1 } }
])

// O3. Totals for both stores (compare before and after a step).
db.customers.countDocuments({ business: { $in: [storeA, storeB] } })
db.customeractiontokens.countDocuments({ business: { $in: [storeA, storeB] } })

// O4. Accounts per store for one test inbox (step 12).
db.customers.aggregate([
  { $match: { email: "<qa5>", business: { $in: [storeA, storeB] } } },
  { $group: { _id: "$business", accounts: { $sum: 1 } } }
])

// O5. Test orders of store A (checkout email <qa6>): lifecycle fields only, no email or guest token.
db.orders.aggregate([
  { $match: { business: storeA, customerEmail: "<qa6>" } },
  { $project: { orderNumber: 1, status: 1, inventoryState: 1, cancelledAt: 1, inventoryReleasedAt: 1 } }
])
```

- **Stop** if `findOne` returns `null`, which makes `._id` throw: wrong store
  or wrong database.
- Record the results in the evidence log. `_id` values of test records may
  be recorded; nothing else identifies a person.

## 6. Procedure

Each step lists what to do, the expected result, and when to stop, in
addition to the conditions in section 3.

### Step 0. Prerequisites

**Do:**

1. Collect AP1 and AP3, and the environment owner's inputs:
   - the build identity (section 4, "Build identity");
   - whether a deployment already uses the staging database (section 4,
     "Existing deployment");
   - the application database user's roles (section 4, "Database access").

   The connection string comes from the staging secret store (section 5.7).
2. The database owner runs Part A of customer-accounts.md on the staging
   database.
   - If the database has already been used by a deployment, follow "If the
     database has already been used" in that document.
   - Results in the "Everything", "Deployment" and "Part B" rows of "What
     each Part A result blocks" are resolved first, each through a
     separately approved fix.
3. With AP4, the database owner runs Part B. Each command has its own
   approval, and A0 is repeated immediately before it, with written
   confirmation that the target is not production.
4. With AP2, the environment owner configures section 4, with the flag
   **unset**, and deploys the identified build. They record the deployment
   identifier next to the build checksum.
5. With AP5, run the platform rate-limit probe. It writes rate-limit
   counters. The app creates no index: the `ratelimits` indexes must already
   exist (`docs/database-preparation.md`), or this answers
   `503 rate_limit_unavailable`:

   ```sh
   curl -s -i -X POST "$P/api/auth/login" -H "$J" \
     --data-raw '{"email":"<owner-test>","password":"not-the-password"}'
   ```

6. The database owner runs `db.ratelimits.getIndexes()`.
7. Confirm stores A and B (section 4, "Stores"). They are either provided
   ready by the environment owner, or created through the platform UI under
   AP9.
   - Open `$A` and `$B`: each storefront home page loads.
   - Sign in to the platform as each owner test account. The dashboard shows
     the store as published, with an active subscription and an active
     product in stock.
   - Record which way the stores were provided.

**Expect:**

- No result in the "Everything", "Deployment" or "Part B" rows is open.
- B1 and B2 exist with `unique: true`. If they were approved, B3 exists and B4
  has `expireAfterSeconds: 0`.
- The deployment starts without startup-validation errors. Its identifier
  and build checksum are recorded.
- The probe gets **exactly 401** `{"error":"Invalid email or password","code":"invalid_credentials"}`.
  The platform login applies its rate limits first, then rejects the wrong
  password (`app/api/auth/login/route.ts`).
- `ratelimits` has a unique `{ key: 1 }` index and a TTL `{ expiresAt: 1 }`
  index.
- Both stores meet every requirement in section 4, "Stores".

**Stop if:**

- the build identity, the existing-deployment answer or the written
  confirmation of the application user's roles is missing;
- any open blocking Part A result, or any index error;
- startup validation fails;
- the probe returns anything other than 401 `invalid_credentials`. This exact
  rule **overrides** the general 429 paragraph in section 3 for this probe:
  - **409** `conflict` most likely means duplicate `ratelimits` keys stopped
    the unique index (go back to A12);
  - **500** means another index or database error;
  - **503** means a missing unique index or a missing trusted IP header;
  - **429** is a stop here: other traffic may share the address. Find out
    why. After review, the probe may be repeated once, and it must then
    return exactly 401;
  - any other status is unexpected;
- `ratelimits` lacks either index;
- a store is not published, has no active subscription or no product in
  stock;
- preparing a store would need `seed`, `create-admin`, `ALLOW_MANUAL_BILLING`
  or any bypass of subscription checks.

### Step 1. Flag off (default)

**Do:**

```sh
for r in register login logout email/verify email/resend password/forgot password/reset; do
  curl -s -i -X POST "$A/api/storefront/account/$r" -H "$J" -d '{}'
done
curl -s -i "$A/api/storefront/account/me"
```

Then open `$A/account/login`, `/account/register`, `/account/forgot-password`,
`/account/reset-password` and `/account/verify-email` in a browser.

**Expect:**

- Every API call returns **404** with the `not_found` body,
  `Cache-Control: no-store`, and no `Set-Cookie`.
- Each page shows the 404 page.
- No `[customer-auth]` log lines.
- The database owner sees `db.customers.estimatedDocumentCount()` and
  `db.customeractiontokens.estimatedDocumentCount()` unchanged since Part A.

**Stop if:** any status other than 404, any `Set-Cookie`, or a page renders a
form.

### Step 2. Turn the flag on, in staging only

**Preconditions:** steps 0 and 1 passed; AP5 and AP6 given; no result in the
"Turning the flag on" row of "What each Part A result blocks"
(customer-accounts.md) is open.

**Do:**

1. The environment owner sets `CUSTOMER_ACCOUNTS_ENABLED=true` in the
   **staging** environment only.
2. They redeploy (on Vercel, environment changes need a new deployment) or
   restart (`next start`).
3. Run `curl -s -i "$A/api/storefront/account/me"`.

**Expect:** **200** `{"customer":null}` with `Cache-Control: no-store`.

**Stop if:**

- it is still 404 after the redeploy (wrong environment or deployment);
- any 5xx;
- the variable appears in a production environment.

### Step 3. Registration and the real `after()` path

**Do:**

1. Register `<qa1>` on store A:

   ```sh
   curl -s -i -X POST "$A/api/storefront/account/register" -H "$J" \
     -d '{"name":"QA One","email":"<qa1>","password":"<pw1>"}' -w '\ntime_total=%{time_total}\n'
   ```

2. Wait up to 5 minutes, then check the `<qa1>` inbox and the logs.
3. The database owner runs O1 and O2 (section 5.8) for store A.

4. Register `<qa1>` again on store A, this time with `<pw2>`.

**Expect:**

- **Registration (sub-step 1):**
  - **202** with the generic body, `no-store`, and no `Set-Cookie`.
  - The email "Confirm your email for <Store A name>" arrives at `<qa1>`. Its
    link points to `https://<store-a>.<staging-root>/account/verify-email#token=…`.
    Do not record the token.
  - The logs have no `after_fallback_used`, `background_task_failed` or
    `email_delivery_failed` line.
- **Database (sub-step 3):**
  - O1 shows one customer, `inbox: 1`: `active: true`,
    `emailVerifiedAt: null`, `tokenVersion: 0`, `user: null`.
  - O2 shows one token for it: `type: "email_verification"`, `open: true`,
    `expiresAt` about 24 hours ahead.
- **Why this proves `after()` ran the work.** In production, the app logs
  `after_fallback_used` every time it has to fall back. The account and the
  email exist and that line is absent, so the task ran through Next's
  `after()`.
- **Re-registration (sub-step 4):**
  - **202** with an identical body.
  - The email "You already have an account at <Store A name>" arrives, saying
    the confirmation is still pending.
  - O1 and O2 still show one customer and one open verification token. Step
    4 shows that `<pw1>` is still the password.

**Stop if:**

- no email arrives within 5 minutes;
- any of the three log lines appears;
- there is more than one customer, or the token is of another type;
- the link does not point to store A's https subdomain.

### Step 4. Email verification

**Do:** in browser X, the main test browser:

1. Open the verification link and submit a wrong password.
2. Submit `<pw2>`, the password from the second registration.
3. Submit `<pw1>`.
4. Open the same link again and submit `<pw1>`.

**Expect:**

- Sub-steps 1 and 2 show the `invalid_password` message (400). The link stays
  usable.
- Sub-step 3 shows "Your email address is confirmed. You can now sign in."
  (200).
- Sub-step 4 shows the `invalid_token` message (400).
- O1 shows `emailVerifiedAt` as a date for `inbox: 1`, and O2 shows its
  token with `open: false`.

**Stop if:**

- `<pw2>` verifies the account, which would mean re-registration changed the
  password;
- a wrong password uses up the link;
- the link can be used twice.

### Step 5. Login and logout

**Do:**

1. Register `<qa2>` on store A and do **not** verify it. Then log in with its
   correct password:
   `curl -s -i -X POST "$A/api/storefront/account/login" -H "$J" -d '{"email":"<qa2>","password":"<pw1>"}'`.
2. Log in as `<qa1>` with a wrong password, then as `<qa9>` (no account).
3. Log in as `<qa1>` with `<pw1>`, using a jar:
   `curl -s -i -c jar1 -b jar1 -X POST "$A/api/storefront/account/login" -H "$J" -d '{"email":"<qa1>","password":"<pw1>"}'`.
4. `curl -s -i -b jar1 "$A/api/storefront/account/me"`.
5. Note the session value as S0 and the marker value as M0, locally. Then log
   out:
   `curl -s -i -c jar1 -b jar1 -X POST "$A/api/storefront/account/logout" -H "$J" -d '{}'`.
   Then call `me` with `-H "cookie: __Host-sf_customer=<S0>"`.
6. Call `me` with `-H "cookie: __Host-sf_device=<M0>"`, then with
   `-H "cookie: __Host-sf_customer=<M0>"`.

**Expect:**

- **Sub-step 1:** **403** `customer_email_unverified`, no `Set-Cookie`.
- **Sub-step 2:** **401** twice, with identical bodies and no `Set-Cookie`.
- **Sub-step 3:** **200** `{"customer":{"name":"QA One","emailVerified":true}}`,
  with exactly the two `Set-Cookie` headers in section 5.5.
- **Sub-step 4:** **200** `{"customer":{"name":"QA One","email":"<qa1>","emailVerified":true}}`.
- **Sub-step 5:**
  - Logout returns **200** `{"ok":true}`.
  - The response clears `__Host-sf_customer` (`Max-Age=0`) and sends no
    `__Host-sf_device` header.
  - The replayed S0 gets `{"customer":null}`.
  - O1 shows `tokenVersion: 1` for `inbox: 1`.
- **Sub-step 6:** `{"customer":null}` both times.

**Stop if:**

- any cookie attribute differs from section 5.5, or a cookie has a `Domain`
  attribute or lacks the `__Host-` prefix;
- a 401 or 403 sets a cookie;
- S0 still works after logout;
- the marker is accepted as a session.

### Step 6. Known-device budget

Uses `<qa1>` and `<pw1>`.

**Do:**

1. Log in with a fresh jar `jarD`. It now holds marker M1; keep it.
2. With `jarD`, log in 5 times with a wrong password, then once with `<pw1>`.
3. Without any cookie, from the same network, log in with `<pw1>`.
4. The per-address limit is checked in step 13, not here.

**Expect:**

- **Sub-step 2:** five **401** responses. The 6th attempt gets **429**
  `rate_limited` with `Retry-After`, even though the password is correct. No
  `Set-Cookie` on any of them.
- **Sub-step 3:** **200** with new cookies. The decoded marker has a
  different `sub` (device id) from M1. The device's failures did not use up
  the normal per-(email, address) budget.

**Stop if:**

- the 6th attempt succeeds (the device budget is not enforced);
- sub-step 3 gets 429, unless the section 5.3 budget explains it (this step
  needs at most 12 login requests since step 5 began).

### Step 7. Password reset: sessions and old markers

**Preconditions:** start at least **15 minutes after step 6**, or from a
second network, so the per-address login budget is fresh.

**Do:**

1. Register `<qa3>` with `<pw1>` and verify it, as in steps 3 and 4.
2. In browser X, sign in as `<qa3>`. That browser now holds session S1 and
   marker M1. With `curl` and jar `jar7`, sign in too (session S2, marker M2,
   the "other browser").
3. `POST $A/api/storefront/account/password/forgot` with
   `{"email":"<qa3>"}`. The email "Reset your password for <Store A name>"
   arrives; its link expires in 1 hour.
4. Open the link in **browser Y** (a second browser profile) and set
   `<pw2>`. In DevTools, look at the reset response's `Set-Cookie` headers.
   Browser Y now holds marker M3.
5. Call `me` with S1 and with S2.
6. Old-marker check, all from one network:
   1. With `jar7` (M2, now outdated), log in 5 times with a wrong password.
   2. Without any cookie, log in with `<pw2>`.
   3. In browser Y (M3), sign in with `<pw2>`. Then sign out through the
      logout endpoint; there is no storefront sign-out button. On a store A
      page in browser Y, run this in the DevTools console:

      ```js
      await fetch("/api/storefront/account/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status)
      ```

7. In browser Y, sign in with `<pw1>`, then with `<pw2>`.
8. Open the reset link again.
9. Decode M2 and M3 locally (section 5.2).

**Expect:**

- **Sub-step 3:** **202** and the email.
- **Sub-step 4:** "Your password has been changed. Please sign in." The
  response sets `__Host-sf_device` and **no** `__Host-sf_customer`.
- **Sub-step 5:** `{"customer":null}` for both sessions.
- **Sub-step 6:**
  1. **401** five times.
  2. **429**: the outdated marker's failures counted against this address,
     like any client's.
  3. **200**: the new marker keeps its own budget. The logout call returns
     `200`, and browser Y keeps its `__Host-sf_device` cookie.
- **Sub-step 7:** `<pw1>` gets **401**; `<pw2>` gets **200**.
- **Sub-step 8:** the `invalid_token` message (400).
- **Sub-step 9:**
  - Both markers decode to `typ: "customer-device"`,
    `aud: "siteforge:customer-device"` and `iss: "siteforge"`, with `sub`,
    `bid`, `ah`, `cf`, `iat` and `exp`.
  - `cf` differs between M2 and M3.
  - Neither contains an email, password or hash.
- **Database:** run O1 and O2 for store A after sub-step 2, and again after
  sub-step 8.
  - For `inbox: 3`, `tokenVersion` has gone up by at least 2: once for the
    reset and once for the sub-step 6.3 logout.
  - Every token of that customer shows `open: false`.
  - `emailVerifiedAt` is a date.

**Stop if:**

- S1 or S2 still works;
- the reset response sets a session cookie;
- sub-step 6.2 returns 200, meaning the outdated marker still had its own
  budget (the F1 regression);
- sub-step 6.3 returns 429;
- `<pw1>` still works;
- the link works twice;
- a marker contains readable personal data.

### Step 8. Resend and forgot

Store A's resend-and-forgot budget: step 7 used 1 request, and this step uses
up to 8 more.

**Do:**

1. `POST $A/api/storefront/account/email/resend` with `{"email":"<qa2>"}`
   (unverified).
2. Resend for `<qa1>` (verified) and for `<qa9>` (no account).
3. `POST $A/api/storefront/account/password/forgot` for `<qa1>`, then for
   `<qa9>`.
4. From the same network, resend for `<qa2>` two more times, then once more.
5. Optional, from a second network: one more resend for `<qa2>`.

**Expect:**

- **Sub-steps 1 to 3:** every response is **202** with **byte-identical**
  bodies (compare with `diff`).
  - Sub-step 1: a new "Confirm your email for <Store A name>" email; `<qa2>`'s
    older link stops working.
  - Sub-step 2: no email.
  - Sub-step 3: a reset email for `<qa1>` only.
- **Sub-step 4:** the first two get **202**; the next gets **429** (3 per
  hour per email and address).
- **Sub-step 5:** **202**, but no email arrives, and the log shows
  `event=email_suppressed operation=resend reason=address_rate_limited`.
- **Database:** O2 for store A shows exactly one `open: true`
  `email_verification` token for the `inbox: 2` customer from O1.

**Stop if:**

- a body differs between existing and unknown accounts;
- an email is sent for a verified or unknown account;
- sub-step 4 returns anything other than 202, 202, 429.

### Step 9. Email-provider failure (store B)

**Preconditions:** AP7 given. This step runs on **store B**, which has its
own budget.

**Do:**

1. The environment owner sets `EMAIL_API_KEY` to an invalid value, in staging
   only, and redeploys or restarts. Startup validation passes, because a key
   is present.
2. Register `<qa4>` on store B.
3. `POST $B/api/storefront/account/password/forgot` for `<qa4>`.
4. The environment owner restores the key and redeploys. Then resend for
   `<qa4>` on store B.

**Expect:**

- **Sub-step 2:**
  - **202** with the same body as step 3, and no email.
  - The log shows `[customer-auth] event=email_delivery_failed operation=verification category=email_provider_rejected`.
    If the provider answers 5xx or 429, the category is
    `email_provider_unavailable`; if it cannot be reached,
    `email_provider_unreachable`.
  - No `background_task_failed`.
  - O1 and O2 for **store B** show the `inbox: 4` customer, unverified, with
    one `open: true` verification token.
- **Sub-step 3:** **202**, and the log shows
  `… operation=password-reset category=email_provider_rejected`.
- **Sub-step 4:** **202**, and the verification email arrives. The account
  was created even though its first email failed.

**Stop if:**

- the status or body differs from step 3 (the failure is visible to
  customers);
- a log line contains anything other than `event`, `operation` and
  `category`;
- the key appears in a log;
- no log line appears at all (the failure is invisible);
- the key is not restored.

### Step 10. Safe log inspection

**Do:** search the application logs **and** the hosting access logs for the
whole run, for:

- `qa+` (the test inboxes) and other email addresses;
- `token=`, `verify-email?` and `reset-password?`;
- `re_` (the Resend key prefix), `Bearer` and `Authorization`;
- `eyJ` (cookie and marker values);
- `$2a$` and `$2b$` (password hashes);
- the test passwords;
- `sf_customer=` and `sf_device=`.

**Expect:**

- Customer-account lines in the application logs contain only `event`,
  `operation`, `category` and `reason`; `[after-response]` lines also contain
  `durable`.
- The hosting access logs may record page paths. If they also record
  a token, record it as a finding: links now keep it after `#`, which browsers do not send. Links
  are single-use, expire after 24 hours (verification) or 1 hour (reset),
  and are stored only as hashes, so this alone does not stop the run.

**Stop if:** any match in the **application** logs.

### Step 11. HTTPS cookies in real browsers

**Do:** in at least two of Chrome, Firefox and Safari, each with a fresh
profile:

1. Sign in on `$A/account/login` as `<qa1>`.
2. Open DevTools and look at the cookies for `https://<store-a>.<staging-root>`.
3. In the console, run `document.cookie`.
4. Visit `$B` and `$P`, and look at the request headers in the Network tab.
5. Arrive at a `$A/account/...` page from an email link or another site, and
   check that the page's own API calls carry the cookies.
6. Try `http://<store-a>.<staging-root>`.
7. Open a private window and sign in.

**Expect:**

- **Sub-step 2:** both cookies are present, HttpOnly and Secure, with
  `Path=/` and the exact host as domain (no leading dot).
  - The session cookie is SameSite Lax and expires in about 7 days.
  - The marker is SameSite Strict and expires in about 90 days.
- **Sub-step 3:** neither cookie appears.
- **Sub-step 4:** no `sf_*` cookie is sent to B or the platform.
- **Sub-step 5:** the page's same-origin API calls carry both cookies.
- **Sub-step 6:** redirected to https, or not served; no cookie is set over
  http.
- **Sub-step 7:** a new marker, with a different `sub`.

**Stop if:** any attribute differs, a cookie is readable from JavaScript, or a
cookie is sent to another host.

### Step 12. Tenant isolation (stores A and B)

**Do:**

1. Register `<qa5>` on store A with `<pw1>` and on store B with `<pw2>`, and
   verify both.
2. The database owner runs O4 (section 5.8).
3. Log in on A with jar `jarA`. Then call
   `curl -s -i -H "cookie: __Host-sf_customer=<A session>" "$B/api/storefront/account/me"`.
4. Log in on B as `<qa5>` with `<pw1>` (A's password).
5. `POST $B/api/storefront/account/password/forgot` for `<qa5>`. Use B's
   reset token on A:
   `POST $A/api/storefront/account/password/reset` with
   `{"token":"<B token>","password":"<pw1>"}`.
   Then use it on B with a new password, `<pw3>`. This also ends `<qa5>`'s
   sessions on B only.
6. `curl -s -i -X POST "$A/api/storefront/account/login" -H "$J" -H "origin: $B" -d '{"email":"<qa5>","password":"<pw1>"}'`.
   Then the same request with `-H 'content-type: text/plain'` instead of
   `$J`.
7. Call `$P/api/auth/me` with `-H "cookie: __Host-sf_customer=<A session>"`,
   then with no cookie.

**Expect:**

- **Sub-step 2:** two groups, store A and store B, each with `accounts: 1`.
- **Sub-step 3:** `{"customer":null}`.
- **Sub-step 4:** **401**.
- **Sub-step 5:** **400** `invalid_token` on A; then **200** on B, so the
  token was still valid there.
- **Sub-step 6:** **403** `csrf_failed`, then **415**.
- **Sub-step 7:** identical responses: the platform ignores customer cookies.

**Stop if:** any request is accepted across stores, or the platform reacts to
a customer cookie.

### Step 13. The per-address limit applies to known devices

This step uses up this network's login budget on store A for up to 15
minutes, so it runs last.

**Do:**

1. With a valid marker (`jarA` from step 12), send logins to store A with
   the correct password until one gets **429**. Count every login request
   this network sent to store A in the current 15-minute window.
2. Optional: from a second network, log in once.

**Expect:**

- **Sub-step 1:** the request that goes past 20 in the window gets **429**
  `rate_limited` with `Retry-After`, even though it carries a valid marker.
- **Sub-step 2:** **200**.

**Stop if:** more than 20 login requests from one network succeed in one
window.

### Step 14. Turn the flag off

**Preconditions:** AP6 given.

**Do:**

1. The database owner runs O3 (section 5.8) and records both totals.
2. The environment owner unsets `CUSTOMER_ACCOUNTS_ENABLED` (or sets it to
   `false`) in staging, and redeploys or restarts.
3. Repeat step 1.
4. Call `me` on store A with `jarA`. Its session from step 13 is still
   valid.
5. Log in on store A as `<qa5>` with `<pw1>`. The gate answers before any
   rate limit, so step 13's exhausted budget does not matter.
6. The database owner runs O3 again.

**Expect:**

- Exactly as step 1.
- `me` with a valid session gets **404**, not 200.
- The correct-password login gets **404**.
- No new `[customer-auth]` lines.
- Both O3 totals are unchanged between sub-steps 1 and 6.

**Stop if:** any customer route answers with anything other than 404.

### Step 15. Regression checks

Run with the flag **off** (the final state). If time allows, also run once
with the flag on, just before step 14.

**Do:**

1. **Platform login:** `POST $P/api/auth/login` with an owner test account,
   then `GET $P/api/auth/me`, open `$P/dashboard`, and
   `POST $P/api/auth/logout`.
2. **Platform rate limiting:** send failed platform logins until one gets
   429.
3. **Storefront A:** open the home page and a product page, add the product
   to the cart, and complete checkout in the browser. Use the test inbox
   `<qa6>` as the checkout email; step 16 finds the order through it.
4. **Order management:** in the owner dashboard, open Orders.
   1. Find the new order.
   2. Look for "Mark paid". Optionally, as the owner, call
      `PATCH $P/api/businesses/<A id>/manage/orders/<order id>` with
      `{"action":"mark_paid"}`.
   3. Cancel the order.

**Expect:**

- **Sub-step 1:** login **200** with `swb_session` set; `me` returns the
  user; the dashboard loads; logout **200**.
- **Sub-step 2:** **401** `invalid_credentials` every time, and finally
  **429**. A 409 `conflict`, 500 or 503 is a stop condition (see step 0).
- **Sub-step 3:** the cart shows the item, and checkout shows a confirmation.
  These are the same flows as the integration tests `cart-api` and
  `order-creation`.
- **Sub-step 4:**
  1. The order is listed as pending.
  2. "Mark paid" is not offered, and the dashboard says it is available only
     for cash-on-delivery orders, which checkout cannot create yet. The
     optional API call gets 409 `manual_payment_not_allowed`.
  3. Cancelling sets the order to cancelled and restores the stock. O5
     (section 5.8) shows `status: "cancelled"` and
     `inventoryState: "released"`.
- No `[customer-auth]` log lines while the flag is off.

**Stop if:** any of these behaves differently from before customer accounts,
any 5xx, or a platform session is affected by customer cookies.

### Step 16. Cleanup

**Preconditions:** the flag is off (step 14). Deleting needs AP8, given
**after** the counts in sub-step 3. The approver may instead decide, in
writing, to keep the test data in staging; then skip sub-steps 2 to 5.

**Scope.** Only these records may be deleted:

- customers of stores A and B whose email is one of the test inboxes;
- the action tokens of those customers;
- the store A orders whose checkout email is `<qa6>`;
- the store A carts with the same guest token as those orders.

Nothing else is deleted. Rate-limit counters expire on their own, and any
other test cart is left in place (carts hold no personal data). Stores A and
B, their products and their owner accounts remain (section 4, "Stores").

**Inventory first.** Checkout reserves product stock. Only the supported
cancellation releases it, in one transaction:

- the owner dashboard's **Cancel** action on the order
  (`PATCH /api/businesses/<id>/manage/orders/<orderId>` with
  `{"action":"cancel"}`);
- it sets `status: "cancelled"` and `inventoryState: "released"`, and
  restores the stock.

**Deleting an order does not release its reservation.** The stock would stay
reduced for good, and the expiry sweep could no longer release it. So no test
order may be deleted until every one of them shows
`inventoryState: "released"`.

**Do:**

1. In a new `mongosh` session, as the **cleanup account** (section 5.7), run
   A0 and confirm in writing that the target is the approved staging
   database, not production.
2. Define the scope and check it. This prints counts only:

   ```js
   var storeA = db.businesses.findOne({ subdomain: "<store-a>" }, { _id: 1 })._id
   var storeB = db.businesses.findOne({ subdomain: "<store-b>" }, { _id: 1 })._id
   var qa = ["<qa1>", "<qa2>", "<qa3>", "<qa4>", "<qa5>"]
   var qaOrder = "<qa6>"
   var isTestInbox = (e) => typeof e === "string" && e.startsWith("qa+") && e.endsWith("@<team-domain>")
   if (qa.length === 0 || !qa.every(isTestInbox) || !isTestInbox(qaOrder)) throw new Error("not a test inbox: stop")

   var customerFilter = { business: { $in: [storeA, storeB] }, email: { $in: qa } }
   var testIds = db.customers.find(customerFilter, { _id: 1 }).toArray().map((d) => d._id)
   var tokenFilter = { business: { $in: [storeA, storeB] }, customer: { $in: testIds } }
   var orderFilter = { business: storeA, customerEmail: qaOrder }
   var orderTokens = db.orders.find(orderFilter, { _id: 0, ownerToken: 1 }).toArray().map((o) => o.ownerToken) // kept in a variable, never printed
   var cartFilter = { business: storeA, ownerToken: { $in: orderTokens } }
   var reservedOrderFilter = { business: storeA, customerEmail: qaOrder, inventoryState: "reserved" }
   var unreleasedOrderFilter = { business: storeA, customerEmail: qaOrder, inventoryState: { $ne: "released" } } // also matches a missing value

   var counted = {
     customers: db.customers.countDocuments(customerFilter),
     tokens: db.customeractiontokens.countDocuments(tokenFilter),
     orders: db.orders.countDocuments(orderFilter),
     carts: db.carts.countDocuments(cartFilter)
   }
   var inventory = {
     reservedOrders: db.orders.countDocuments(reservedOrderFilter),
     unreleasedOrders: db.orders.countDocuments(unreleasedOrderFilter)
   }
   counted
   inventory
   ```

   **Both `inventory` values must be 0 before going on.**
   - **`reservedOrders` above 0:** stop the cleanup. The store A owner
     cancels each such order through the dashboard (Orders, **Cancel**).
     Then the database owner runs O5 (section 5.8) as the read-only user and
     confirms that every test order shows `status: "cancelled"` and
     `inventoryState: "released"`, and that the product's stock is back in
     the dashboard. Restart this step from sub-step 1 in a new session.
   - **`unreleasedOrders` above `reservedOrders`:** some test order is
     `consumed` or has no inventory state. There is no supported way to
     release it in this runbook. Stop and report.

3. Compare the counts with the evidence log.
   - If every step ran once: 6 customers (`<qa1>`, `<qa2>`, `<qa3>` and
     `<qa5>` on A; `<qa4>` and `<qa5>` on B), and one order per run of step
     15.
   - Tokens vary; carts are 0 or more.
   - The approver confirms in writing: "delete N customers, N tokens,
     N orders, N carts", with these exact numbers (AP8).
4. In the **same** session, type the approved numbers, and delete only if
   nothing changed:

   ```js
   var approved = { customers: 0, tokens: 0, orders: 0, carts: 0 } // replace each 0 with the approved number
   var now = {
     customers: db.customers.countDocuments(customerFilter),
     tokens: db.customeractiontokens.countDocuments(tokenFilter),
     orders: db.orders.countDocuments(orderFilter),
     carts: db.carts.countDocuments(cartFilter)
   }
   if (JSON.stringify(now) !== JSON.stringify(approved)) throw new Error("counts differ from the approval: stop")
   if (db.orders.countDocuments(unreleasedOrderFilter) !== 0) throw new Error("a test order still holds or lacks an inventory state: stop")

   db.customeractiontokens.deleteMany(tokenFilter) // deletedCount must equal approved.tokens
   db.carts.deleteMany(cartFilter)                 // deletedCount must equal approved.carts
   db.orders.deleteMany(orderFilter)               // deletedCount must equal approved.orders
   db.customers.deleteMany(customerFilter)         // deletedCount must equal approved.customers
   ```

5. Re-run the `var counted = …` block and `counted` from sub-step 2. All four
   values must be 0.
6. Delete the local cookie jars, browser profiles and test emails.
7. Confirm the email key is the valid staging key (step 9).

**Expect:**

- The guard in sub-step 2 passes, and the counts match the evidence log and
  then the approval.
- Both `inventory` values are 0 before any deletion.
- Each `deletedCount` equals its approved number, and the final counts are 0.
- The flag stays **off**.
- The evidence log is complete, and no secret or token is left in the ticket.

**Stop if:**

- the flag is on;
- A0 does not match;
- the guard throws;
- any count differs from the evidence log or the approval;
- any test order is not `inventoryState: "released"` (cancel it first, as
  described in sub-step 2, never by editing the database);
- any `deletedCount` differs from its approved number;
- the deletion would need a filter other than the four above.

Do not "fix" a count difference by changing a filter. Report it and wait for
review.

## 7. Evidence log

Copy this table into the ticket and fill it in during the run.

| Step | Time (UTC) | Operator | Result (pass / stop / skipped, with reason) | Evidence (redacted) |
|---|---|---|---|---|
| 0 | | | | |
| 1 | | | | |
| … | | | | |
| 16 | | | | |

A step counts as **passed** only when every "Expect" item was observed and
recorded. A skipped step is recorded with its reason and keeps the related
item open in customer-accounts.md.
