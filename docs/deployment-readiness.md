# Deployment readiness checklist (Phase 5)

Source: the Phase 5 hosting audit (target: Vercel + MongoDB Atlas + Cloudflare
R2 + Resend; Vercel Hobby only while the project is non-commercial). Nothing in
this file has been implemented unless marked **Done**. Items marked **Approval**
need an explicit go-ahead because they change runtime behaviour, cost money or
touch external services.

For the overall local / staging / production exit criteria (database indexes,
email, customer accounts, online payments), see `docs/launch-checklist.md`.

Correction to the Phase 5 audit: `AWS_S3_BUCKET` and `AWS_S3_PUBLIC_URL` *are*
present in `.env.example` (lines 115 and 120). The audit's key scan used
`[A-Z_]+`, which skipped names containing digits.

## 1. S3-compatible storage for Cloudflare R2 — **Done**

- `backend/lib/s3.ts`: `buildS3ClientConfig()` / `resolveS3Bucket()` / `getS3PublicBaseUrl()`
  read `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_BUCKET`, `S3_PUBLIC_URL`, with fallback to the legacy `AWS_*` names.
- `S3_ENDPOINT` (optional) must be an `https` origin without credentials, path,
  query or fragment; R2 = `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, and
  the region then defaults to `auto`. Unset = AWS S3 exactly as before.
- Legacy `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are used
  only outside production and never when `VERCEL` is set, so Vercel-injected
  values cannot hide missing storage config (production needs `S3_*`).
  `AWS_S3_BUCKET` / `AWS_S3_PUBLIC_URL` fall back everywhere.
- Logs name variables only. `backend/lib/media-references.ts` ownership checks read the
  same public-URL setting via `configuredMediaPublicBaseUrl()`.
- Not changed (paused AI work): `backend/lib/ai-planning/context.ts` still reads only
  `AWS_S3_PUBLIC_URL`; set it alongside `S3_PUBLIC_URL` if the AI planner is
  ever re-enabled.
- Tests: `tests/unit/s3-config.test.ts`, `tests/unit/media.test.ts`,
  `tests/integration/media.test.ts`, `tests/integration/media-references.test.ts`.

### Storage migration procedure (AWS S3 -> R2)

`S3_LEGACY_PUBLIC_URL` (optional) keeps media ownership checks applying to
URLs stored under the old bucket's public URL; without it those URLs would be
treated as external images. Each match must still name the current tenant's id
and an existing Media record (`tests/unit/media-legacy-url.test.ts`, migration
tests in `tests/integration/media-references.test.ts` / `media.test.ts`).

1. Copy every object to R2 with the SAME keys (`media/<businessId>/<file>`);
   keep the old bucket readable.
2. Set `S3_*` to R2 and `S3_LEGACY_PUBLIC_URL` to the old public base URL.
3. Stored product/page/logo URLs keep pointing at the old bucket and keep
   working; new uploads use R2. Media deletion counts references in either
   form, so in-use media cannot be deleted.
4. Optional later (needs approval, data change): rewrite stored URLs from the
   old base to the new one, verify, then remove `S3_LEGACY_PUBLIC_URL` and retire
   the old bucket. Not implemented here.

## 2. Upload size vs. platform limit — **Done** (4 MiB)

- `MAX_MEDIA_BYTES` and the client `MEDIA_MAX_UPLOAD_BYTES` are 4 MiB; UI and
  `.env.example` copy say 4 MB. The early `Content-Length` guard now allows a
  64 KiB multipart envelope (was 1 MiB), so 4 MiB + envelope stays under
  Vercel's 4.5 MB body limit.
- Presigned direct uploads remain unimplemented (needs CSP + bucket CORS).
- Tests: exactly 4 MiB accepted; 4 MiB + 1 byte -> 413 with storage never
  called; oversized declared length rejected early; client = server limit.

## 3. MongoDB connection pool — **Done**

- `backend/lib/db.ts#buildMongooseOptions`: `bufferCommands: false` (unchanged),
  `maxPoolSize` default 10 (`MONGODB_MAX_POOL_SIZE`, validated 1-50 in
  `backend/lib/env.ts`), `maxIdleTimeMS: 60000`.
- Automatic index and collection creation is off in production and for any
  database reached over a network. The core unique indexes must exist before
  the first start, and the app refuses to work without them. See
  `docs/database-preparation.md` → "Automatic index policy".
- Remaining recommendation (needs approval): separate production cluster;
  strong, least-privilege database user with no index privileges (Atlas must
  allow `0.0.0.0/0` on Vercel).
- Tests: `tests/unit/mongo-options.test.ts`; every integration test connects
  through these options.

## 4. `.env.example` — **Done** (this task)

- Added `LOCAL_MEDIA_ENABLED=false` (dev-only disk media; production ignores it).
- Documented the `create-admin` fallbacks `ADMIN_EMAIL` / `ADMIN_NAME` /
  `ADMIN_PASSWORD` as commented-out lines with a warning never to keep
  `ADMIN_PASSWORD` in an env file.
- Deliberately NOT added: `NODE_ENV`, `NEXT_RUNTIME` (set by the runtime),
  `CONFIRM_DOMAIN_MIGRATION` (a per-command safety gate),
  `GEMINI_API_KEY` (paused AI work).
- Later added with their code changes: the `S3_*` storage block and
  `MONGODB_MAX_POOL_SIZE`.

## 5. `.gitignore` hardening — **Done** (this task)

Now ignored: every `.env*` variant except `.env.example`; `*.key`, `*.p12`,
`*.pfx` (plus existing `*.pem`); `*.log`; `media-dev/` and `/public/uploads`;
database exports (`/dump/`, `/backups/`, `*.bson`, `*.archive`); generated test
/ build output files at the repo root; `/coverage/`; `/.vercel/`, `/.wrangler/`;
`Thumbs.db`, `desktop.ini`. Verified in a throwaway copy (empty placeholder
files, no contents) that no source file is ignored.

## 6. Tenant-aware sitemap, robots.txt, canonical URLs — **Done**

- `middleware.ts` passes `/robots.txt` and `/sitemap.xml` through on every host
  (previously rewritten to `/store/...` and 404 on storefronts).
- `app/robots.ts`, `app/sitemap.ts` (request-dependent via `headers()` plus
  `dynamic = "force-dynamic"`) delegate to `backend/lib/seo.ts`:
  - platform host: platform policy, sitemap `/`, `/register`, `/terms`, `/privacy`;
  - storefront host: only when `getPublicStorefront(host)` passes (published,
    not suspended, entitled, custom domain verified/fresh). Sitemap = published
    homepage as `/`, published pages that render visible sections and are not
    shadowed by storefront routes, active products. No `lastModified`. Served
    only on the canonical subdomain host;
  - anything else: `Disallow: /` and an empty sitemap.
- Canonical URLs (`alternates.canonical`, `og:url`) on storefront pages and
  products always use the tenant subdomain during the pilot
  (`storefrontOrigin()`), built from `NEXT_PUBLIC_ROOT_DOMAIN` when it is one of
  `ROOT_DOMAINS`. Switch to the active custom domain once custom domains are
  provisioned on the hosting platform.
- Tests: `tests/unit/seo-routes.test.ts`, `tests/integration/seo-routes.test.ts`.
- **Fixed:** published-page draft leak. The renderer and the sitemap share
  `resolvePublishedPageSections` (`backend/lib/sections.ts`) via
  `backend/lib/storefront-pages.ts`: the published snapshot is authoritative whenever
  the `publishedSections` field exists (even empty, which renders the theme
  default); only records without the field (written before snapshots existed)
  render their stored sections. Tests: `tests/unit/published-sections.test.ts`,
  `tests/integration/storefront-pages.test.ts`.

## 7. Email verification — configuration, Approval

- Without working email, new accounts stay unverified and
  `requireVerifiedEmail` blocks business creation, publishing and checkout.
- Production values: `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY` (Resend key),
  `EMAIL_FROM` on a domain verified in Resend (DNS records), `APP_URL` as an
  absolute `https://` URL. `console`/`memory` are refused in production.
- These are mandatory, since password reset needs an emailed code (signup and
  login use email and password only). Without them the startup check fails and requests answer HTTP
  500. The process may keep running and print "Ready", so that is not a sign of
  health. The check is structural only; see `docs/email-delivery.md` for the
  required health check, staging tests and outages.
- Resend free: 100 emails/day, 3,000/month; needs a domain you own.

## 8. Production env validation & trusted IP header — configuration, Approval

- Startup validation already exists (`instrumentation.ts` → `assertStartupEnv`,
  `assertEmailStartupConfig`); a production boot without `TRUSTED_IP_HEADER`
  makes rate-limited endpoints return 503. A failed startup check (for example
  no valid Resend configuration) makes requests answer HTTP 500 but does not
  stop the process: `next start` may still print "Ready".
- **Required:** a health or readiness check in the hosting platform that
  requests `/login` and requires HTTP 200, so an instance that fails it is
  marked unhealthy and gets no traffic (on serverless hosting: check the new
  deployment before promoting it). SiteForge does not configure this; the
  operator must. `/login` also needs MongoDB, so the check covers the database
  too. See `docs/email-delivery.md`, "Required: a deployment health check".
- On Vercel set `TRUSTED_IP_HEADER=x-vercel-forwarded-for`. Vercel overwrites
  `X-Forwarded-For` and does not forward external IPs (anti-spoofing);
  `x-real-ip` carries the same value, and `x-vercel-forwarded-for` stays
  correct even if another proxy sits in front
  (https://vercel.com/docs/headers/request-headers).
- Other production values: a NEW `SESSION_SECRET` (≥32 chars, never reuse the
  local one), `NODE_ENV=production` (set by the platform), `ROOT_DOMAINS`
  including both the apex and `www.` host (otherwise `www` is treated as a
  tenant subdomain), `NEXT_PUBLIC_ROOT_DOMAIN`, `PAYMENT_PROVIDER=manual`,
  `ALLOW_MANUAL_BILLING` unset.
- After deploy: `curl -i https://<host>/api/auth/login` must not return 503, and
  repeated requests must eventually return 429.

## 9. Backups, restore and key escrow — configuration, Approval

- Nothing exists yet: no backup tooling in the repository, no tested restore,
  no key escrow, and the real Atlas tier and backup settings are unknown.
  Atlas Free (M0) has no managed backups at all.
- Before launch: managed backups (M10+ with Continuous Cloud Backup
  recommended), an offsite encrypted export, `PAYMENT_CREDENTIALS_KEY` and
  `SESSION_SECRET` escrowed with recorded fingerprints, and one passed restore
  drill into an isolated cluster. A snapshot restore wipes its target cluster,
  so never restore onto production except as the deliberate recovery decision.
- A lost or different `PAYMENT_CREDENTIALS_KEY` makes every stored Razorpay
  secret unreadable, and nothing warns at startup. A different `SESSION_SECRET`
  resets coupon and guest-COD limits stored as keyed hashes and signs everyone
  out.
- Plan, runbook and drill: `docs/backup-and-disaster-recovery.md`.

## Version control — recommendation, Approval

- Git 2.51 is installed; the project is **not** a repository and no parent
  folder is one, so nothing has ever been committed.
- The project lives inside **OneDrive**. OneDrive already syncs `.env.local`
  (real credentials) to Microsoft's cloud, and a `.git` directory under
  OneDrive is prone to sync conflicts/corruption. Recommended: move (not copy)
  the project to a non-synced folder such as `C:\dev\siteforge` first, or at
  least exclude it from OneDrive sync, and consider rotating the credentials in
  `.env.local` if OneDrive sharing was ever enabled for this folder.
- Proposed sequence (each step after approval):
  1. `git init -b main` in the chosen directory.
  2. `git status --ignored` and confirm `.env.local`, `media-dev/` and output
     files show as ignored; `git add -A` then review `git diff --cached --stat`.
  3. Run a secret scan on the staged files before the first commit.
  4. Initial commit.
  5. Create a **private** remote (e.g. GitHub private repo) and push only after
     reviewing the staged file list. Enable secret scanning/push protection on
     the remote if available.
- Decide whether to track: `.agents/` + `skills-lock.json` (agent skills),
  `live-test.ts` / `live-test.mjs` (scratch scripts for the paused Gemini work;
  they read the key from `.env.local` and contain no secret), and the root
  `*_REPORT.md` / audit files.

## Known: React hydration error #418 on slow first loads

Rare, and harmless to content. Measured on a production build, on a fresh start with other
work running on the machine: 4, 4 and 7 errors per 150 page loads. Warm, including under heavy
CPU load: 0 in 360.

**Cause: a timing race in how Next.js and React start up, not a rendering difference.** On every
error, the final page text matched the server's, and React had already re-rendered before
`DOMContentLoaded`, sometimes with its route announcer mounted. So hydration began while Chrome was
still parsing the HTML, and React found less of the page than it expected. Holding Next's page data
back until parsing finished gave 0 errors in 150 loads on the same setup.

Ruled out: dates and locale (client components use fixed formats), external data, extensions (off in
the test browser), and streamed metadata (7 in 150 with it turned off).

Effect: React discards the server's markup for that load and renders in the browser. The page is
correct, with a slight repaint. No fix is in the code: the only one proven reaches into
`self.__next_f`, an internal of Next.js that can change in any release. Track the rate in production
error monitoring, and recheck on Next.js upgrades.
