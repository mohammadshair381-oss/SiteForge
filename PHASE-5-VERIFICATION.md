# Phase 5 — Final Verification Report
## SiteForge Role-Based Dashboard Smoke Test

**Date:** Wed Oct 21 2026
**Scope:** Verify Owner/Manager/Staff navigation, direct-route access, role changes, and last-owner protection.
**Methods:** Manual checklist + automated test suite (no browser automation available).

---

## 1. Checks Performed

### Automated Suite (already verified)
- `npm run test:unit`: **320 passed**, 0 failed
- `npm run test:integration`: **265 passed**, 0 failed
- `npm run typecheck`: passed
- `npm run lint`: No ESLint warnings or errors
- `npm run build`: Compiled successfully in 20.1s

### Manual Inspection (no browser automation)
- Verified source code for tab visibility logic in `BusinessTabs.tsx`
- Verified `requireBusinessRole()` guard in `lib/auth/guards.ts`
- Verified role-derived `canManage` expressions in all dashboard page handlers
- Verified tab `roles` arrays and `visibleBusinessTabs()` filter function
- Verified that no Playwright/Cypress/Puppeteer/browser tools exist in `node_modules/.bin` (confirmed: **none**)

### Defect Search
- Searched for any route that might bypass `requireBusinessRole` — none found.
- Verified that all `PATCH`/`DELETE` membership routes require `["owner"]`.
- Verified that manager/staff role checks use `roles.includes(membership.role)` — correct.

---

## 2. Results — Navigation Visibility

| Role | Expected Tabs | Actual (code-verified) | Pass/Fail |
|------|--------------|----------------------|-----------|
| **Owner** | Overview, Products, Media, Theme, Editor, Pages, Settings, Billing | All 8 tabs via `roles: ["owner","manager","staff"]` for Owner; Billing also has `roles: ["owner"]` only | ✅ PASS |
| **Manager** | Overview, Products, Media, Theme, Editor, Pages, Settings | 7 tabs: Billing hidden (`roles: ["owner"]`); all others include `"manager"` | ✅ PASS |
| **Staff** | Overview, Products, Media, Pages (read-only) | 4 tabs: Settings, Theme, Editor, Billing, domains/members hidden; Pages included as read-only | ✅ PASS |

**Tab `roles` arrays (BusinessTabs.tsx):**
- Overview: `["owner","manager","staff"]`
- Products: `["owner","manager","staff"]`
- Media: `["owner","manager","staff"]`
- Theme: `["owner","manager"]`
- Editor: `["owner","manager"]`
- Pages: `["owner","manager","staff"]`
- Settings: `["owner","manager"]`
- Billing: `["owner"]`

---

## 3. Results — Direct-Route Behavior

| Scenario | Expected | Evidence | Pass/Fail |
|----------|----------|---------|-----------|
| Manager enters `/dashboard/businesses/[id]/billing` manually | **403 forbidden** | `requireBusinessRole(id, ["owner"])` on billing page; role check rejects `"manager"` | ✅ PASS |
| Staff enters `/dashboard/businesses/[id]/settings` manually | **403 forbidden** | `requireBusinessRole(id, ["owner","manager"])` on settings page; `"staff"` rejected | ✅ PASS |
| Staff enters `/dashboard/businesses/[id]/products` | **200, read-only** | `requireBusinessRole(id)` default includes `"staff"`; `canArchive={owner||manager}` disables archive; PagesManager `canManage` disabled for staff | ✅ PASS |
| Owner enters any restricted route | **200, full access** | No role restriction; all `canManage`/`canArchive` expressions include `"owner"` | ✅ PASS |
| Cross-business membership modification (PATCH/DELETE with wrong business ID) | **403 / 404** | `assertObjectId` validates ID format; `Membership.findOne({business:id, user:user._id})` scopes to tenant; cross-business test in `membership-role-change.test.ts` confirms 403 | ✅ PASS |

**Key:** All API guards remain **authoritative**. UI visibility does not grant or bypass permissions.

---

## 4. Results — Role Changes & Access Enforcement

| Scenario | Expected | Evidence |
|----------|----------|----------|
| Demote owner → staff, then re-request protected route | **403** (staff cannot access owner-only routes) | Each request re-evaluates `membership.role` via `requireBusinessRole`; no session-level caching of role |
| Remove member, then re-request business dashboard | **403** (removed membership has `status: "inactive"`; `requireBusinessRole` checks `membership.status !== "active"`) | Verified in integration tests: `members DELETE` → subsequent requests 403 |
| Promote staff → manager, then check content tabs | **Manager tabs visible** (Overview, Products, Media, Theme, Editor, Pages, Settings) | Role changed in Membership document; `requireBusinessRole` now returns `"manager"`; `visibleBusinessTabs("manager")` renders 7 tabs |
| Last active owner cannot be demoted | **409 / forbidden** | `runSerializedMembershipMutation` in `lib/membership-transaction.ts` uses MongoDB transactions; concurrency tests prove at least one active owner remains | ✅ Documented (see Section 6) |

**Stale dashboard navigation:** No caching on the server. Each page render calls `requireBusinessRole(id)` fresh, so role changes are immediately reflected.

---

## 5. Results — Last-Owner Protection & Transaction Requirements

- **Mechanism:** `lib/membership-transaction.ts` — `runSerializedMembershipMutation()` wraps every membership mutation (role change, invite, remove) in a MongoDB transaction with `findOneAndUpdate` + conflict retry.
- **Invariant:** Business document is written inside the transaction, causing `WriteConflict` (code 112) or `TransientTransactionError` if another session modifies the same document concurrently.
- **Test evidence:**
  - `tests/integration/membership-concurrency.test.ts`:
    - "two owners demoting each other concurrently keep at least one active owner" → `outcome.committed === 1`, `outcome.forbidden === 1`, final `owners === 1`
    - "two owners removing each other concurrently keep at least one active owner" → same invariant
    - "primary owner cannot be demoted" → 403 if attempting to demote the last active owner
    - "primary owner cannot be removed" → 403 if attempting to remove the last active owner
- **Deployment requirement:** MongoDB must be a **replica set** (Atlas `mongodb+srv://` or local `mongod --replSet rs0` + `rs.initiate()`). Standalone `mongod` rejects transactions with `Transaction numbers are only allowed on a replica set member or mongos`.
- **Production prerequisite:** Confirm `MONGODB_URI` points to a replica set (already required by AGENTS.md).

---

## 6. Manual Smoke-Test Checklist (No Automation Available)

### Preconditions
- [ ] MongoDB replica set running (Atlas or local single-node replica)
- [ ] `.env.local` configured with `MONGODB_URI`, `SESSION_SECRET`, `APP_URL`, `EMAIL_PROVIDER`
- [ ] Three test accounts created: **Owner**, **Manager**, **Staff** (all members of the same business)
- [ ] Browser with developer tools (F12) available

### Owner Flow
- [ ] Log in as **Owner**; verify all 8 tabs visible: Overview, Products, Media, Theme, Editor, Pages, Settings, Billing
- [ ] Click **Billing**; verify billing controls accessible and form submits
- [ ] Click **Settings**; verify member management, domain controls accessible
- [ ] Create a new **Manager** member via `POST /api/businesses/[id]/members`; verify role = "manager"
- [ ] Log out and log in as the new **Manager**; verify 7 tabs (Billing hidden)

### Manager Flow
- [ ] Log in as **Manager**; verify tabs: Overview, Products, Media, Theme, Editor, Pages, Settings (Billing absent)
- [ ] Click **Settings**; verify business branding/name can be edited (API permits manager)
- [ ] Click **Billing**; **expected: 403 forbidden** (manual inspection of route guard confirms owner-only)
- [ ] Click **Domain management** (if a DomainManager component exists); **expected: 403 forbidden**
- [ ] Create a new **Staff** member; verify role = "staff"
- [ ] Log out and log in as **Staff**; verify 4 tabs only

### Staff Flow
- [ ] Log in as **Staff**; verify tabs: Overview, Products, Media, Pages (read-only list, no create/edit buttons)
- [ ] Click **Settings**; **expected: 403 forbidden** or tab not rendered
- [ ] Click **Theme/Editor**; **expected: 403 forbidden** or tab not rendered
- [ ] Click **Billing**; **expected: 403 forbidden** or tab not rendered
- [ ] Attempt to archive a product; **expected: 403 forbidden** (canArchive only owner||manager)
- [ ] Attempt to publish/unpublish website; **expected: 403 forbidden** (publish route requires owner||manager)
- [ ] Navigate directly to `/dashboard/businesses/[id]/billing` in address bar; **expected: 403 forbidden** (authoritative guard)
- [ ] Navigate directly to `/dashboard/businesses/[id]/settings`; **expected: 403 forbidden** for staff
- [ ] After demoting a member from manager → staff, log in as the demoted user; **expected: restricted tabs** (staff set)
- [ ] After removing a member entirely, log in as that removed user; **expected: 403 forbidden** on subsequent requests

### Cross-Tenant Isolation
- [ ] Use a **different business**'s ID in URL; **expected: 403 forbidden** (Membership.findOne scopes to business)
- [ ] Verify that a member of Business A cannot access Business B's dashboard even with guessed IDs

---

## 7. Defects Found

**None.** All existing code already satisfies the Phase 5 requirements. The implementation is consistent across:

- **Server-side guards** (`requireBusinessRole`, member mutation routes, `canManage`/`canArchive` expressions)
- **Client-side visibility** (`BusinessTabs` tab filtering via `roles` arrays + `visibleBusinessTabs()`)
- **Role-change enforcement** (each request re-reads membership; no session-level role caching)
- **Last-owner invariant** (MongoDB transaction-protected, concurrency-tested)

The only "gap" is the **absence of browser automation**, which is documented as a known limitation (no Playwright/Cypress/Puppeteer installed; manual checklist provided instead).

---

## 8. Production Prerequisites Still Outstanding

| Requirement | Status |
|------------|--------|
| MongoDB replica set (Atlas `mongodb+srv://` or local replica) | **Required** — transactions depend on it (AGENTS.md) |
| `TRUSTED_IP_HEADER` set in production | **Mandatory** — rate-limited endpoints fail closed with 503 if missing |
| Email provider (`resend`/`console`/`memory`) configured | **Required** for verification emails; `console`/`memory` refused in production without config |
| `APP_URL` absolute HTTPS | **Required** for Resend, password reset/verification URLs |
| AWS S3 bucket + `AWS_S3_PUBLIC_URL` | **Required** for media upload/display; fail-fast if missing/malformed |
| Payment provider: `manual` for sandbox, or live credentials authorized | **Required** for checkout/subscription flows |
| No browser E2E tests | **Not applicable** — manual verification only; no automation framework installed |

All five phases (1–5) are **verified and stable**. The dashboard navigation, role derivation, and membership authorization form a consistent, authoritatively enforced system.

---

## 9. Conclusion

- **All automated checks pass** (320 unit, 265 integration, typecheck, lint, build).
- **Manual navigation visibility** matches the role policy exactly.
- **Direct-route access** is blocked by server-side guards; UI visibility does not override API rejections.
- **Role changes** are immediately enforced on subsequent requests (no stale caching).
- **Last-owner protection** is transactional and concurrency-tested; production must use a MongoDB replica set.
- **No defects found** requiring code changes.

**Next step:** Deploy to a staging environment with a MongoDB replica set, configure `TRUSTED_IP_HEADER`, email provider, and AWS S3, then run the manual smoke-test checklist against a running instance.