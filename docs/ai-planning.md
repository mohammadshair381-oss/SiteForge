# Website planning and editing foundation

## Existing manual website-planning workflow

The dashboard planner is a manual planning and review workflow. It prepares a
whole-website plan for owner or manager review; it does not generate AI content.
`lib/ai-planning/plan.ts` defines its validated plan contract and reuses the
existing theme IDs, page slug rules, and CMS section schemas. The 50-page
maximum bounds a plan payload; it is not a subscription entitlement.

`POST /api/businesses/:id/planning/validate` is restricted to business owners
and managers. It validates plan data, business-scoped page and product
references, slug conflicts, and media ownership. It is stateless: it does not
create or update pages, business theme settings, navigation, or published
snapshots.

After review, a plan is saved as a change proposal
(`POST /api/businesses/:id/proposals/from-plan`). An owner or manager previews it, approves it and
applies it to draft pages, and publishing is a separate step. `planning/apply`, which used to write
a plan straight to draft pages, now answers `410 use_proposal_workflow` and changes nothing.

Applying never publishes pages or changes business details, products,
navigation, theme selection, or published section snapshots. Existing
`isHome` assignments are preserved. For a business with no page records and a
draft status, the plan's homepage becomes the initial draft homepage. Applying
to a published storefront that has no Page records is rejected because adding
the first Page would change storefront routing and could make its homepage
unavailable. MongoDB transactions require the configured replica set as
documented in `AGENTS.md`.

In the dashboard, validation and approval are separate from applying. Replacing
existing draft content requires an explicit confirmation. The current planner
remains manual; applying a plan does not imply AI generation or send data to an
external provider.

## Provider-neutral editing actions

`lib/ai-planning/actions.ts` defines a strict, provider-independent action
contract. It is separate from the whole-website `WebsitePlan` contract and
reuses the current section and page-slug validation schemas. The initial
allowlist supports:

- `update-section`: requires an existing page ID, its expected version, and a
  schema-valid section. The section ID, type, order, visibility, and style must
  match the existing section; only supported section settings can change.
- `add-section`: requires an existing page ID, its expected version, an
  insertion index, and a supported, schema-valid section.
- `remove-section`: requires an existing page ID, its expected version, and
  the target section ID.
- `reorder-sections`: requires an existing page ID, its expected version, the
  section ID, and a valid destination index.
- `create-page`: requires a bounded title and unique valid slug, plus at least
  one supported, schema-valid section. The engine creates it as a draft with a
  deterministic proposal ID.

Every action has a unique bounded `actionId` for stable diff reporting. Every
mutation targeting an existing page requires `expectedVersion`, which is
checked against the original context version even when the plan has multiple
actions for that page. The contract accepts at most 100 actions, 50 pages, and
50 sections per page; action IDs are at most 64 characters, page IDs at most
80 characters, section IDs at most 64 characters, and page titles at most 140
characters. Section settings retain their existing per-field limits. It
rejects unknown action kinds and fields, duplicate action IDs, unsupported
section fields, arbitrary HTML markup, invalid section URLs, and unsupported
page/section counts. Product IDs, business ownership, roles, publishing,
navigation, theme changes, billing, arbitrary CSS, database operations, and
executable code are not part of this contract.

Section image references in actions must exactly match an entry in the
context's `allowedMediaUrls`. This pure contract can validate the URL shape
and membership in that allowlist, but it cannot establish ownership. A future
server-side context loader must validate existing URLs and apply the existing
tenant-scoped ownership checks to platform media before populating the list.
The contract currently has no product-reference action.

## Deterministic engine and boundaries

`lib/ai-planning/editing-engine.ts` applies validated actions in order to a
cloned in-memory context and returns the proposed draft, ordered change list,
and summary counts. It revalidates runtime inputs and checks targets, draft
status, expected versions, page slugs, section identifiers, limits, media
allowlisting, and reorder/insertion positions. If any action fails, the
function throws and returns no partial proposal; the caller's input remains
unchanged.

This is a pure proposal engine. It performs no database reads or writes,
network or filesystem operations, authorization, media ownership verification,
or publishing. Its context and deterministic proposal IDs are not database
records and must not be treated as authorization. A future server integration
must load context only after authenticating and authorizing the business,
recheck tenant ownership and media references, and compare page versions
again in the write transaction.

## Provider-neutral change proposals and review

`lib/ai-planning/proposal.ts` prepares a review-only proposal from a validated
editing context and candidate actions. The caller supplies a bounded proposal
ID and concise summary; actions are parsed through the existing strict action
schema, then passed to the deterministic editing engine. The resulting proposal
contains those validated actions, the engine-generated ordered diff and
summary, a validated draft preview, a `pending_review` status, and the distinct
existing page IDs with the expected versions used during preparation. New-page
actions do not carry existing page versions.

Proposal preparation is deterministic for the same proposal ID, summary,
context, and actions. It rejects the whole candidate if any action fails and
does not mutate its inputs. It neither stores the proposal nor applies its
preview. The preview contains only the editing context supplied to the engine
and the draft result, not raw Mongoose documents or unrelated website records.

`transitionEditingProposalReview` supports only these transitions:

- `pending_review` to `approved`
- `pending_review` to `rejected`

The transition requires a strict review record containing the decision,
reviewer ID, and timestamp. Repeated or contradictory decisions are rejected.
An approval means only that a review decision was recorded: it does not mean
the proposal was applied, saved, or published. The contract has no applied or
published state.

This pure transition does not authenticate a reviewer and is not proof of
authorization. A future approval endpoint must derive the reviewer identity
from the authenticated session, authorize that user for the business, and
never treat a client-supplied reviewer ID or approval status as authorization.
Likewise, the proposal's page-version bindings are planning-time evidence only.
Any future apply operation must re-authorize the user, reload the current
tenant-scoped context, re-check every bound page version and media ownership,
and validate the actions again inside the database write boundary. Approval
alone must never bypass these checks.

## Server-side website context

`lib/ai-planning/context.ts` exports
`loadWebsiteEditingContext(businessId, pageIds?)`. It requires an authenticated
owner or manager through `requireBusinessRole` before loading business data.
When `pageIds` is supplied, the loader returns only those pages and verifies
that every ID belongs to the authorized business; missing and foreign page IDs
receive the same response. Without a page selection it returns up to 50
business pages as read-only context, but no existing page is editable.

The returned public business details are limited to name, category, and
description. Page records are always queried with the authorized business
scope and only include page identity, title, slug, status, version, homepage
designation, and sections. Section content is parsed through the shared CMS
section schema; a malformed stored page fails closed with a safe error rather
than returning raw content. For published pages, the loader uses the published
snapshot (with the same legacy fallback as storefront rendering). It excludes
database-only fields, SEO fields, business contact details, credentials,
orders, customers, and payment data.

The result has two page views: `pages` contains the selected (or read-only
listed) validated page context and marks whether each page is editable;
`editingContext` contains only explicitly selected draft pages and is already
validated by `editingContextSchema`. Pass only that `editingContext` to the
deterministic engine. Published pages, and drafts that were not selected, are
never included as engine targets.

The media allowlist is derived only from image references in selected draft
sections that map to active `Media` records owned by the authorized business.
Before building it, the loader reuses the existing section media ownership
check; external HTTPS image URLs are accepted as existing section data by the
legacy validator but are not approved for new editing actions. Soft-deleted
media is not newly allowlisted. A future caller must still repeat these checks
before saving, because the allowlist is an in-memory planning aid, not proof of
authorization at a later time.

The loader is server-side library code and performs reads only. It does not
apply actions, mutate MongoDB, call an external service, or publish. There is
not yet a route or UI that invokes it. Version checks in the engine compare
with the loaded context only; a future write path must reload/revalidate the
business, selected page versions, and media ownership inside its authorized
write boundary.

This phase adds no API route, database persistence, user-facing editor, or AI
provider. SiteForge still has no configured AI provider or AI SDK. AI
generation remains unavailable until a provider is deliberately selected,
configured server-side, and verified; no external AI service is called by this
foundation.

Before adding provider-specific code, choose an AI provider and explicitly
approve its required server-side credentials/configuration and business-data
handling. Implementations must satisfy `WebsitePlanningProvider`, return
untrusted output for validation through `websitePlanSchema` for whole-website
plans or `editingActionsSchema` for editing actions, and must not expose
credentials to browser code.
## Gemini API integration

`lib/ai-planning/provider.ts` and the AI builder use the server-side Gemini model, but only when `AI_PROVIDER_ENABLED=true` (kill switch, default off; `isAiProviderEnabled()` in `lib/env.ts`), `GEMINI_API_KEY` is set and `GEMINI_MODEL` (optional) is valid. A key alone never enables it. Google Gemini is the owner-approved provider; each business's owner must also consent, and production stays off until the activation requirements in `docs/ai-website-builder-plan.md` are met.

- **Model ID**: `GEMINI_MODEL`, default `gemini-3.6-flash` (official model docs: https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash). Documented as a stable, generally available model; see the free-tier note below for eligibility. An invalid value (not `gemini-` plus letters, digits, dots and hyphens) disables AI with `503 provider_not_configured`.
- **Endpoint**: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`. The key is sent ONLY in the `x-goog-api-key` header, never in the URL (URLs reach proxy and server logs). The call lives in `lib/ai-planning/gemini-http.ts`, shared by every AI feature.
- **Request body**: `{ systemInstruction?, contents: [{ role: "user", parts: [{ text: ... }] }], generationConfig: { temperature, maxOutputTokens, topP, topK, responseMimeType: "application/json" } }`.
- **Response parsing**: Joins the candidate's non-thought text parts, parses JSON (raw, fenced or embedded) and validates it with the task's schema (`websitePlanSchema`, the storefront change-set schema, or the product-copy schema).
- **Timeout**: `AI_PROVIDER_TIMEOUT_MS` (default 30 seconds, 1 to 120000 ms) for the whole exchange, including reading the body (AbortController).
- **Data check**: every request passes `assertProviderPayloadSafe` (`lib/ai-builder/sanitize.ts`) before it is sent; personal or secret-looking text is refused with `422 unsafe_content`.
- **Retries**: `executeAiTask` may try once more after a temporary or connection failure (`docs/ai-website-builder-plan.md`, "Provider layer"). This module makes one request per call.
- **Fail-safe**: Returns `null` provider (and `PlanningProviderUnavailableError` when invoked) if `GEMINI_API_KEY` is missing; no paid fallback.
- **Free tier**: `gemini-3.6-flash` is documented as free-tier eligible. Eligibility and quotas are granted per project and are controlled by Google, so they are not guaranteed and remain unverified for SiteForge's key until a controlled live request succeeds. Google's terms for unpaid usage may allow submitted content to be used to improve its products: confirm the data terms of the production key before activation (activation requirement 2).
- **Security**: API key is server-side only; never exposed to browser, logs, or error responses.
- **Tests**: Mocked tests (global `fetch` replaced): `tests/unit/gemini-provider.test.ts`, `tests/unit/gemini-http.test.ts`, `tests/integration/ai-generate-route.test.ts`, `tests/integration/ai-builder.test.ts`, `tests/integration/ai-consent-privacy.test.ts`. No automated test reaches the network. Real Gemini only through the staging suite (`npm run test:staging-ai`, see `docs/ai-website-builder-plan.md`).
- **Official source**: https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash (consulted 2026-10-28)
