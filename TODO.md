# TODO

## Fix dashboard MissingSchemaError (completed)

### Symptoms
- `MissingSchemaError: Schema hasn't been registered for model "Business"`
- Raised at `app/dashboard/page.tsx:12` via `getMembershipsForUser`
- `/dashboard` returns 500 while logged in; `/login`, `/`, registration work.

### Root cause
- `lib/auth/guards.ts` `getMembershipsForUser` calls `.populate("business")`,
  which Mongoose resolves by the model **name** "Business".
- Callers of `getMembershipsForUser` (dashboard page, dashboard layout,
  `api/auth/me`) never import `models/Business`, so the model is not registered
  in their runtime before the query executes.

### Fix
- [x] Import `Business` model into `lib/auth/guards.ts`
- [x] Pass `model: Business` explicitly to the populate
- [x] Confirm other `.populate()` sites are safe:

### Verification
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run build` (AGENTS gate — success, 16/16 routes incl. `/dashboard`)
- [x] GET /dashboard (authenticated, throwaway account) returns 200 — re-confirmed on fresh post-build instance
- [x] No `MissingSchemaError` in dev server logs (count unchanged after fix)

### Remaining manual tests
- [ ] Log in with a real account in the browser and confirm the business
      listing renders on /dashboard and the sidebar shows businesses
- [ ] Create a business and confirm it appears in the dashboard list
- [ ] Delete/ignore the throwaway verification user created during testing