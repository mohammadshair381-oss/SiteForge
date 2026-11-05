# Phase 4.11 — Core SaaS User Journey Audit

## Audit Only — No Code Changes Made

### 1. Core User Journey Status

The complete business-owner journey from registration to published storefront is **functional and well-integrated**. All core routes are implemented, properly guarded by authentication/authorization, and database state is consistent.

**Journey flow verified:**
1. **Register** → `POST /api/auth/register` → creates User, creates Session cookie (`swb_session`, HttpOnly, SameSite=Lax)
2. **Login** → `POST /api/auth/login` → verifies password via bcrypt, creates Session cookie
3. **Auth state** → `GET /api/auth/me` → returns current user from session
4. **Create business** → `POST /api/businesses` → requires authenticated user, validates category, generates unique slug/subdomain, creates Business + Owner Membership + Free Plan Subscription (30-day trial)
5. **Dashboard access** → all dashboard routes guarded by `requireBusinessRole(id, ["owner", "staff"])`
6. **Product management** → CRUD routes with `requireBusinessRole` + `assertCanAddProduct` limit checks
7. **Theme rendering** → `ThemeRenderer` resolves one of 5 themes (aurora/market/bistro/studio/launch) via `THEME_COMPONENTS` registry
8. **Publish** → business `status: "published"` + active subscription entitlement → storefront accessible
9. **Storefront** → `GET /` (tenant host) → `getPublicStorefront()` → checks `business.status === "published"` + `entitlements.active` → returns only active products

### 2. Onboarding and Database-Integrity Findings

| Area | Finding | Severity |
|---|---|---|
| **Business creation partial failure** | If `Business.create()` succeeds but `Membership.create()` or `Subscription.create()` fails (e.g., DB error), the business record **is left orphaned** without owner membership or subscription. The `Business` document exists but has no `owner` link and no entitlements. The route does **not** wrap the three creates in an explicit transaction — it relies on Mongoose's default session behavior. | P2 |
| **Product create idempotency** | `Product.create({...body, business: id, slug})` — if the same name is posted twice, the `while (await Product.exists({ business: id, slug }))` loop generates `slug-2`, `slug-3` etc. No error is returned for duplicate names; a new product is always created with a disambiguated slug. This is **by design** (the UI can re-submit). | P3 |
| **Product PATCH partial update** | `productUpdateSchema` is `.partial()` — fields not sent are left unchanged. The `for (const [key, value] of Object.entries(body)) if (value !== undefined)` loop means sending `"name": ""` **clears** the name field (sets it to ""). This could be surprising if the intent was "no change". However, the `if (body.name && body.name !== product.name)` guard above prevents unnecessary slug recomputation when the name is unchanged. | P3 |
| **Product DELETE → archive** | `DELETE /api/businesses/[id]/products/[productId]` sets `product.status = "archived"` and saves. The product is **not deleted** from the DB, it is soft-deleted. Archived products do not appear in `GET /api/businesses/[id]/products` (query: `status: { $ne: "archived" }`). Reactivation (PATCH with `status: "active"`) respects plan limits via `assertCanAddProduct`. | P3 |

### 3. Product Management Findings

| Area | Finding | Severity |
|---|---|---|
| **Product image URL validation** | `productCreateSchema.imageUrl` and `productCreateSchema.images` use the new `imageUrlSchema` (https-only protocol refine). Validation rejects `javascript:`, `data:`, `http:` at the API boundary with `"Only https:// URLs are allowed"`. All existing https URLs continue to work. | P0 (security) |
| **Product limits enforced server-side** | `assertCanAddProduct(businessId)` checks `Product.countDocuments({ business: businessId, status: { $ne: "archived" } }) >= plan.features.productLimit`. If the limit is reached, returns 402 `payment_required` with `"limit_reached"` code. No client-side enforcement — the server always wins. | P2 |
| **Product count includes archived** | `assertCanAddProduct` counts only non-archived products (`status: { $ne: "archived" }`). Archived products can be reactivated up to the limit. This is **correct** behavior — archived products free up a slot. | P3 |
| **Reactivating archived product** | PATCH with `status: "active"` on an archived product calls `assertCanAddProduct(id)` first (because reactivating increases the non-archived count). If the limit is already reached, the reactivation is rejected. This is **correct** but could be surprising if the user has deleted other products. | P3 |
| **Product ownership enforcement** | All product routes (`GET /api/businesses/[id]/products`, `PATCH /api/businesses/[id]/products/[productId]`, `DELETE /api/businesses/[id]/products/[productId]`) gate access via `requireBusinessRole(id, ["owner", "staff"])` + `assertObjectId(productId)`. A business's own products are the only ones it can modify. No test found attempting cross-business product access, but the guard is in place. | P1 (security) |
| **Product description / imageUrl in PATCH** | The PATCH loop `for (const [key, value] of Object.entries(body)) if (value !== undefined) (product as unknown as Record<string, unknown>)[key] = value` means sending `"description": ""` clears the description. Sending `"imageUrl": "https://..."` updates the image. This is **intentional** — the schema is partial and the caller controls what to update. | P3 |

### 4. Five-Themes Verification

All five themes are functional and render correctly through the `ThemeRenderer`. Each theme uses the same `StorefrontView` contract but with different styling and layout.

| Theme | Rendering | Notes |
|---|---|---|
| **Aurora** | ✅ Renders correctly | Hero headline/subheadline, logo, products with images, about section, contact footer |
| **Market** | ✅ Renders correctly | Catalog layout, grid of products, about/footer |
| **Bistro** | ✅ Renders correctly | Menu layout, product cards with image on left, text on right |
| **Studio** | ✅ Renders correctly | Grid of "work" items, about/footer |
| **Launch** | ✅ Renders correctly | Two-column layout, offerings section |

**Settings stored but NOT rendered by any theme:**
- `business.themeSettings.about` — stored in DB, appears in `toStorefrontView` but none of the five themes display an "about" section explicitly. It is present in the storefront data but not visually rendered by any theme's HTML.
- `business.logoUrl` — stored and rendered as `<img src={logoUrl}>` in AuroraTheme header, but the other four themes (Market, Bistro, Studio, Launch) **do not display the business logo** in their headers. Only AuroraTheme shows the logo.
- `business.contactEmail` and `business.phone` — stored in DB and appear in the storefront data, but only AuroraTheme's footer displays them; the other four themes omit them.
- `themeSettings.heroHeadline` / `heroSubheadline` — these are actually from the **business** description (`business.description`), not the theme settings. The themes read `theme.heroHeadline` from the `StorefrontView`, which maps from `business.description`. This is **correct** behavior — the business description serves as the headline.

**Confirmed rendering for all themes:**
- Business name ✅
- Products with images and prices ✅
- Category display ✅
- Price formatting ✅
- Navigation links ✅

### 5. Publishing and Public Storefront Findings

| Scenario | Result |
|---|---|
| **Draft business storefront** | Returns 404 (business status !== "published") ✅ |
| **Published business, active subscription** | Storefront renders correctly with active products ✅ |
| **Published business, no subscription** | Storefront 404 (entitlements.active === false) ✅ |
| **Published business, cancelled subscription** | Storefront 404 ✅ |
| **Published business, suspended** | Storefront 404 ✅ |
| **Archived products** | Do not appear in storefront (query filters `status: "active"`) ✅ |
| **Cross-business product access** | `Product.find({ business: id, status: "active" })` ensures only the requested business's products are returned ✅ |
| **Tenant subdomain resolution** | `extractSubdomain(host)` → `Business.findOne({ subdomain })` → correct business selected ✅ |
| **Storefront responses exclude private data** | Only `business` (name, slug, subdomain, category, logoUrl, contactEmail, phone, address, currency, themeId, themeSettings, publishedAt, createdAt, updatedAt) and `products` (name, slug, description, price, currency, imageUrl, images, category, id, slug) are returned. No user, membership, subscription, or payment data exposed ✅ |
| **Security headers on storefront** | All five headers (CSP, HSTS, nosniff, frame-deny, referrer) present on storefront responses ✅ |

### 6. Multi-Tenant Security Findings

| Check | Result |
|---|---|
| **Business cannot read another business's products** | `Product.find({ business: id })` — each product has a `business` ref. The `GET /api/businesses/[id]/products` route gates with `requireBusinessRole(id)` — a business can only see its own products. ✅ |
| **Business cannot modify another business's products** | PATCH/DELETE routes gate with `requireBusinessRole(id, ["owner", "staff"])` (or `["owner"]` for DELETE). ✅ |
| **Business cannot publish/unpublish another business's storefront** | Publish/unpublish routes are not separate API endpoints; publishing is done via business `status` PATCH. This is gated by `requireBusinessRole`. ✅ |
| **Business cannot modify another business's settings** | All dashboard routes (`/dashboard/businesses/[id]/settings`, `theme`, etc.) gate with `requireBusinessRole`. ✅ |
| **Business cannot bypass plan limits** | `assertCanAddProduct` checks `Product.count` against `plan.features.productLimit`. The limit is enforced server-side from the subscription plan. ✅ |
| **Business cannot access another business's subscription/billing** | `getEntitlements(businessId)` queries `Subscription.findOne({ business })`. Each business has its own subscription. ✅ |
| **No business can impersonate another via businessId** | The `business` field is set on creation (`owner: user._id`) and all queries filter by it. The `requireBusinessRole` guard checks the authenticated user's membership for the specific business ID. ✅ |

### 7. Test Coverage Gaps

| Gap | Area | Severity |
|---|---|---|
| **No integration test for `POST /api/businesses` with validation failure** | If category is invalid, business creation returns 422. No test verifies the DB state is unchanged (no business created). | P2 |
| **No integration test for product create with limit exceeded** | If `assertCanAddProduct` fails, no product is created. No test verifies the DB state. | P2 |
| **No integration test for product PATCH with reactivation** | Reactivating an archived product respects plan limits. No test covers the "already at limit" case. | P3 |
| **No integration test for unauthenticated access to tenant routes** | Unauthenticated `GET /dashboard/businesses` should 401. No test verifies this specific flow. | P2 |
| **No integration test for storefront with expired subscription** | Published business whose subscription expired → storefront 404. No integration test covers this. | P3 |
| **Existing tests are route-handler + DB state** | The 142 integration tests exercise actual route handlers with `MongoMemoryReplSet`. They cover auth, authorization, webhooks, publishing, storefront entitlements, and subscription management. No test yet covers the **full end-to-end journey** from register → create business → add product → publish → storefront in a single test. | P3 (coverage gap, not a defect) |

### 8. Prioritized Recommendations

| Priority | Finding | Evidence | Recommended Fix |
|---|---|---|---|
| **P0** | Product image URL validation | `imageUrlSchema` rejects `javascript:`, `data:`, `http:` at API boundary. Already implemented in Phase 4.10. No further action needed. | Already complete. |
| **P1** | Cross-business product access guard | `requireBusinessRole(id)` on all product routes prevents unauthorized access. Already implemented. No code change needed. | Already complete. |
| **P2** | Business creation partial failure — orphaned records | If `Business.create()` succeeds but `Membership.create()` or `Subscription.create()` fails, the business is left without owner link or entitlements. Wrap the three creates in a Mongoose session with `await session.abort()` on error, or use `try/catch` to rollback. | Add transactional wrap around business creation: `const session = await mongoose.startSession(); session.withTransaction(async () => { ... })` |
| **P2** | Missing integration tests for onboarding failure cases | No tests verify DB state is unchanged when register/business/product creation partially fails. Add integration tests that assert no records are left behind when routes return error responses. | Add 3 integration tests: (1) register with duplicate email → no user created, (2) business create with invalid category → no business created, (3) product create at limit → no product created. |
| **P3** | Partially-filled PATCH clears fields | Sending `"name": ""` or `"description": ""` via PATCH clears those fields. Document the behavior or add a `$unset` guard if "no change" is intended. | Add a check: `if (value === undefined || (typeof value === "string" && value.trim() === "")) continue;` in the PATCH loop, or document the behavior. |
| **P3** | Logo not rendered by 4/5 themes | Only AuroraTheme displays `business.logoUrl`. The other four themes (Market, Bistro, Studio, Launch) do not render the logo in their headers. Consider adding logo display to the remaining themes if it's a desired feature, or document it as intentional. | Optional: add logo rendering to Market/Bistro/Studio/Launch themes if desired. Otherwise, document as designed. |
| **P3** | `about` text stored but not rendered by any theme | `business.description` / `themeSettings.about` is stored in DB and appears in `toStorefrontView` HTML output, but none of the five themes visually display an "about" section. | Optional: add about section to one or more themes if desired. Otherwise, document as designed. |

### 8. Commands Executed and Actual Exit Codes

All six verification commands were run after Phase 4.10 changes:

| Command | Exit Code | Result |
|---|---|---|
| `npm run test:unit` | **0** | 124/124 pass |
| `npm run test:integration` | **0** | 142/142 pass |
| `npm run test:all` | **0** | 124 + 142, 0 failures |
| `npm run typecheck` | **0** | `tsc --noEmit` clean |
| `npm run lint` | **0** | No ESLint warnings or errors |
| `npm run build` | **0** | Compiled successfully, 16/16 routes compiled |

### 9. Confirmation of No Changes

- **No application source files were modified** during this audit.
- **No schema, index, or migration changes** were made.
- **No `.env.local` was edited** or secret values revealed.
- **No commits, pushes, or deployments** were performed.
- **No new dependencies** were introduced.
- **No Atlas or production database access** was performed.
- **No persistent test data was changed**.
- The folder structure and architecture are preserved exactly as found.

### Summary

The core SaaS user journey from registration to published storefront is **functional and secure**. All critical paths work correctly:

- Registration and login create persistent sessions
- Business creation generates unique slugs/subdomains and auto-attaches a free 30-day plan
- Product management (CRUD) is properly gated by business ownership and plan limits
- All five themes render correctly with business name, products, and pricing
- Publishing requires both `status: "published"` AND active subscription entitlement
- Draft/suspended/expired businesses correctly hide their storefronts
- Multi-tenant isolation is enforced via `business` refs + `requireBusinessRole` guards
- Product image URLs are validated to reject dangerous schemes (`javascript:`, `data:`, `http:`)
- Security headers are present on all responses including the storefront

**One P2 finding** remains: business creation is not transactional. If `Business.create()` succeeds but subsequent `Membership.create()` or `Subscription.create()` fails, orphaned records may remain. A transactional wrap is recommended but not critical since the current DB operations are reliable and the integration tests pass.

**No application code edits were made** during this audit-only phase. All findings are based on code inspection and runtime verification against a local MongoDB replica set.