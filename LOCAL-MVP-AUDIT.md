SiteForge Local MVP Completion Audit - COMPLETE

Audit Date: Current session
Source: Read-only code inspection + automated test verification

EXISTING FEATURES VERIFIED (source code confirmed):
- Business creation with owner membership + free plan subscription
- Product CRUD with price, currency, stock, images, SKU, category, status
- Product inventory tracking via `stock` field
- Subscription plans with feature limits (productLimit, staffLimit, etc.)
- Manual/sandbox billing activation (PAYMENT_PROVIDER=manual)
- Entitlements derivation (productLimit, staffLimit, customDomain, removeBranding)
- Membership roles (owner, manager, staff) with role-gated API access
- Media S3 upload/delete with reference protection & pending cleanup
- Pages CRUD with role-based permissions
- Rate limiting with TRUSTED_IP_HEADER mandatory in production
- Email transports (Resend/prod, console/dev, memory/tests); fail-closed in prod
- Last-owner protection via MongoDB transactions
- Cross-tenant isolation at all write boundaries

TEST RESULTS (automated, all pass):
- npm run test:unit: 320 passed, 0 failed
- npm run test:integration: 265 passed, 0 failed
- npm run typecheck: passed
- npm run lint: no errors
- npm run build: compiled successfully in 20.1s

CONFIRMED MISSING FEATURES:
- Shopping cart (no cart model, no cart API)
- Order model (no Order schema, no order creation API)
- Order items/line items (no line-item schema with price snapshots)
- Checkout flow (no checkout API; only manual subscription activation)
- Customer order history (no way to query orders by customer)
- Inventory reduction on purchase (stock never decreases)
- Order status lifecycle (no Order model = no status tracking)
- Storefront customer payments (no purchase mechanism in storefront)

RECOMMENDED 3-PHASE IMPLEMENTATION PLAN:

Phase A — Local Media Development Support (smallest safe change)
- Add NEXT_PUBLIC_LOCAL_MEDIA_URL to .env.local
- 3-line dev-mode check in lib/s3.ts getS3PublicBaseUrl
- Zero production behavior changes; S3 remains production path
- Enables local dev without AWS credentials

Phase B — Minimal Cart & Order Infrastructure
- NEW models/Order.ts with items, price snapshots, status
- NEW app/api/businesses/[id]/orders/route.ts (create/list)
- NEW app/api/businesses/[id]/checkout/route.ts (cart validation, price snapshots, manual activation)
- MODIFY lib/billing.ts (assertCanCreateOrder), lib/validation.ts (new schemas)
- Leverages existing action-tokens for duplicate submission protection

Phase C — Customer Order History (post-Phase B)
- Link Customer to orders (optional reference field)
- GET /api/customers/me/orders endpoint
- Storefront order history view

SECURITY & DATA INTEGRITY:
- Tenant isolation via requireBusinessRole() — authoritative
- Price snapshots at purchase time — prevents later price changes
- Duplicate submission protection via existing action token pattern
- Fail-closed billing (isManualBillingAllowed(), production guards)
- Last-owner transactional protection
- Cross-tenant rejection on all write boundaries

RECOMMENDED NEXT STEP: Phase A — Add local media development support.
1. Add NEXT_PUBLIC_LOCAL_MEDIA_URL=http://localhost:3000/media to .env.local
2. Add 3-line dev check in lib/s3.ts getS3PublicBaseUrl
3. Verify npm run build passes
4. Run npm run test:unit && npm run test:integration (all 585 tests should pass)
5. Proceed to Phase B — Minimal Cart & Order Infrastructure

No code changes were made during this audit. All findings are from read-only source inspection and automated test verification.