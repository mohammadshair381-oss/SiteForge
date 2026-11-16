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
  (`after.trustedDevicesRevoked: true`). It is part of the credential
  fingerprint kept by every pending reset code, so every pending password reset
  code of the user stops working. `reactivate` does not raise it (the
  deactivation already did). An ordinary logout never touches it.
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
| `password_reset_requested` | both | Reset requested (platform: a code; storefront: a link. Platform: user id when the account exists; storefront: email digest only, because the account lookup happens after the response) |
| `password_reset_failed` (platform: `wrong_code` / `expired_code` / `too_many_attempts` / `account_changed` / `reset_conflict`; storefront: `invalid_token` / `reset_conflict`) | both | Reset refused (wrong, expired or used code or link; account changed meanwhile) |
| `password_reset_completed` | both | Password changed through a reset code (platform) or link (storefront) |
| `customer_session_revoked` (`token_version_mismatch` / `inactive_account` / `account_missing`) | storefront | A correctly signed customer session of this store was used after logout-everywhere, a password reset, deactivation or deletion |
| `platform_session_revoked` (same reasons) | platform | A correctly signed platform session was used after sign-out everywhere, a role change, a password reset, deactivation or deletion (recorded in `requireUser`, throttled, after the response) |
| `email_verification_failed` (`invalid_token` / `wrong_password` / `inactive_account`) | storefront | A customer verification link was refused (customers also need the account password). Platform addresses are confirmed by codes (`login_code_failed`). |
| `password_change_failed` (`wrong_password`) | platform | A signed-in user entered a wrong current password (bounded by the 5 per 15 minutes limit) |
| `login_code_failed` (`wrong_code` / `expired_code` / `too_many_attempts` / `account_changed`) | platform | Historical only: written while login and signup used emailed codes. Nothing writes it now. |

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

## Platform signup and login: email and password only

Signup (`POST /api/auth/register`) and login (`POST /api/auth/login`) use email and password only:
there is no emailed code, no "remembered browser" and no email confirmation. This is an owner
decision, with these consequences:

- **A stolen or guessed password alone opens the account**, Super Admins included. The limits below
  slow guessing; they do not stop someone who already has the password.
- **Email addresses are not proven.** Anyone can sign up with an address they do not own. The real
  owner of that address can take the account over with a password reset (the code goes to their
  mailbox), which ends every session. Team invitations are still safe: their token is emailed to the
  invited address, so only its owner can accept.
- **Signup reveals whether an address is registered**: a registered address gets `409 email_taken`,
  because signing up signs in at once. Login still answers the same for a wrong password and an
  unknown or inactive address.
- New accounts have no `emailVerifiedAt`; logging in clears an old `null` (accounts left unconfirmed
  by the earlier code-based signup), so `requireVerifiedEmail` no longer blocks anyone who can log in.

### Login limits

All are shared across instances, and their keys are HMAC-hashed, so no address or email is stored.

| Limit | Counts | Purpose |
|---|---|---|
| 10 per 5 minutes, per source | Every attempt | Slows one source trying many accounts |
| 5 per 5 minutes, per (account, source) | Failures | One source cannot use up an account's budget for everyone |
| 50 per 5 minutes, per account | Failures | Bounds guessing spread over many addresses |
| 5 signups per 15 minutes, per client address | Every signup | Slows mass account creation |

- **Source** is one IPv4 address or one IPv6 /64, from `TRUSTED_IP_HEADER` only (`rateLimitSourceKey`), so rotating addresses
  inside a /64 gives no new budget. Wider IPv6 ranges are held back by the account-wide limit.
- **Only failures count** against the account: a unit is reserved before the password check, so guesses at the same
  moment cannot overshoot, and it is returned after the right password.
- **What remains:** someone sustaining 50 failures every 5 minutes from about 10 or more sources can delay any login to
  that account. Each window lasts at most 5 minutes and it never locks permanently; a password reset does not depend on it.
  Customer accounts have their own limits (`docs/customer-accounts.md`).

## Password reset codes

`backend/lib/auth/login-challenge.ts` and `backend/lib/auth/code-verification.ts`. Routes:
`POST /api/auth/password/forgot` and `POST /api/auth/password/reset`. The one emailed code left for platform accounts.

- **Asking:** `/password/forgot` answers the same for an active, an unknown and an inactive address, with a pending code
  cookie (`swb_reset_challenge`, `__Host-` in production; httpOnly, SameSite=Strict, 20 minutes). Only an active account's
  code is real and emailed (after the response); the others are decoys bound to an id no account has, whose code never
  matches and whose answers equal a wrong code's. 3 requests per address and 10 per client address per 15 minutes; asking
  again replaces the code. A code the email could not deliver is cancelled.
- **Setting the password:** `/password/reset {code, password}` sets the new password, raises `tokenVersion` (every session
  ends) and `deviceTrustVersion` (every other pending reset code ends), and never signs in.
- **Code:** six digits from `crypto.randomInt`, leading zeros kept, stored only as an HMAC (key derived from `SESSION_SECRET`)
  over the pending value, the account, the code and its purpose. Valid 5 minutes and single use, 5 guesses per pending code,
  each reserved atomically before the comparison. Codes are never in an API answer, a URL, browser storage or a log.
- **Account budget:** 10 wrong reset codes per account per day (fixed UTC-day window), reserved before each comparison and
  keyed by the pending code's account id, so a decoy never spends a real account's budget.
- **Monitoring:** `password_reset_requested`, `password_reset_failed` (`wrong_code` / `expired_code` / `too_many_attempts` /
  `account_changed` / `reset_conflict`) and `password_reset_completed`, with digests only.
- **Development:** with `EMAIL_PROVIDER=console` no body is shown, so `AUTH_LOG_OTP=true` prints
  `[auth] Development password reset code for j***@example.com: 123456` in the server terminal. It needs ALL of: `NODE_ENV`
  exactly `development`, `AUTH_LOG_OTP` exactly `true`, `EMAIL_PROVIDER` explicitly `console` or `memory`, and no `VERCEL` /
  `VERCEL_ENV`. Production, staging, tests and real delivery never print a code (`backend/lib/auth/dev-login-code.ts`).

## Database prerequisites (approved operation)

`SecurityEvent` has `autoIndex` / `autoCreate` off. Before relying on
retention in a persistent database, create:

```js
db.securityevents.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
db.securityevents.createIndex({ type: 1, createdAt: -1 });
```

Until the TTL index exists, events older than 90 days are kept (but hidden).
