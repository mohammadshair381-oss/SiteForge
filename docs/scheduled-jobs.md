# Scheduled jobs

SiteForge has endpoints for an external scheduler. **No scheduler is set up, and none runs
until someone chooses and configures one, which needs its own approval.** Any service that can send
an authenticated HTTPS `POST` works: a platform's cron feature, a GitHub Actions schedule, a Kubernetes
CronJob, or plain `cron` on a server. Nothing in SiteForge depends on which.

| Job | Endpoint | Secret | Suggested interval |
|---|---|---|---|
| Billing reconciliation | `POST /api/cron/billing-reconcile` | `BILLING_RECONCILE_SECRET` | Every 1 to 6 hours |
| Custom domain checks | `POST /api/cron/domain-health` | `DOMAIN_HEALTH_SECRET` | Every 6 to 24 hours |
| Expired cart cleanup | `POST /api/cron/cart-cleanup` | `CART_CLEANUP_SECRET` | Daily |
| Media storage cleanup | `POST /api/cron/media-cleanup` | `MEDIA_CLEANUP_SECRET` | Daily |
| Expired AI conversation cleanup | `POST /api/cron/conversation-cleanup` | `CONVERSATION_CLEANUP_SECRET` | Daily |

## Calling them

```sh
curl -fsS -X POST "https://<platform address>/api/cron/billing-reconcile" \
  -H "Authorization: Bearer $BILLING_RECONCILE_SECRET"
```

Call them on the platform address. Keep the secret in the scheduler's own secret store, never in a URL,
a repository or a log line. Use a separate random value of at least 32 characters for each job, for example
from `openssl rand -hex 32`. To rotate one, change it in both places.

| Answer | Meaning | What the scheduler should do |
|---|---|---|
| `200` with `outcome: "completed"` | The run finished. | Nothing |
| `200` with `outcome: "partial"` | Some stores failed; they are tried again in a later run. | Alert if it keeps happening |
| `200` with `outcome: "skipped_overlap"` | Another run is going, so this call did nothing. | Nothing |
| `401` | Wrong secret. | Alert |
| `502` with `outcome: "failed"` | The run could not finish. | Retry at the next interval |
| `503` | Off: no secret, or for billing, not configured or its indexes are missing. | Alert if unexpected |

Answers hold counts only (`checked`, `changed`, `failed`, `skipped`, `stoppedEarly`).

## Settings

All optional. A value outside the range is ignored.

| Setting (`BILLING_RECONCILE_` or `DOMAIN_HEALTH_`) | Default | Range | Purpose |
|---|---|---|---|
| `..._BATCH_SIZE` | 50 | 1 to 50 | Most items in one run. 50 is a hard limit. |
| `..._MIN_GAP_HOURS` | 6 / 24 | 1 to 168 | An item checked more recently than this is left alone. |
| `..._TIME_BUDGET_SECONDS` | 240 | 30 to 840 | No new item starts after this. Set it below the host's request time limit. |

A run that hits its time budget answers `stoppedEarly: true`, and the next run carries on from the items
checked least recently.

## What keeps this safe

- **Overlap:** a job's lock lives in its `ScheduledJob` document, whose `_id` is the job's name. MongoDB's
  built-in `_id` index is what makes it exclusive, so it needs no new index. The lock is a lease of the time
  budget plus five minutes, so a run that dies cannot block the job for ever. If a run ever outlives its lease
  and two overlap, the work itself is safe to repeat.
- **Repeating:** reconciliation goes through the same path as a webhook, with the same stale-read protection,
  so it can only match what Razorpay reports. It cannot activate, extend or refund anything by itself.
- **One failure:** a store or domain that fails is counted, and the rest carry on.
- **Records:** the last 20 runs of each job are kept and shown to Super Admins on `/admin/billing` and
  `/admin/domains`. Counts and outcomes only. The secret is never logged, stored or displayed.

Cart cleanup deletes only carts untouched for 30 days, up to 500 in a run. Without a scheduler, expired carts
are still removed when a shopper returns to one, and in small batches when an owner opens Abandoned carts.

Conversation cleanup deletes AI website conversations 14 days after their last message, up to 500 in a run, and reads
only their ids. **Without a scheduler the limit is real:** a run-out conversation can no longer be read or sent anywhere, but it stays
stored until its owner comes back or someone starts a new conversation in that store, however long that takes. The job reads the whole collection, because
`expiresAt` has no index; one is an optional approved operation and is not needed for correctness.

## What it does not do

The domain check confirms DNS and certificates. Automated certificate renewal needs a
`ManagedCertificateProvider` (`lib/domains/certificates.ts`), and none exists yet. `tls_probe` only inspects
what a domain presents.
