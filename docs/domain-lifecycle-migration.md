# Custom-domain lifecycle: migration and operations

Nothing here runs automatically. The data migration is **not executed by the
application, by tests against real data, or by deploys**. It is an operator
action that needs a backup and explicit confirmation.

## Lifecycle states (current)

`lib/domains/lifecycle.ts` gives each domain one state: `pending`, `failed`, `expired`, `verified`
(ownership proven), `active`, `stale` (ownership proof too old) or `revoked`. `active` needs
`activatedAt`, which only `lib/domains/activation.ts` sets, and only once DNS points at the configured
target (`CUSTOM_DOMAIN_CNAME_TARGET` / `CUSTOM_DOMAIN_A_RECORDS`) and a certificate integration
(`lib/domains/certificates.ts`, selected by `CUSTOM_DOMAIN_CERT_PROVIDER`) reports a valid certificate.
No DNS, ingress or issuing provider ships with SiteForge.

### Continuity

- **Domains verified before activation existed keep serving.** They have no `activationRequired`, the same
  pattern as `User.emailVerifiedAt`. They show as verified with a warning, never as active, until a check
  confirms them. Every new request or verification writes `activationRequired: true`, and those serve in
  production only once `activatedAt` is set. Development and tests have no TLS to confirm and route verified domains.
- **An outage changes nothing.** A failed lookup or an unreachable provider is recorded (`temporaryFailureCount`)
  and leaves the domain as it was, including its last real DNS and certificate answers.
- **A definite failure has a grace period.** DNS pointing elsewhere or a bad certificate starts `failingSince`, with
  a warning. An active domain only stops being active if a check at least 72 hours later (`DOMAIN_FAILURE_GRACE_MS`)
  still finds it failing. A good check clears it.
- **A stored expiry date never stops a domain.** It may have been renewed since the last check, and by the time
  a request reaches `lib/tenant.ts` TLS has already happened. An expired date is a warning until a check decides.
- **Only 90-day ownership freshness stops a domain outright**, as it always has. Renewing ownership and running checks
  do not wait for the feature's indexes, because neither claims anything new.
- **APIs:** `active` still means the store's chosen domain, and is unchanged. `lifecycle`, `health` and `unconfirmed`
  describe the real state.

### Health and renewal

`lib/domains/health.ts` works out `healthy`, `degraded`, `unhealthy` or `unknown` and a list of warnings from what
was recorded, including when each check last really succeeded (`lastDnsOkAt`, `lastCertificateOkAt`). Owners see them on
the Domains page, and Super Admins on `/admin/domains` and each business's page. `DomainEvent` holds the history.

Certificates have two kinds of integration. `CertificateProvider` only reports. `ManagedCertificateProvider` also has
`issue` and `renew`, and within 30 days of expiry a check asks it to renew, recording attempts and failures
(`renewalStatus`, `renewalFailureCount`, `renewalLastError`). **None of the second kind exists, so automated
renewal does not operate.** `tls_probe` is the first kind and issues nothing. With it, `renewalStatus` is `external`:
SiteForge only notices a later expiry date.

Checks run when an owner asks, or from `POST /api/cron/domain-health` if a scheduler is set up (`docs/scheduled-jobs.md`).

## 1. What changed (code)

| Capability | Where |
|---|---|
| Pending-token expiry only (`expiresAt` is `null` for verified/revoked) | `models/DomainVerification.ts` |
| Retryable DNS verification, classified failures | `lib/domain-dns.ts`, `domains/verify/route.ts` |
| Removal revokes routing; pending cancellation | `domains/route.ts` (`DELETE`) |
| Routing requires verified record + `Business.customDomain` match + fresh ownership proof + entitlement | `lib/tenant.ts` |
| Ownership freshness / renewal (M4) | model helpers, both routes, `DomainManager.tsx` |

## 2. Indexes

**No index change is required and none should be made.** The three
`DomainVerification` indexes are unchanged: `domain_verification_1` (unique,
partial), `{business, domain}` (unique) and the TTL index on `expiresAt`
(`expireAfterSeconds: 0`). MongoDB's TTL monitor only deletes documents whose
`expiresAt` is a BSON date, so storing `null` on verified/revoked records makes
them immune. `renewalExpiresAt` is deliberately not indexed. Do not drop or
recreate indexes.

## 3. Which legacy records are affected

Records written before the `status` field existed (selected with `status: null`,
which matches absent and null):

| Class | Selection | Migration |
|---|---|---|
| Legacy **verified** | `status` absent, `verifiedAt` set, **not** `usedAt > verifiedAt` | `status: "verified"`, `expiresAt: null`, `ownershipCheckedAt: now` |
| Legacy **removed** | `status` absent, `verifiedAt` set, `usedAt > verifiedAt` | `status: "revoked"`, `revokedAt: now`, `expiresAt: null` |
| Legacy pending / consumed-unverified | `verifiedAt` null | **not touched** (pending ones should legitimately expire; the verify route normalizes them on first use) |
| New-lifecycle records | `status` present | **not touched** |

The selection mirrors `domainStatusOf` exactly. It is idempotent (migrated
records no longer match), narrowly scoped, writes only the fields above
(`timestamps: false`, so `updatedAt` is preserved), and deletes nothing.
Behaviour is covered by `tests/integration/domain-migration.test.ts`.

Assumption to confirm: "removed" detection relies on the old removal path
stamping `usedAt` after `verifiedAt`. That is what the model documentation and
the original behaviour describe, but the old route code no longer exists in the
repo, so check the dry-run `revoked` count against what you expect.

### TTL risk — read this

The TTL monitor runs about every 60 seconds. A legacy verified record whose
original 24h `expiresAt` has passed is **deleted by MongoDB the next time the
monitor runs, whether or not the new code is deployed**. In any environment that
has been running the old code for more than a day, such records are very likely
already gone; a deleted record cannot be recovered by this migration (restore
from backup if needed, otherwise the owner must verify the domain again). The
migration only protects records that still exist. Run the dry run first: it
reports how many verified records are already TTL-eligible
(`verifiedExpiredAtRisk`). Those are the ones at immediate risk, so run the
apply step as soon as it is approved.

### Behaviour while the migration is pending

The application keeps working. Unmigrated legacy records are read through
`domainStatusOf` (verified/revoked/pending inferred) and routing ignores
`expiresAt`. Two things differ until migrated: (a) the TTL monitor can still
delete them, and (b) with no `ownershipCheckedAt` their freshness is measured
from `verifiedAt`, so a domain verified more than 90 days ago stops serving
(fail closed) until the owner renews. Running the migration starts a 90-day
grace window (`ownershipCheckedAt: now`) for all legacy-verified domains. That
grace is trust granted without a new DNS proof, bounded to one window.

## 4. Procedure (requires your confirmation before step 3)

1. **Backup** the `domainverifications` collection (e.g. `mongodump
   --collection domainverifications`). Rollback: restore from this dump, or
   `$unset` `status`/`ownershipCheckedAt` on the migrated documents (the runtime
   falls back to legacy inference when `status` is absent).
2. **Dry run (read-only):** `npm run domain-migration` with `MONGODB_URI`
   pointing at the target. It prints three counts only (verified, of which
   TTL-eligible now, removed); no domain names or tokens. The expected counts
   cannot be known without querying the target database; this repository cannot
   determine them.
3. **Apply** (only after approval):
   `CONFIRM_DOMAIN_MIGRATION=yes npm run domain-migration -- --apply`
   (PowerShell: `$env:CONFIRM_DOMAIN_MIGRATION="yes"; npm run domain-migration -- --apply`).
   Without both the flag and the variable the script refuses to write.
4. **Verify:** rerun the dry run; all three counts must be `0`. Rerunning apply
   is a no-op.

Equivalent mongosh, if preferred:

```js
db.domainverifications.updateMany(
  { status: null, verifiedAt: { $ne: null },
    $expr: { $not: { $gt: ["$usedAt", "$verifiedAt"] } } },
  { $set: { status: "verified", expiresAt: null, ownershipCheckedAt: new Date() } });
db.domainverifications.updateMany(
  { status: null, verifiedAt: { $ne: null },
    $expr: { $gt: ["$usedAt", "$verifiedAt"] } },
  { $set: { status: "revoked", revokedAt: new Date(), expiresAt: null } });
```

## 5. Ownership verification, freshness, routing, TLS — four different things

1. **Initial ownership verification** — the owner proves DNS control once with a
   TXT record (`_siteforge-verification.<domain>`). Implemented.
2. **Verification freshness (M4, implemented on-demand)** — a proof is trusted
   for 90 days (`DOMAIN_OWNERSHIP_MAX_AGE_MS`). Routing and activation compare
   `ownershipCheckedAt` (falling back to `verifiedAt`) with the clock; there is
   **no DNS lookup per request and no scheduler**. After expiry the domain stays
   `verified` but does not serve (fail closed) until the owner chooses *Renew
   ownership* in the dashboard (`POST …/domains` with `renew: true`, then
   `POST …/domains/verify` with the new token). The domain keeps serving while a
   renewal is outstanding; a failed or timed-out DNS check during renewal
   records an attempt and changes nothing. The dashboard shows the re-verify
   deadline.
3. **DNS routing** — pointing the domain's A/CNAME at the platform. **Not
   implemented or verified**; TXT proof says nothing about it.
4. **HTTPS/TLS and production ingress** — certificate issuance and edge routing
   for customer domains. **Not implemented.**

### Remaining security limitation (M4)

Freshness is time-bounded trust, not monitoring. If a domain changes hands after
verification, the new holder's site can still be served to that business's
storefront for up to 90 days (until the proof expires), and nothing detects the
change in between. Shortening the window raises owner effort; real continuous
detection needs a scheduled re-check, which is outside this architecture today.
No TXT record is required to *remain* routable inside the window.
