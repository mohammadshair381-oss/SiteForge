# Security monitoring and platform account management

## Platform account actions (super admins)

`PATCH /api/admin/users/[id]` `{ action, reason, currentPassword? }`, UI on
`/admin/users` (confirmation dialog, reason required). Implementation:
`backend/lib/admin/user-actions.ts`.

| Action | Effect |
|---|---|
| `deactivate` | `active: false`; the user cannot sign in. |
| `reactivate` | `active: true`; old sessions stay revoked. |
| `grant_super_admin` / `revoke_super_admin` | Platform role only. Needs the acting admin's current password (step-up). |
| `force_signout` | Ends every session; the account stays active. |

- Every action increments `tokenVersion`; `requireUser()` compares it on every
  request, so all existing sessions of the user stop working immediately.
- `deactivate`, both role changes and `force_signout` also increment
  `User.deviceTrustVersion` (no default; absent = 0), in the same audited write
  (`after.trustedDevicesRevoked: true`). It is part of the known-device
  fingerprint, so every known-device marker and every pending new-device sign-in
  of the user stops working: each browser must enter an emailed code again.
  `reactivate` does not raise it (the deactivation already did). An ordinary
  logout never touches it, so known devices survive a logout.
- Business memberships (`owner` / `manager` / `staff`) are never read or
  changed; a deactivated owner's storefronts keep running.
- Lock-out protection: no action on your own account (`409 self_action`); the
  platform always keeps one active super admin (`409 last_super_admin`).
  Concurrent demotions are serialised inside the transaction (every super-admin
  document is written, so two admins demoting each other cannot both succeed;
  verified by a concurrency test and a mutation check).
- Each change is a conditional update recorded in the append-only admin audit
  log in the same transaction (`user.*` actions; name only, no email).
- Same-origin JSON only; 30 actions per admin per 10 minutes.

## Security events

`backend/models/SecurityEvent.ts`, written by `backend/lib/security-events.ts`.

Every event has a `scope`: `platform` (SiteForge users) or `storefront`
(customer accounts of one store; `business` is the Host-resolved store).
Events written before scopes existed have no `scope` and count as platform.

| Event | Scope | When |
|---|---|---|
| `login_failed` (`unknown_account` / `wrong_password` / `inactive_account`) | platform | Platform sign-in failed |
| `admin_login` | platform | A super admin signed in |
| `admin_reauth_failed` | platform | Wrong password when confirming a role change |
| `customer_login_failed` (no reason) | storefront | Customer sign-in failed. Unknown, wrong-password and inactive are deliberately NOT distinguished and no account lookup is added, so response timing still cannot reveal whether an account exists. |
| `password_reset_requested` | both | Reset link requested (platform: user id when the account exists; storefront: email digest only, because the account lookup happens after the response) |
| `password_reset_failed` (`invalid_token` / `reset_conflict`) | both | Reset refused (invalid, expired or used link; account changed meanwhile) |
| `password_reset_completed` | both | Password changed through a reset link (user or customer id) |
| `customer_session_revoked` (`token_version_mismatch` / `inactive_account` / `account_missing`) | storefront | A correctly signed customer session of this store was used after logout-everywhere, a password reset, deactivation or deletion |
| `platform_session_revoked` (same reasons) | platform | A correctly signed platform session was used after sign-out everywhere, a role change, a password reset, deactivation or deletion (recorded in `requireUser`, throttled, after the response) |
| `email_verification_failed` (`invalid_token` / `wrong_password` / `inactive_account`) | both | A verification link was refused (customers also need the account password) |
| `password_change_failed` (`wrong_password`) | platform | A signed-in user entered a wrong current password (bounded by the 5 per 15 minutes limit) |
| `login_code_failed` (`wrong_code` / `expired_code` / `too_many_attempts` / `account_changed`) | platform | A new-device sign-in code was refused, or the account changed (password, sign-out everywhere, deactivation) between the password and the code |

Data minimisation:
- Never stored: passwords, raw email addresses, raw IP addresses, user agents,
  request bodies. Attempted emails and client addresses are keyed
  HMAC-SHA256 digests (domain-separated, `SESSION_SECRET`), so repeated attempts
  can be grouped but not reversed. Known accounts are referenced by id.
- Views show digests shortened to 10 characters.
- Retention: 90 days (`expiresAt`). Views never show older events.
- Never stored: reset or verification tokens (not even hashed), customer names
  or emails. Storefront customers appear in views only as a short reference to
  the opaque account id plus the store.
- Volume is bounded by the existing limiters: attempts rejected with 429 are not
  recorded. Revoked-session events are throttled to one per customer per 10
  minutes per server instance and written after the response (they can be
  replayed on every page view).
- Recording is best-effort: a failed write never changes the sign-in response
  and logs only `[security] event=security_event_write_failed`.

Views (super admin only): `/admin/security` and
`GET /api/admin/security-events` (filters: type, reason, scope, store, user,
dates). Business owners do not see security events.
Alerts (also on the admin overview): failed admin password confirmations in
24 h (critical); accounts with 5+ failed sign-ins in 1 h (platform accounts and
each store's customer accounts are counted separately); sources with 20+
failed sign-ins or refused resets in 24 h.

Not recorded (documented gaps): rate-limited (429) attempts, invalid or
expired session signatures (they cannot be attributed to an account), and
email-verification resend requests. Without `TRUSTED_IP_HEADER` (development)
no source fingerprint is stored.

## Platform sign-in limits

`POST /api/auth/login`. All are shared across instances, and their keys are HMAC-hashed, so no address or email is stored.

| Limit | Counts | Purpose |
|---|---|---|
| 10 per 5 minutes, per source | Every attempt | Slows one source trying many accounts |
| 5 per 5 minutes, per (account, source) | Failures | One source cannot use up an account's budget for everyone |
| 50 per 5 minutes, per account | Failures | Bounds guessing spread over many addresses |
| 5 per 15 minutes, per known device | Failures | Replaces the two above for a browser that has signed in to this account before |

- **Source** is one IPv4 address or one IPv6 /64, from `TRUSTED_IP_HEADER` only (`rateLimitSourceKey`), so rotating addresses
  inside a /64 gives no new budget. Wider IPv6 ranges are held back by the account-wide limit.
- **Only failures count** against the account: a unit is reserved before the password check, so guesses at the same
  moment cannot overshoot, and it is returned after a full sign-in. A correct password on an unconfirmed account stays
  counted, because that answer must look like a wrong password.
- **Known device** (`backend/lib/auth/platform-device.ts`, cookie `__Host-swb_device` in production): after the OWASP device cookie
  pattern. It is issued after a sign-in completed with the emailed code (see below), refreshed by each sign-in from that browser,
  and bound to the email and the current password, so changing the password outdates it. It never replaces the password check.
  It chooses the failure budget, so people guessing elsewhere cannot lock an owner out of a browser they have already used, and
  it lets that browser skip the new-device code. A stolen marker is therefore worth something only together with the password,
  and only until the password changes.
- **Nothing reveals an account:** an unknown address spends and answers exactly as a real one does, and the answer is the
  same for a wrong password, an unknown address and an unconfirmed account.
- **What remains:** someone sustaining 50 failures every 5 minutes from about 10 or more sources can still delay a sign-in
  from a browser that has never signed in to that account. Each window lasts at most 5 minutes, it never locks permanently, and a
  password reset does not depend on it. Customer accounts have their own limits (`docs/customer-accounts.md`).

## New-device sign-in codes

`backend/lib/auth/login-challenge.ts`, routes `POST /api/auth/login` (password), `POST /api/auth/login/code` and
`POST /api/auth/login/code/resend`. Applies to every platform account (super admins, owners, managers, staff), whatever its
role. Storefront customers are not affected (`docs/customer-accounts.md`).

- **When:** the password is right and the address confirmed, but the browser has no valid known-device marker for this account,
  its current password and its trusted-device generation. The answer is
  `202 {codeRequired, expiresInSeconds, resendInSeconds, resendsLeft, attemptsAllowed, attemptsLeft}` and a pending sign-in
  cookie; **no session and no marker**. A valid marker keeps the old behaviour (200, session, marker).
- **Pending sign-in:** 256 random bits in `swb_login_challenge` (`__Host-` in production; httpOnly, SameSite=Strict, 20 minutes).
  Stored as an `AuthToken` of type `login_code` (existing collection and indexes) holding the SHA-256 of that value, never the
  value. A newer sign-in of the same account cancels older pending ones. The generic action-token helpers refuse `login_code`.
- **Code:** six digits from `crypto.randomInt`, leading zeros kept, stored only as an HMAC (key derived from `SESSION_SECRET`)
  over the pending sign-in, the account and the code. Valid 5 minutes and single use. A pending sign-in has **5 guesses in total**,
  across its resends. A guess is reserved atomically before the comparison, and finishing is a second conditional write, so
  parallel requests can neither exceed 5 guesses nor use one code twice. Codes are never in an API answer, a URL, browser
  storage or a log.
- **Finishing:** only a right code, sent with the pending sign-in cookie, creates the session and the marker, and only while the
  account is still active, confirmed, on the same password, session version and trusted-device generation as at the password
  check (checked before any guess is compared).
- **Resend:** replaces the code (the old one stops working in the same write) and **keeps the guesses already made**; once a
  minute, 3 times per sign-in. A pending sign-in that used its 5 guesses gets no new code (`429 code_attempts_exceeded`): the
  person logs in again, which the account budget below bounds.
- **Account budget:** 10 wrong codes per account per day (fixed UTC-day window, `login-code:fail:account:<id>`), across all its
  pending sign-ins. A unit is reserved before each comparison and given back unless a wrong code was really compared, so a right
  code costs nothing and parallel guesses cannot overshoot. When it is used up, checking a code and emailing a new one both answer
  `429 login_code_locked` (with `Retry-After`) until the day ends; known devices are unaffected. Only someone who gave the right
  password can reach it, and the password step's answers do not change, so it reveals no account.
- **Other limits:** 5 emailed codes per account per 15 minutes (first codes and resends together); 30 code checks and 10 resend
  requests per source per 15 minutes; the password limits above still apply. A right password returns its failure unit as
  before, at the password step.
- **Monitoring:** every refused code is a `login_code_failed` event (with the account's email digest and the source digest). They
  are counted on `/admin/security` ("Wrong sign-in codes") and join password failures in the targeted-account (5+ in an hour,
  also an admin overview alert) and busy-source alerts.
- **Email:** sent through `sendEmail` before answering (template `renderLoginCodeEmail`: code, expiry, warning). If it cannot be
  sent, the pending sign-in is cancelled and the answer is `503 code_not_sent`.
- **Development:** with `EMAIL_PROVIDER=console` no body is shown, so `AUTH_LOG_OTP=true` prints
  `[auth] Development sign-in code for j***@example.com: 123456` in the server terminal. It needs ALL of: `NODE_ENV` exactly
  `development`, `AUTH_LOG_OTP` exactly `true`, `EMAIL_PROVIDER` explicitly `console` or `memory` (an empty provider is not
  enough), and no `VERCEL` / `VERCEL_ENV`. Production, staging, tests and real delivery never print a code
  (`backend/lib/auth/dev-login-code.ts`).
- **Other ways in:** confirming an email address (link plus password) still signs in directly: the link proves the mailbox, as
  the code does. It sets no marker, so the next sign-in from that browser asks for a code. Changing a password keeps the
  current session. A password reset never signs in.
- **Revoking known devices:** a password change or reset outdates every marker, and so do the admin actions `force_signout`,
  `deactivate`, `grant_super_admin` and `revoke_super_admin` (`User.deviceTrustVersion`, see "Platform account actions"). An
  ordinary logout does not, by design: the marker also keeps the owner's own browser out of an account-wide sign-in lock.
- **Known limits:** no per-device revocation (all markers of an account go together). Markers issued before this feature (any
  browser that signed in within 90 days) count as known devices until one of the above happens.

## Database prerequisites (approved operation)

`SecurityEvent` has `autoIndex` / `autoCreate` off. Before relying on
retention in a persistent database, create:

```js
db.securityevents.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
db.securityevents.createIndex({ type: 1, createdAt: -1 });
```

Until the TTL index exists, events older than 90 days are kept (but hidden).
