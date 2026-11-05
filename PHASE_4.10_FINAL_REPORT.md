# Phase 4.10 — SiteForge Security Hardening (Part 1 + Part 2) — Final Report

## 1. Configuration findings

### Security headers added (`next.config.mjs`)
- `async headers()` middleware added, matching every route (`/(.*)`)
- Five response headers baked into `.next/routes-manifest.json`:
  - `Content-Security-Policy` (detailed below)
  - `Strict-Transport-Security` (production-only: `max-age=63072000; includeSubDomains`; `max-age=0` outside)
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
- **Active at runtime**: verified live on `next start` with full header presence on all routes (login, API, dashboard, storefront).

### CSP specifics
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:;
  connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```
- `upgrade-insecure-requests` only in production (would break `npm run dev`).
- `'unsafe-inline'` on `script-src` and `style-src` is deliberately documented as a **known limitation** — Next.js injects inline bootstrap scripts; themes render inline `style={{…}}` attributes. A per-request nonce would require middleware architectural changes beyond this phase. See `next.config.mjs` for the full discussion.

### HSTS
- Production only: `max-age=63072000; includeSubDomains` when deployment terminates TLS.
- Development: `max-age=0` (no-op on localhost HTTP). `preload` intentionally omitted (irreversible).

### `images.remotePatterns`
- Changed from `[{ protocol: "https", hostname: "**" }]` → `[]`.
- **No `next/image` usage** anywhere in the repo: all product images / business logos render via plain `<img src={…}>` across all five themes and dashboard/product detail pages.
- The empty list is **harmless** — Next.js only enforces remotePatterns when entries exist, and `localPatterns` is left at its default (undefined), so `next/image` can still serve `/public/*` paths if adopted later.
- No compatibility breakage observed; `next build` and `next start` complete successfully.

### URL protocol validation (`lib/validation.ts`)
- New `imageUrlSchema`: `z.string().trim().url().refine(v => new URL(v).protocol === "https:", …)` — only https accepted.
- New `optionalImageUrlSchema`: accepts `imageUrlSchema`, `""`, or `undefined`. Preserves the exact existing contract (blank clears, absent leaves the field).
- `businessUpdateSchema.logoUrl` → `optionalImageUrlSchema`
- `productCreateSchema.imageUrl` → `optionalImageUrlSchema`
- `productCreateSchema.images` → `z.array(imageUrlSchema).max(10).optional()`
- Rejects: `javascript:`, `data:`, `ftp:`, `file:`, `vbscript:`, `mailto:`, `tel:`, protocol-relative (`//example.com`), scheme-less (`/images/a.png`), and plain `http:`.
- All 17 new unit tests pass (see §6).

### TRUSTED_IP_HEADER (`.env.example`)
- Added deployment-prerequisite documentation: set the exact header name that your reverse proxy / PaaS sets to the real client IP; leave blank in development to use shared bucket; in production, missing → `503 rate_limit_misconfigured`.
- No values, no secrets, no `.env.local` changes.

## 2. Runtime pages and flows actually tested (Phase 4.10 Part 2)

All testing performed against a local MongoDB replica set (via `mongodb-memory-server`) + `next start` on port 4321, with `TRUSTED_IP_HEADER=x-real-ip` simulating a properly-configured deployment.

| Test category | Result |
|---|---|
| Login / register pages render (GET `/login`, GET `/register`) | ✅ 200 |
| Marketing home page renders (`/`) | ✅ 200 |
| Authenticated session persists via cookies (`/api/auth/me`) | ✅ 200 |
| Unauthenticated API calls → 401 | ✅ |
| Create business with free plan auto-attach → 201 | ✅ |
| Product create with HTTPS imageUrl → 201 | ✅ |
| Product create with `javascript:`, `data:`, `http:` imageUrl → 422 (protocol rejected) | ✅ |
| Product create with HTTPS `images[]` array → 201 | ✅ |
| Product create with bad schemes in `images[]` → 422 | ✅ |
| Product imageUrl `""` → clears field → 201 | ✅ |
| Business logoUrl `javascript:`, `data:`, `http:` → 422 | ✅ |
| Business logoUrl https → 200 | ✅ |
| Business logoUrl `""` → clears field → 200 | ✅ |
| Dashboard pages (login required) → 200 | ✅ |
| Published storefront renders with HTTPS logo and product `<img>` tags | ✅ |
| Storefront only shows active products; draft/inactive are excluded | ✅ |
| Product detail page renders HTTPS images; draft slugs → 404 | ✅ |
| Tenant subdomain rewrite (`x-middleware-rewrite: /store`) works | ✅ |
| Security headers on every response (CSP, HSTS, nosniff, frame-deny, referrer) | ✅ |
| Logout invalidates session + dashboard redirects (307) | ✅ |
| Draft business → storefront 404 (entitlement check blocks) | ✅ |
| Published business with NO subscription → storefront 404 | ✅ |
| Published business with cancelled subscription → storefront 404 | ✅ |
| Suspended business → storefront 404 | ✅ |
| All five themes render via ThemeEditor live preview (Aurora, Market, Bistro, Studio, Launch) | ✅ |

### Regression checks — all pass
- No authentication logic changed
- No payment/membership/billing code changed
- No tenant isolation / subdomain rewrite breakage
- Rate-limit fail-closed behaviour confirmed (503 without trusted header; works with `x-real-ip`)

## 3. Confirmed regressions — minimal fix

**No regressions introduced.** The only change to runtime behaviour is that previously-accepted `javascript:`/`data:`/`http:` URLs for logo and product images are now rejected at the API boundary, with a clear error message `"Only https:// URLs are allowed"`. All existing valid URLs (https only) continue to work. No code path that was working before now breaks.

## 4. Files changed

| File | Change |
|---|---|
| `next.config.mjs` | Added `buildSecurityHeaders()` + `async headers({ source: "/(.*)", headers: buildSecurityHeaders() })`; replaced `hostname: "**"` with `remotePatterns: []`; documented CSP `unsafe-inline` limitation inline; removed invalid `/** @type {...} */` JSDoc cast. |
| `lib/validation.ts` | Added `imageUrlSchema` (https-only protocol refine); `optionalImageUrlSchema` (imageUrlSchema ∨ "" ∨ undefined); rewired `businessUpdateSchema.logoUrl`, `productCreateSchema.imageUrl`, `productCreateSchema.images`. |
| `tests/unit/security-headers.test.ts` | **New** — 9 tests asserting the header config, CSP directives (production vs development), CSP limitations, and `remotePatterns` emptiness. |
| `tests/unit/validation-url-protocols.test.ts` | **New** — 8 tests over accepted/rejected protocols, optional/empty handling, and cross-field consistency. |
| `.env.example` | Added TRUSTED_IP_HEADER deployment-prerequisite docs with smoke-test guidance. |
| No other files changed (no schema/index/migration changes, no auth/payment/membership/billing edits, no `.env.local` modifications). |

## 5. Actual results for all six verification commands

| Command | Exit code | Result |
|---|---|---|
| `npm run test:unit` | **0** | 124/124 pass (107 baseline + 17 new protocol + security-header tests) |
| `npm run test:integration` | **0** | 142/142 pass — membership-concurrency, role-change, webhook, and authorization suites all green |
| `npm run test:all` | **0** | 124 + 142, 0 failures |
| `npm run typecheck` | **0** | `tsc --noEmit` clean (no stray `process.env` assignments from temp fixtures). |
| `npm run lint` | **0** | `✔ No ESLint warnings or errors` |
| `npm run build` | **0** | Compiled successfully; all 16 routes compiled; headers baked into manifest. |

## 6. Remaining limitations and security risks

| Issue | Severity | Status |
|---|---|---|
| CSP `'unsafe-inline'` for `script-src`/`style-src` | P3 | Documented limitation; nonce migration out of scope for this phase. |
| No server-side proxy for arbitrary product/logo image hosts | P3 | Allowed by design (plain `<img>`); safe per-product protocol validation already in place. |
| No Origin/CSRF token defence-in-depth beyond SameSite=Lax | P3 | Unchanged; Lax already mitigates cross-site POST. |
| Login timing side-channel observation | P3 (audit note) | Confirmed not exploitable; no code change needed. |
| `extractSubdomain` comment/code mismatch in `lib/host.ts` | P3 | Cosmetic; not exploitable. |
| No real `next/image` usage; `remotePatterns: []` is benign but could be confusing if `next/image` is ever adopted without also populating the list | P3 | Documented; if `next/image` is added later, populate `remotePatterns` with explicit hostnames or proxy bytes through an upload route. |
| `TRUSTED_IP_HEADER` still a production deployment prerequisite (not configured here) | P2 | Handled via `.env.example` documentation only. |

## Summary
- Security headers are live and verified at runtime.
- CSP is strict where it matters (blocking object/base forgery, foreign framing, mixed-content images), and deliberately permissive only where Next.js and the themes require `'unsafe-inline'` (with full documentation).
- Image URL schemas now reject `javascript:`, `data:`, `http:` and other dangerous schemes at the API boundary, preserving the exact optional/empty contract.
- `images.remotePatterns` is safely reduced to `[]` because the app uses plain `<img>` elements, not `next/image`.
- TRUSTED_IP_HEADER deployment prerequisites are documented; no secrets introduced.
- All six verification commands pass (0 exit codes, all tests green).
- No regressions; no new dependencies; no schema/migration changes.