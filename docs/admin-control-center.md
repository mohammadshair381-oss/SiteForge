# Super Admin control center

Pages under `/admin` (layout + each page check `resolveSuperAdminPageAccess`
via `requireSuperAdminPage`); APIs under `/api/admin/*` (each handler calls
`requireSuperAdmin()`, which re-reads the role, active flag and token version
from the database). Business roles (`owner`, `manager`, `staff`) never grant
access.

| Page | API | Writes? |
|---|---|---|
| `/admin` overview: totals, date-range activity, payment summaries, daily charts, alerts, recent activity | `GET /api/admin/overview?from&to` | No |
| `/admin/businesses` search / filter / sort; `/admin/businesses/[id]` detail | `GET /api/admin/businesses` (unchanged), `GET /api/admin/businesses/[id]` | Suspend / reactivate only, via the existing audited `PATCH /api/admin/businesses?id=` |
| `/admin/users` | `GET /api/admin/users`, `PATCH /api/admin/users/[id]` | Account actions (deactivate, reactivate, grant/revoke super admin, force sign-out), audited; see `docs/security-monitoring.md` |
| `/admin/payments` (subscription billing, online store orders, disputes) | `GET /api/admin/payments?domain=subscription|order|dispute` | No (by design) |
| `/admin/disputes/[id]` | `POST /api/admin/disputes/[id]/notes` | Internal notes only (audited); status comes from Razorpay |
| `/admin/security` | `GET /api/admin/security-events` | No |
| `/admin/plans` | `GET/POST/PATCH /api/admin/plans` (unchanged, audited) | Plans |
| `/admin/audit` (filters: action, target, actor, dates) | `GET /api/admin/audit-logs` (+ optional strict filters) | No |

Read-only data comes from `backend/lib/admin/control-center.ts`.

`/admin/ai-usage` shows stored AI request counters (per business, plan, kind of
request and month) and businesses near their allowance: read-only, no prompts,
generated text or estimated costs. See `docs/ai-website-builder-plan.md`.

## Rules these views follow

- **Money is never mixed or estimated.** Per currency, split into:
  provider-recorded subscription payments; manual/sandbox subscription
  activations (labelled "not real money"); store orders paid online
  (Razorpay-verified); store orders paid cash on delivery (owner-confirmed).
  Store-order money belongs to each business, not SiteForge.
- **Data minimisation.** Never returned: password hashes, token versions,
  sessions, encrypted payment secrets, order proofs/owner tokens, payment link
  URLs. Business detail shows recent orders without shopper names or emails.
  User and owner emails are shown (needed to administer accounts).
- **Search input** is regex-escaped (`escapeRegex`); page filters fall back to
  defaults on bad input, while the audit API rejects bad filters with 422.
- **No new indexes.** Queries are admin-only and paginated/capped; date-range
  counts may scan. Add indexes only through an approved operation.
- **Alerts:** failed super-admin password confirmations, online payments that
  need review, open payment disputes, accounts under repeated failed sign-ins,
  past-due subscriptions, published businesses without an active plan
  (offline storefronts), suspended businesses.

## Not implemented (spec items left open)

- Real SaaS billing provider, renewals, trials (no provider; see
  `docs/ecommerce-payments-status.md`).
- Live dispute synchronisation has not been exercised against Razorpay.
- Security events do not record rate-limited attempts or invalid session
  signatures (see `docs/security-monitoring.md`).
- The very first super admin is still created only by `backend/scripts/create-admin.ts`.
