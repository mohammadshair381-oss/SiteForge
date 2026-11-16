# Email delivery (production)

Signing up and logging in use email and password only, but resetting a
forgotten password works only with an emailed six-digit code
(`docs/security-monitoring.md`), and team invitations and order emails need
email too. A production server without working delivery would leave anyone who
forgets their password locked out. So **a real email provider is mandatory in
production**. Without one the startup check fails and the application answers
requests with HTTP `500`. The Node process does **not** necessarily stop, so a
deployment health check is required to keep traffic away from such an
instance (see "Required: a deployment health check").

Code: `backend/lib/email.ts` (`resolveEmailConfig`, `assertEmailStartupConfig`,
`sendEmail`), called at boot from `instrumentation.ts`. Tests:
`tests/unit/email-startup.test.ts`, `tests/unit/instrumentation-email.test.ts`,
`tests/unit/email-config.test.ts`, `tests/integration/*provider-failure.test.ts`.

## Running without email (`EMAIL_PROVIDER=disabled`)

A deliberate "no email" mode, for running the site before an email provider is set up. It is
allowed in production because it is a choice someone made, not a forgotten setting (an EMPTY
`EMAIL_PROVIDER` still stops a production server). Nothing pretends to send:

| Flow | With email turned off |
|---|---|
| Signup and login | Work normally (they never use email) |
| Forgot password | `503 email_disabled` with a plain message, the same for every address (reveals no account); no code is created |
| Team invitations | Refused with `503 email_disabled`; nothing is stored |
| Order emails | Skipped quietly; orders are unaffected |
| Storefront customer accounts | Need email (verification and reset links): keep `CUSTOMER_ACCOUNTS_ENABLED` off |

The server logs one line at startup: `[email] Email is turned off (EMAIL_PROVIDER=disabled): ...`,
and Super Admin → Settings shows it. Nobody can recover a forgotten password while it is on.

To turn email on later: set `EMAIL_PROVIDER=resend` with `EMAIL_API_KEY`, `EMAIL_FROM` and `APP_URL`
(below) and redeploy. No code change.

## Required configuration

| Variable | Production value | Checked at startup |
|---|---|---|
| `EMAIL_PROVIDER` | `resend` (the only real provider), or `disabled` to run without email | Required. Empty, `console`, `memory` or anything else fails the startup check. |
| `EMAIL_API_KEY` | A Resend API key | Required; must start with `re_` and contain no spaces or quotes. |
| `EMAIL_FROM` | `SiteForge <no-reply@your-verified-domain>` or a bare address | Required; must be a plausible address with no control characters. |
| `APP_URL` | `https://app.your-domain` | Required; absolute `https://` base address with no credentials, query or fragment (email links are built on it). |
| `EMAIL_REPLY_TO` | Optional support address | Validated only when set. |
| `AUTH_LOG_OTP` | Unset or `false` | Not checked. It has no effect outside `NODE_ENV=development` with a `console`/`memory` provider, so production and staging never print a code. |

`NODE_ENV=production` is set by the hosting platform. Staging must run as
production too, so it gets the same check.

### What the startup check proves, and what it does not

The check is **local and structural**. It looks at names, formats and required
values, and **never contacts Resend**. Passing it means the configuration is
complete and well-formed. It does **not** mean the key is active, has sending
permission, belongs to the right account, that the sender domain is verified, or
that mail will arrive. Only a real send (see "Staging tests") shows that.

### What happens when the check fails

Next.js runs the check (`register()` in `instrumentation.ts`) while preparing
the server. When it throws:

- the Node process **may keep running**. Under `next start` it still prints
  "Ready" and keeps its port open;
- requests to the application fail with HTTP `500`, and the server log shows the
  error below (checked locally with `next start`: `/login` answered `500`);
- nothing is sent and nobody can sign in through that instance.

A process that is running, a listening port or a "Ready" line is therefore
**not** proof of a healthy deployment. It is not proof that the process stopped
either. A failed check is a production readiness failure, and the deployment
health check below is what keeps traffic away from it. SiteForge deliberately
does not end the process itself. The existing `SESSION_SECRET`,
`MONGODB_URI` and `TRUSTED_IP_HEADER` startup checks behave the same way.

Failure messages name variables only, never values. For example:

```
An error occurred while loading instrumentation hook: Email delivery is required in production:
set EMAIL_PROVIDER=resend with EMAIL_API_KEY, EMAIL_FROM and an HTTPS APP_URL
(missing: EMAIL_PROVIDER, EMAIL_API_KEY). Without it no password-reset code (or any
other email) can be sent.
```

Outside production nothing changes. An empty provider means `console`, `memory`
works for tests, and an explicitly chosen `resend` is checked the same way
(plain-HTTP `localhost` is fine for `APP_URL`).

## Required: a deployment health check

Every production (and staging) deployment **must** have a health or readiness
check that requests a real application page and requires HTTP `200`. Use
`/login`. The hosting platform or orchestrator must mark an instance that fails
it as unhealthy and send it no traffic. For a new release, that means the
release does not go live.

- **SiteForge does not set this up.** Configure it in the hosting platform:
  for example a load balancer target-group health check, a container
  orchestrator's readiness probe, or the platform's own deployment health
  check. Check that it is actually enabled for the production service.
- **Check the status code, not the connection.** A TCP or port check passes
  even while requests answer `500`.
- **Platforms without per-instance health checks** (for example serverless
  hosting): request `/login` on the new deployment and require `200` before
  sending production traffic to it (promote or alias it only after it passes).
- **It also covers the database.** `/login` waits on MongoDB too: with an
  unreachable database it did not answer in a local check. So a failing check
  can mean either problem; the server log says which.
- **Do not add an exception for it.** No bypass, no special status page, and
  no unauthenticated route that reveals configuration.

A passing check shows the configuration is complete and the application
serves. It does not show that mail is delivered: run the staging tests below
for that.

## Configuring it securely

1. In Resend, verify the sending domain (add its DNS records) and wait until it
   shows **Verified**.
2. Create an API key with **sending access only**, restricted to that domain.
   Use separate keys for staging and production.
3. Enter the variables in the hosting platform's environment settings for that
   environment only. Mark the key as secret or sensitive if the platform offers
   it. Never put it in the repository, in a `.env` file that is committed, in a
   `NEXT_PUBLIC_` variable, in a ticket or in chat.
4. Redeploy or restart. Configuration is read once when the server boots.

To rotate a key, create the new key, update `EMAIL_API_KEY`, redeploy, confirm a
staging or production password reset code arrives, then delete the old key in Resend.

## Checking the configuration without printing credentials

- **The deploy serves.** The health check passes: `/login` answers `200`. If any
  email value is missing or malformed, requests answer `500` and the server
  log names the variable. Fix the named variable; never print or echo its
  value to investigate.
- **Variables are present.** Check that each name above exists for the right
  environment in the hosting dashboard (or its CLI listing of names). Never
  reveal or copy the key's value to confirm it.
- **The key and domain are right.** In the Resend dashboard, check that the
  domain is Verified and the key exists, has sending access and was used
  recently. The key's value is not needed for this.
- **Mail arrives.** Run the staging tests below and confirm each message in
  Resend's email log and in the inbox.

## Staging tests (real delivery)

Use a test mailbox you control and a staging deployment with its own database
and its own Resend key.

0. **The health check catches a bad configuration.** Deploy staging once with
   `EMAIL_PROVIDER` removed. The platform must mark the instance unhealthy and
   send it no traffic, while `/login` answers `500`. Restore the variable,
   redeploy, and confirm the check passes. Do this on staging only, never on
   the live production service.

1. **Signup and login.** Register a new account and log in with it: neither sends
   an email or asks for a code.
2. **Password reset code.** Use "Forgot password" for the test account. "Your
   SiteForge password reset code" arrives; the code and a new password set it
   once, and a second use is refused.
3. **Logs.** In the staging server logs, find no code, no link, no token and no
   full email address (only masked addresses and fixed messages).
4. **Spam placement.** If messages land in spam, fix the domain's DNS
   authentication records in Resend before going live.

## When email cannot be sent

Every email flow fails closed: a failure is never reported as a success, and
nobody is signed in because a message could not be sent. There is no automatic
retry (it could send duplicates).

| Flow | Answer during an outage | Effect |
|---|---|---|
| Login and signup | Normal | No email is involved. |
| Password reset | The usual answer (it never reveals whether an account exists) | The undelivered reset code is cancelled. Logs `[forgot-password] reset code could not be sent`. |
| Team invitation | Created as normal | Logs `[team-invitation] email could not be sent`; the inviter can resend. |
| Order emails | Unaffected | Orders and API answers never depend on them. Logs `order_email_failed`. |

Each "forgot password" request counts against the address's 3 requests per 15
minutes, including requests whose email fails. After an outage someone may have
to wait up to 15 minutes before asking again.

## Recovering from a provider outage

There is no way to reset a password without the emailed code, and none may be
added: no bypass, no shared code, no logging codes in production.
Recovery means restoring delivery.

1. **Confirm.** Look for `login_code_email_failed`, `[forgot-password] reset
   code could not be sent` or `[team-invitation] email could not be sent` in
   the server logs. Check Resend's status page and its email log for the error
   (for example a revoked key, an unverified domain or a sending limit).
2. **Fix the cause.**
   - Revoked or leaked key: create a new one and redeploy.
   - Unverified domain: correct its DNS records.
   - Sending limit: wait for it to reset or raise the plan.
   - Wider Resend outage: wait. Moving to another provider would be a code
     change (only `resend` is implemented), not a setting.
3. **Tell people who forgot their password to wait.** Login and signup keep
   working; only password resets (and invitation and order emails) wait for email.
4. **Verify recovery.** Ask for a password reset code for a test account (see
   "Staging tests" step 2) before telling people to try again. Pending codes
   expire on their own (each code after 5 minutes, the pending request after 20).

## Limitations

- A failed check makes requests answer `500` but does not end the process
  (see "What happens when the check fails"). Without a configured health check,
  a broken instance could receive traffic.
- The startup check cannot detect a key that is valid in form but revoked, out
  of quota or for the wrong account, or a sender domain that is not verified.
  Only a real send shows that.
- Delivery is not monitored or alerted on yet. The log lines above are the
  signal to watch (see the launch checklist, "Production blockers").
- Only one provider (Resend) exists, with no fallback provider.
