# AI website builder: audit and implementation plan

Status: **Google Gemini is integrated but NOT enabled in production.** The
provider and data-sharing decisions are approved (see "Google Gemini
integration" below). Owner consent, a central data-sanitization layer, usage
outcomes and a staging verification suite are implemented. Everything is
tested against a MOCKED Gemini; the real-Gemini staging run has not been
executed yet (no staging key was available), so no real AI output has been
generated or reviewed in this product. `AI_PROVIDER_ENABLED` stays off in
production until the activation requirements below are met.

## Google Gemini integration (owner-approved 2026-10-31)

Approved by the owner: Google Gemini as the initial provider; sending business
descriptions, product content and storefront configuration with disclosure and
consent; never customer personal information, orders, payment information or
authentication data; 30 AI requests per business per month; real AI testing
only in isolated staging. **Production stays off** (`AI_PROVIDER_ENABLED`
unset or `false`) until the activation checklist below is complete.

### Request pipeline (every AI request)

1. `guardAiRequest` (`backend/lib/ai-builder/guard.ts`): same-origin JSON; owner or
   manager of THIS business; verified email; the kill switch and a configured
   key + valid model; business not suspended; **the owner's consent**; then the
   burst/hourly/daily rate limits. Planning `generate` applies the same checks.
2. Request validation and store data loading (owner-scoped).
3. `runAiRequest` (`backend/lib/ai-builder/request.ts`): consent is read again (a
   revocation since step 1 wins); the complete outgoing text passes the final
   data check; one request is reserved atomically in the monthly allowance;
   Gemini is called; the output is validated (`accept`) and recorded.
4. Homepage output becomes a PENDING proposal (approve, then apply to the
   DRAFT; publishing is separate). Product copy is returned to the form and
   never saved by the server.

### Data sent to Gemini (`backend/lib/ai-builder/sanitize.ts`)

The only way store data becomes provider input. Three layers:

1. **Allowlist builders** copy approved fields into new objects: business name,
   type and description; selected theme; brand colours and font; homepage
   settings and sections (text, order, visibility, appearance; image URLs
   become `hasImage`); product titles, categories, descriptions and option
   attributes (for example Size: S, M, L); internal link paths.
2. **Redaction** of every free text: email addresses, phone numbers and long
   digit runs (card/account numbers), API keys (`sk_`/`pk_`/`rk_`, Razorpay
   `rzp_`, Google `AIza`), JWTs and bearer tokens, bcrypt hashes, long hex
   tokens and credentialed links become `[email removed]`, `[number removed]`
   or `[removed]`.
3. **Final check** (`assertProviderPayloadSafe`), also enforced inside
   `geminiGenerateJson` for planning: a request whose text still contains such
   data is refused with `422 unsafe_content`; nothing is sent or charged.

Never sent: customers, orders or order history, payment information or
credentials, accounts, sessions, tokens, passwords or secrets, contact details
(email, phone, address), prices, stock, SKUs, other businesses' data. Prices,
policies and the address are used only server-side by the claims check
(`backend/lib/ai-builder/claims.ts`). Planning briefs are owner-typed text and are
redacted the same way.

### Consent (`backend/lib/ai-builder/consent.ts`)

- Each business's OWNER consents to the current disclosure version
  (`AI_CONSENT_VERSION`, shown in Business settings and in the editor's AI
  panel). Managers see the state; staff see nothing.
- Current state: `Business.aiConsent` (`version`, `grantedAt`, `grantedBy`,
  `revokedAt`, `revokedBy`). History: append-only `AiConsentEvent` (business,
  actor, action `granted`/`revoked`, version, timestamp), written in the same
  transaction.
- `POST /api/businesses/[id]/ai/consent { version }` (owner, same-origin,
  verified email; the version must be the one shown, else
  `409 consent_version_mismatch`); `DELETE` revokes (owner, same-origin);
  `GET` (owner/manager) returns provider status, disclosure, consent and, for
  owners, history. The key is never returned.
- Revocation takes effect on the next request: consent is read from the
  database in the guard and again right before the provider call.
- Changing the disclosure text in substance means bumping
  `AI_CONSENT_VERSION`; every owner then consents again (`outdated`).
- Turning the provider on never implies consent: without it every AI route
  returns `403 ai_consent_required` before rate limits, usage or data access.

### Usage (`backend/lib/ai-builder/usage.ts`, `AiUsage`)

- Monthly allowance per business: `features.aiRequestsPerMonth` from the
  Super Admin plan manager; plans that leave it blank get
  `DEFAULT_AI_REQUESTS_PER_MONTH` (30, owner-approved); no active plan = 0.
- Reserved atomically right before the call (concurrent requests cannot
  exceed it; integration-tested with 8 parallel requests and an allowance of 3).
- Outcomes: `successes`; `rejected` (Gemini answered but the output was
  refused: unreadable, cut off, unsupported change, invented facts);
  `failures` (provider error, rate limit or timeout). A request refused before
  reaching Gemini (consent, kill switch, configuration, data check, validation,
  quota) is never charged; one reserved and then stopped before sending is
  refunded.
- Token counts only as Gemini reports them in `usageMetadata`; nothing is
  estimated. No costs are computed. No prompt or output text is stored.

### Configuration (server environment only)

| Variable | Meaning |
|---|---|
| `AI_PROVIDER_ENABLED` | Kill switch; only the exact value `true` enables. |
| `GEMINI_API_KEY` | Server-side key, sent only in the `x-goog-api-key` header. |
| `GEMINI_MODEL` | Optional; default `gemini-3.6-flash`. Must match `gemini-[a-z0-9.-]`; an invalid value disables AI (`503 provider_not_configured`). |
| `GEMINI_MODELS` | Optional, comma-separated; more models a task may be routed to. Listing one does not select it. |
| `AI_PROVIDER_TIMEOUT_MS` | Optional; one timeout for the whole call including the body (1 to 120000, default 30000). |

### Provider layer (`backend/lib/ai-providers/*`)

Gemini is one adapter, not the architecture. Features call `runAiRequest` (`backend/lib/ai-builder/request.ts`),
which calls `executeAiTask` once; neither knows which provider answers.

| Part | File | What it does |
|---|---|---|
| Adapter contract | `types.ts` | Text, structured JSON and conversation calls, normalized results, model capabilities |
| Errors | `errors.ts` | `AiProviderError` extends `HttpError`, so clients get the same fixed message and code, plus a `kind` |
| Gemini | `gemini.ts` | The only adapter. The request stays in `backend/lib/ai-planning/gemini-http.ts` |
| Registry | `registry.ts` | Implemented providers, their models and status, and `AI_DISCLOSED_PROVIDER_IDS` |
| Routing | `routing.ts` | Task to provider and model, checked against what each task and model can do |
| Settings | `settings.ts` | Stored routing choices (`PlatformSettings.aiRouting`) |
| Execution | `execute.ts` | Attempts, retries and fallback |

**Adding a provider.** Implement `AiProviderAdapter`, call `registerAiProvider`, and add its variables to the
server environment. Add it to `AI_DISCLOSED_PROVIDER_IDS` only with a new consent disclosure and a new
`AI_CONSENT_VERSION`. No feature changes. Only Gemini is implemented today.

**Choosing a route.** The task's route, or else the default route, then `fallbackOrder`. With nothing saved, the first
usable provider handles every task with its default model. A chosen route that cannot run is not replaced unless the
platform listed a fallback. A route is usable only if `AI_PROVIDER_ENABLED` is `true`, an adapter exists, the disclosure
names it, it has its credentials, it is not disabled, and the model has the capabilities the task needs.

**When a provider fails.**

| Kind | Same route again | Next provider |
|---|---|---|
| `temporary`, `unreachable` | Once, after 500 ms | Yes |
| `timeout`, `server_error` | No (it may have done the work, and may charge again) | Yes |
| `rate_limited`, `authentication`, `model_unavailable`, `not_configured` | No | Yes |
| `rejected_request`, `invalid_output`, `truncated`, `blocked`, `cancelled` | No | No |

All attempts share a time limit of twice `AI_PROVIDER_TIMEOUT_MS`, at most 120 seconds. `runAiRequest` reserves one request and
calls `accept` once, after the attempts, so retries cannot charge twice or create two proposals. An answer that was refused is not
retried. A request is refunded only if no attempt could have reached a provider. `AiUsage` records the provider and
model per request (`routes`, `provider`, `fallbacks`): names and counters only. Applying a proposal is a separate request and is never retried.

**Admin.** `/admin/ai-usage` shows providers, why each is or is not available, missing server settings by name, the route per task and
usage per provider and model, with a form (`AiProviderManager`) over `PUT /api/admin/ai-routing` (Super Admin, audited, revision-checked).
It stores `disabledProviders`, `defaultRoute`, `taskRoutes` and `fallbackOrder`, which can only narrow what the environment allows. The
server checks every save: a name with no adapter, a provider the disclosure does not name, a disabled or unconfigured provider, or a model
without a task's capabilities is refused.

**Availability.** `aiReadiness(businessId, task?)` (`backend/lib/ai-builder/consent.ts`) is the one answer to "can this store use AI?": the environment,
a usable route, not suspended, a plan that includes AI, the owner's consent. Pages, panels and `GET ai/consent` read it. Store owners get a plain
reason, never which provider or setting is the cause. `aiBuilderStatus()` is the environment alone. `guardAiRequest` checks the route again.

**Edited plans** (`backend/lib/ai-planning/plan-provenance.ts`). A plan is edited in the browser, so nothing it says about itself is believed. Generating
one records fingerprints of its text and the owner's brief for 24 hours (`AiPlanGeneration`), and `planning/validate` and `proposals/from-plan`
compare. A page with unchanged generated text, or the same address and title as a generated page, is AI-written: its edited text gets the claims
check, consent must still be on, and it gets the `generated` marker when applied (`WebsiteProposal.aiPageSlugs`). Any other page is the owner's
and is not labelled AI. Every plan field is plain text (`backend/lib/ai-planning/plan.ts`). Saving a plan never calls a provider or uses the allowance.

### Complete website generation (`backend/lib/ai-website/*`)

Connects the conversation, the provider layer, proposals, the renderer and the draft services into one workflow. Everything here has only
ever been read, never run: no real provider has produced a website.

| Part | File | What it does |
|---|---|---|
| Blueprint | `blueprint.ts` | One canonical website: identity, design draft, storefront config (homepage, header, footer), menus, pages with CMS sections. Nothing AI-only |
| Answers | `answers.ts` | Strict schemas of what a provider may answer, independent of provider |
| Building | `build.ts` | Answers into blueprint data; revisions; differences between two states; preview data |
| Conversation | `conversation.ts`, `backend/models/AiConversation.ts` | Per business and person, 14 days, messages scrubbed, resumable |
| Generation | `generation.ts` | One discovery turn, one generation step, one revision, all through `runAiRequest` |
| Proposal | `proposal.ts` | `WebsiteProposal` with target `website`: one approval for all of it |
| Applying | `apply.ts` | All or nothing, in the proposal's transaction, through the draft services |
| Preview | `preview.ts` | Lays a proposal over a store view, for the shared renderer |

**Steps.** The owner talks (`POST ai/website`). Asking to generate runs one request per step (`POST ai/website/generate`, repeated by the client): the plan and
homepage, then each page, then the proposal, which uses no provider. Each finished step is stored in the conversation, so stopping loses nothing. A lease stops two
requests working on one conversation. `POST ai/website/revise` turns one request into a proposal holding only that change: it builds on a waiting proposal and
replaces it, or else on the current drafts. The provider never picks a task: what a message does depends on the conversation's phase and the endpoint.

**Earlier messages** go to the provider as a delimited data block, so this works with any provider and they cannot pose as instructions. Only the owner's own words
count as facts in the claims check. What was refused is reported as refused.

**Pages.** Proposals may change the DRAFT of a published page here (its `sections` and search fields), never its live copy, because the live copy is kept apart
(`liveCopyToKeep`), and never its title or address, which show at once. No page is ever removed. Policy wording gets `needsReview`.

**Usage.** Each accepted answer uses one request of the monthly allowance: one per discovery message, one for the plan and homepage, one per page, one per revision. A failed
or refused step is refunded (`chargeOnlyAccepted`), so trying again never costs twice. Plan limits are checked again when applying. Rate limits still apply.

**Older custom homepages.** A store whose `/` shows a published Home page with sections, or sections in the settings, keeps it. A proposal saves the new homepage to the draft and says so; the
preview offers both; only publishing from the website editor (`mode=store`) retires the old one. The Publish screen says the same for its Homepage item, because publishing there updates the announcement, header and
footer but not `/`.

**Text and products.** `home_block_update` and `page_edit` go through `updateSectionText`: only the listed text fields of a section change, and its id, pictures, links and screen size settings stay. The review lists
each changed field. `home_featured` and a plan's `products` choose real products by references (`p1`), which the server resolves; they are checked again, as active and this store's, when applying. A provider never sees an id, price or stock.

**Media.** Images are offered by reference (`m1`) with a description and shape: only this store's, ready, and only with an address the renderer can show (https, or a local development address). One step's references hold for
the whole website. Where nothing fits, the AI asks for an upload (`imageRequest`), which becomes a note: an address is never invented.

**Stale proposals.** The review names what changed. `POST proposals/[id]/refresh` lays the proposal over the current drafts using its stored `baseline`: what only the proposal changed is taken, what only the owner changed stays,
and anything both changed is named and nothing happens. No provider, no allowance, and the result is a new proposal to review. Asking again goes through the assistant.

**Refused wording.** The claims check is not relaxed. In this workflow a refusal costs nothing, the wording is remembered and sent as `REFUSED_WORDING` on the next attempt, and each phrase comes with advice (`claimAdvice`). The owner can confirm it is true,
which adds a message in their own words, the source of fact the check already accepts. Prices, ratings, reviews and best sellers cannot be confirmed this way (`claimNeedsRealData`): they have a real source in the store.

**Planner.** The AI Builder is the one way to generate a website. The website planner stays for laying out draft pages by hand, and hands its brief across (`PUT ai/website`, no provider). `planning/generate` has no screen, and stays for existing API clients.

**Answer validation.** Section templates are checked against the section library and product categories against the store's real ones (`findUnsupportedChoices`) before an answer is kept, and a plan or page then goes through the same build code as the final step (`assertPlanBuildable`, `unbuildablePages`). A refusal happens inside `accept`, so it is not charged, and it says what was chosen. Finished steps stay, and only that step runs again, told what went wrong through `CORRECTIONS` (`answerCorrections`: fixed sentences, never a value from an answer or anyone's words). The owner can also tell the assistant what to use instead, while that step is waiting. If a category is removed while a website is being written, the final step clears only the pages that no longer build, and they alone are written again. A homepage block that no longer builds is left out with a note. A plan made again keeps the pages already written for the same addresses.

**Conversations are private** to the person having them, and proposals are what the team shares. So a whole-website proposal holds nothing from the conversation: no `request`, not the assistant's summary (its description comes from what it changes, `describeWebsiteChanges`), and its notes are scrubbed. The API returns no `request` for one to anybody, including anything an older proposal stored, and a refreshed proposal does not carry one over. What it proposes to put on the store is shown, because that is what is reviewed. A single AI suggestion's `request` (homepage or page) is scrubbed when stored and returned only to its author; the shared review screen shows none. Starting again deletes the conversation. Run-out ones are deleted when found, and by `POST /api/cron/conversation-cleanup` once a scheduler calls it (`docs/scheduled-jobs.md`). None is set up, so until then the lazy deletion is all there is.

**Consent version 2026-11-05.2.** Product names, product categories and media file names reach the provider through this workflow, so the disclosure names them (`AI_CONSENT_CHANGES`, shown to owners on an older version) and every owner consents again: `readAiConsent` grants only on an exact version match, and `guardAiRequest` and `runAiRequest` both check it, so these details are not sent on an older consent. Applying a waiting proposal also needs the current version.

**Local media.** Section and homepage schemas check only an address's format, because they also read stored data, so they stay as they are. `assertMediaUrlsOwned`, which every write and publish goes through, refuses a local media address wherever `localMediaServable()` is false (production always, and development without `LOCAL_MEDIA_ENABLED`). The website workflow does not offer such images in the first place, and asks for an upload.

**Unsaved homepage work.** Autosave still sends `x-expected-version` and still stops on a conflict. The editor never reloads over unsaved edits: an applied proposal or a restored version shows the conflict notice instead (`reloadUnlessUnsaved`), which lists what is unsaved (`backend/lib/editor-unsaved.ts`), lets the owner copy the text, and asks before loading the latest draft. Edits are not merged or restored automatically, because that could overwrite newer work.

**Sections.** The AI writes hero, about, imageText, richText, features, steps, faq, cta, contact, products, gallery, newsletter, reviews and spacer sections. Testimonials, statistics,
team, pricing, logos and video only ever come as library templates with `[[placeholders]]`: the AI must not write them. Contact details come from the business, images from
this store's media by reference, and placeholders block publishing as everywhere.

### Staging verification (`npm run test:staging-ai`)

`tests/staging/gemini-staging.test.ts` checks, against real Gemini: real
generation (homepage proposal and product copy), rejection of invalid
structured output and of cut-off output, timeout handling, the monthly limit,
consent revocation, that seeded customer/order/payment/account canaries never
appear in any outgoing request (and the key only in its header), that
proposals need approval, and that the live store is unchanged until publish.

- It always uses a throwaway in-memory replica set with synthetic data
  (`MONGODB_URI` is replaced; `.env*` files are never loaded), refuses
  `NODE_ENV=production`, blocks every host except Gemini and keeps online
  order payments off.
- Real mode needs `STAGING_GEMINI_API_KEY` (a staging key, in the process
  environment only) and `STAGING_AI_CONFIRM=isolated-staging`. It makes about
  seven small Gemini requests. Output is scalar only (status codes, counts).
- `STAGING_AI_DRY_RUN=1` runs the same checks against a fake Gemini, to
  validate the suite itself. Without either, every check is skipped.

### Production activation requirements (not done)

1. Run `npm run test:staging-ai` in real mode in staging and review the result
   and a sample of real suggestions with the owner.
2. Confirm Google's data terms for the chosen key/project (paid tier: prompts
   not used for training; retention and region acceptable).
3. Set `GEMINI_API_KEY` (production key, server environment only) and, if
   needed, `GEMINI_MODEL`; then set `AI_PROVIDER_ENABLED=true` — an explicit,
   separately approved deployment step.
4. Optional (approved operation): `db.aiconsentevents.createIndex({ business: 1, createdAt: -1 })`
   (the history query is per business, at most 20 rows). `AiUsage` needs none.
5. Monitor `AiUsage` (failures and rejected counts) and Gemini quota errors.


### Implemented (M0 + M1)

| Item | Where | Tests |
|---|---|---|
| Kill switch checked before any provider call or rate-limit spend | `backend/lib/env.ts` `isAiProviderEnabled`, `backend/lib/ai-planning/provider.ts`, `planning/generate` | `tests/unit/gemini-provider.test.ts`, `tests/integration/ai-generate-route.test.ts` |
| API key only in the `x-goog-api-key` header (both Gemini modules) | `provider.ts`, `gemini-provider.ts` | same |
| Fixed client error messages; logs carry only scalar codes | `provider.ts` | same |
| `generate`: same-origin JSON, owner/manager, verified email | `app/api/businesses/[id]/planning/generate` | `ai-generate-route.test.ts` |
| Usage limits: 10/15 min per business+address, 10/hour per member, 20/day per business | same | same |
| Product references must belong to the business | same | same |
| 30 s timeout; 8192-token output budget (truncation still detected) | `provider.ts` | `gemini-provider.test.ts` |
| Stored proposals with lifecycle `pending → approved/rejected → applied/failed` and append-only history | `backend/models/WebsiteProposal.ts`, `backend/lib/ai-planning/proposal-service.ts` | `tests/integration/website-proposals.test.ts` |
| Create from structured actions or from the manual planner's plan (new draft pages) | `app/api/businesses/[id]/proposals`, `.../from-plan`; planner "Save as proposal for review" | same |
| Preview without saving (rendered with the business's theme) | `/dashboard/businesses/[id]/preview?proposal=…&page=…` | browser check |
| Approve/reject; apply claims and applies in one transaction (one apply wins); stale pages and expiry (14 days) fail visibly | `.../[proposalId]/review`, `.../apply` | integration |
| Draft-only application; publishing stays the separate Pages action | `apply-approved-proposal.ts` | integration |
| Review UI with pending/approved/rejected/failed/applied states | `/dashboard/businesses/[id]/proposals` | browser check |

Fixed while building M1: `applyApprovedEditingProposal` failed whenever a
proposal had several actions on one page (each write re-used the original
version) and rejected new pages that shared a section id (sections were
validated as one array across pages). Both are covered by tests.

Proposal model index (approved operation, `autoIndex` off):
`db.websiteproposals.createIndex({ business: 1, createdAt: -1 })`.

### Implemented (M0 hardening, M2/M3 without a live provider)

| Item | Where | Tests |
|---|---|---|
| Kill switch is exactly `"true"` (no trimming) | `backend/lib/env.ts` | `gemini-provider.test.ts`, `ai-builder.test.ts` |
| One shared Gemini call: header-only key, ONE timeout covering connection AND body, fixed messages, scalar-only logs, token counts only from `usageMetadata` | `backend/lib/ai-planning/gemini-http.ts` (used by planning and the AI builder) | `tests/unit/gemini-http.test.ts` |
| `planning/apply` now requires same-origin JSON and a verified email; `planning/validate` same-origin JSON | `app/api/businesses/[id]/planning/{apply,validate}` | `ai-planning-apply.test.ts` |
| AI-generated plans can only be saved as proposals (no direct "Apply to Draft Pages"); the planner and proposals pages state accurately whether AI is available | `frontend/components/dashboard/WebsitePlanner.tsx`, `ProposalsManager.tsx` | browser check |
| Planner media allowlist uses the same storage bases as ownership checks (`S3_PUBLIC_URL`, legacy name, migration base) | `backend/lib/ai-planning/context.ts` | `ai-planning-context.test.ts` |
| `live-test.ts` respects the kill switch, sends the key only in a header and prints no upstream text | repo root | manual script |
| Homepage suggestions: owner request → validated change set → PENDING proposal (target `storefront`) → preview → approve → apply to the DRAFT homepage in one transaction with the claim; stale (draft hash) refused at approval and apply | `backend/lib/ai-builder/*`, `app/api/businesses/[id]/ai/storefront`, proposal routes | `tests/unit/ai-builder.test.ts`, `tests/integration/ai-builder.test.ts` |
| Change sets are strict structured data (hero, announcement, sections, order, visibility, appearance, footer text, brand colours/font); never HTML, scripts, images, products or arbitrary fields | `backend/lib/ai-builder/storefront-changes.ts` | unit |
| Invented facts refused: prices, numbers, years, ratings, awards, guarantees, certifications, materials and delivery promises must appear in the store's own data or the owner's request | `backend/lib/ai-builder/claims.ts` | unit + integration |
| Prompts: fixed rules in the system instruction; owner text and store data as escaped, delimited JSON blocks; no customers, orders, emails, phone numbers, payment data or credentials | `backend/lib/ai-builder/prompts.ts` | unit + integration (request body inspected) |
| Product copy suggestions from the product's own details; nothing saved (the owner uses it in the form and saves normally); missing details returned as questions | `app/api/businesses/[id]/ai/product-copy`, `frontend/components/dashboard/ProductCopyAssistant.tsx` | integration |
| Usage records (`AiUsage`, counters only: requests, successes, failures, per task, provider-reported tokens) and a monthly plan allowance enforced atomically before any provider call (`features.aiRequestsPerMonth`, default 30 when unset, 0 without an active plan) | `backend/models/AiUsage.ts`, `backend/lib/ai-builder/usage.ts`, `backend/lib/billing.ts`, admin plans | integration |
| Editor AI assistant panel (above the preview; never covers it or the editing sidebar): status, context, request, history, before/after table, canvas preview, apply/reject | `frontend/components/dashboard/editor/AiAssistantPanel.tsx` | browser check (disabled state, seeded proposals) |

Brand colours and the font are store-wide business settings (as in the theme
editor): a suggestion that changes them is flagged before applying, and those
values change on the live store when the proposal is applied. Homepage content
changes stay in the draft until the owner publishes.

`AiUsage` needs no index operation: its `_id` is `businessId:YYYY-MM`.

## 1. What exists today (audited)

| Piece | Where | Notes |
|---|---|---|
| Whole-site plan schema | `backend/lib/ai-planning/plan.ts` (`websitePlanSchema`) | Business summary, audience, recommended theme (one of the 5), design notes/colours/font, up to 50 pages (title, purpose, proposed content), navigation, assumptions, summary. Text only; no sections. |
| Editing actions | `backend/lib/ai-planning/actions.ts` (`editingActionsSchema`) | `update-section`, `add-section`, `remove-section`, `reorder-sections`, `create-page`; sections validated by the CMS `sectionSchema` (`backend/lib/sections.ts`, 13 section types). Max 100 actions. |
| Deterministic engine | `backend/lib/ai-planning/editing-engine.ts` | Applies actions to an in-memory editing context with version checks; no I/O. |
| Proposals | `backend/lib/ai-planning/proposal.ts`, `apply-approved-proposal.ts` | Review-and-approve proposal model in code; transactional apply to DRAFT pages with version checks (tested in `tests/integration/ai-planning-proposal-apply.test.ts`). **Not wired to any route or UI.** |
| Server context loader | `backend/lib/ai-planning/context.ts` | Business-scoped, read-only; excludes orders, customers, payments, contact details, credentials; media allowlist from owned media. |
| Reference validation | `backend/lib/ai-planning/validate-plan-references.ts` | Page/product/media references must belong to the business. |
| Planner routes | `app/api/businesses/[id]/planning/{validate,apply,generate}` | Owner/manager. `validate` is stateless; `apply` writes draft pages in one transaction, never publishes; `generate` calls the provider. |
| Provider | `backend/lib/ai-planning/provider.ts` (Gemini Flash via `fetch`) | Output is parsed and validated with `websitePlanSchema` before returning; never written to the database by `generate`. |
| Planner UI | `app/dashboard/businesses/[id]/ai-builder`, `frontend/components/dashboard/WebsitePlanner.tsx` | Manual planning; "generate" button calls the provider route. |
| Theme settings | `backend/lib/validation.ts` `themeSettingsSchema`; `Business.themeId` / `themeSettings` | Validated colours/fonts; 5 theme ids (`backend/lib/constants.ts`). |
| Draft preview | `app/dashboard/businesses/[id]/preview` | Renders saved drafts; cannot render unsaved proposals. |
| Page SEO | `backend/models/Page.ts` `seoTitle` (160) / `seoDescription` (320) | Products have **no** SEO fields. |
| Product copy | `PATCH /api/businesses/[id]/products/[productId]` (`productUpdateSchema`: name 160, description 4000) | Owner/manager/staff. |

### Findings

1. **Fixed:** the provider was gated only by the presence of
   `GEMINI_API_KEY`. If a key were present in an environment file, `generate`
   would send the owner's planning brief to Google. A kill switch
   (`isAiProviderEnabled()`, `AI_PROVIDER_ENABLED`, exact `"true"` only) now
   gates provider selection; tested in `tests/unit/gemini-provider.test.ts`.
2. The prompt contains only fields the owner typed into the planner (summary,
   audience, page briefs, design notes). It includes no database records,
   customers, orders or contact details. `productIds` is accepted but unused.
3. **Fixed:** the API key was sent as a URL query parameter; it now travels
   only in the `x-goog-api-key` header.
4. **Fixed:** `generate` now requires same-origin JSON and a verified email
   and has per-member and per-business daily limits. Per-plan quotas and usage
   records (M3) remain open.
5. **Fixed:** output budget raised to 8192 tokens.
6. **Fixed:** provider error text is never forwarded to clients or logs.

## 2. Decisions required before any provider call

**Approved 2026-10-31** (see "Google Gemini integration" above): Google Gemini;
business descriptions, product content and storefront configuration with
disclosure and consent; no customer, order, payment or authentication data;
30 requests per business per month; real testing in isolated staging only.
Still open: Google's data terms for the production key (activation step 2).

The original questions, for reference:

- Which provider and model; its data-processing terms, training opt-out,
  retention and processing region.
- Which data may be sent: only owner-entered briefs, or also existing page
  content and product names/descriptions (never customers, orders, emails,
  payment data or credentials).
- Who pays for usage, and per-plan quotas.
- Owner-facing disclosure that content is generated by an AI provider.

Production: keep `AI_PROVIDER_ENABLED` unset until the activation requirements are met.

## 3. Architecture

Principle: **the AI proposes data; the server validates it; a person approves
it; the existing write paths apply it.** The model never gets database access,
tools, or the ability to call routes.

1. **Tasks** (each a typed generator with its own output schema, reusing
   existing schemas):
   | Task | Output schema | Applied through |
   |---|---|---|
   | Site plan from description | `websitePlanSchema` (exists) | planner `apply` (exists, drafts only) |
   | Page sections, headings, descriptions, CTAs | `editingActionsSchema` + `sectionSchema` (exist) | `applyApprovedEditingProposal` (exists, needs a route) |
   | Theme customisation | `{ themeId: THEME_IDS, themeSettings: themeSettingsSchema }` (schemas exist) | existing business update path (owner/manager) |
   | Product titles and descriptions | `productUpdateSchema.pick({ name, description })` | product update path |
   | Page SEO | `{ seoTitle ≤160, seoDescription ≤320 }` per page | page update path |
   | Product SEO | needs new optional `Product.seoTitle` / `seoDescription` fields (schema change, approved separately) | product update path |
2. **Input minimisation:** each task builds its prompt from an allowlist of
   fields, loaded through `backend/lib/ai-planning/context.ts` (business-scoped).
   Owner-entered text is wrapped as data (delimited), never concatenated as
   instructions.
3. **Proposals:** new `AiProposal` model (business, createdBy, task, status
   `pending`/`approved`/`applied`/`rejected`/`expired`, validated output with a
   size cap, the base versions of every target for optimistic concurrency,
   `expiresAt`). `autoIndex` off; indexes are an approved operation. Prompts
   are not stored.
4. **Preview:** the dashboard preview gains `?proposal=<id>`. It overlays the
   validated proposal on the draft in memory and renders it with the existing
   theme components, so nothing is saved. A per-field before/after diff is
   shown next to it.
5. **Apply:** an explicit "Apply" by an owner or manager re-checks the role,
   re-validates the output, re-checks target versions and media ownership, and
   writes through the existing paths in one transaction. AI changes go to
   drafts only; **publishing stays the existing explicit publish action.** A
   stale proposal is refused, never merged.
6. **Permissions and tenant isolation:** generate and apply are owner/manager
   only (`requireBusinessRole`), plus `requireVerifiedEmail` and same-origin
   JSON. Every referenced id must belong to the business
   (`validate-plan-references.ts`). Staff cannot run AI tasks.
7. **Safety:** outputs are plain data validated by zod; sections render as
   escaped text through React; links and media follow the existing section
   rules (owned media only). Unknown fields are rejected. No eval, HTML
   injection or code execution path exists, and none may be added.
8. **Failures:**
   - 30 s timeout;
   - no automatic retry, except one retry on 429 that honours `Retry-After`;
   - provider 429 → 503 `ai_busy`, 5xx or timeout → 502 `ai_unavailable`,
     invalid output → 422 (exists);
   - per-business and per-plan monthly quotas → 429 `ai_quota_exceeded`;
   - the global kill switch stays as the incident off-switch.
9. **Usage metrics:** new `AiUsage` record per call: business, user, task,
   provider, model, outcome (`ok`/`invalid_output`/`timeout`/`rate_limited`/
   `error`), latency, input/output character counts, and provider token counts
   when returned. **No prompt or output text.** Quotas come from a new plan
   feature (for example `features.aiRequestsPerMonth`) enforced in
   `backend/lib/billing.ts`. Super-admin view: totals per business, error rates.

## 4. Milestones

| # | Scope | Needs a decision? |
|---|---|---|
| M0 | **Done**: kill switch, header auth, verified-email + same-origin on `generate`, usage limits, token budget, error hygiene | — |
| M1 | **Done** (as `WebsiteProposal`): proposal routes, preview, review, draft-only apply, history, UI; works with AI off | Index approval before production |
| M2 | **Done against a mocked provider only** (see "AI Builder" below): homepage and section suggestions, page writing and improvement, SEO suggestions (with product and category SEO fields), theme advice, product text modes. Real Gemini output still needs the staging run | Staging key for the real run |
| M3 | **Done except the admin usage view**: `AiUsage` counters, monthly plan allowance (`features.aiRequestsPerMonth`, default 30), atomic enforcement before any provider call, admin plan field | — (30 a month approved; per plan in the Super Admin plan manager) |
| M4 | **Code done**: Gemini wired through consent, sanitization and usage; staging suite (`npm run test:staging-ai`, dry run passing). **Not done**: the real staging run (needs a staging key) | Production activation (separate approval) |
| M5 | **Partly done**: the editor's AI assistant panel (requests become storefront proposals). **Not done**: the store-management assistant (sales, stock and plan questions); it would send order-derived metrics to the provider, which the pending data-sharing decision does not allow | After M1–M4 and the data-sharing decision |

## 5. Tests required per milestone

- Mocked provider only; a test that fails if any non-allowlisted host is
  called.
- Adversarial outputs: oversized text, unknown theme, another business's
  product or page ids, unowned media, script/HTML strings, extra fields.
- Authorization: staff, other businesses, signed-out users, unverified email.
- Concurrency: two applies of one proposal; apply after the page changed.
- Preview never writes; apply never publishes.
- Metrics records contain no prompt or output text.

## AI Builder (natural-language requests)

`/dashboard/businesses/[id]/ai-builder` (`frontend/components/dashboard/ai/AiBuilder.tsx`),
also opened from the section editor for the current page (`VisualEditor`). The
homepage editor keeps its assistant (`AiAssistantPanel`) and links here. The
earlier planner is unchanged at `/ai-builder/planner`.

**Understanding a request.** `backend/lib/ai-builder/intent.ts` classifies the request
deterministically (no AI call, no allowance used) as homepage, section, page,
SEO, theme or product work, and within it content, layout, style, new or
existing section, new page or page change. The owner sees "Understood as ..."
and can correct it. The provider is never asked to choose a task, so it cannot
turn a request into another kind of write. Each task has its own strict output
schema, and all of them go through `guardAiRequest` and `runAiRequest`:

| Task | Route | Output | How it reaches the store |
| --- | --- | --- | --- |
| Homepage, homepage sections | `POST .../ai/storefront` (existing) | Change set | Proposal -> approve -> apply to draft -> publish |
| New page, draft page change, section on a page | `POST .../ai/page` | `backend/lib/ai-builder/page-builder.ts` -> existing editing actions | Proposal -> approve -> apply to draft -> publish |
| SEO for a page, product or category | `POST .../ai/seo` | `backend/lib/ai-builder/seo.ts` | Never saved by the route; the owner edits and saves through the normal update |
| Theme advice | `POST .../ai/theme`; `GET` works without AI | `backend/lib/ai-builder/theme-advisor.ts` | Never saved; applying is the normal theme change (`assertCanUseTheme`) |
| Product text | `POST .../ai/product-copy { mode? }` (existing, extended) | Description, highlights, SEO text | Never saved; the owner edits and saves |

**Pages.** The AI writes text only, into hero, about, features, faq, cta,
contact and products sections, using each section's own fields. It can never
set images or media, write testimonials, ratings, statistics or prices, or
write contact details: the contact section is filled from the business settings
on the server, and those details are not sent to the provider. Products
sections may name real categories only, and buttons link only to the store's
own pages. Unknown facts must be `[[placeholders]]`; pages created this way
carry `generated.source: "ai"`, so the publish route refuses them while
placeholders remain and the editor identifies them as AI-written. The first page
of a store without pages also creates the Home mirror (`ensureHomeMirror`), so
the homepage does not change.

**Published pages stay live.** Proposals only change draft pages (a tested
guarantee, unchanged). For a published page the route returns `409
page_published`; with `asNewDraft` the improved version becomes a new draft page
(`<slug>-new`, "<title> (new version)"), keeping the images and everything the
AI may not change. The owner reviews it and replaces the old page themselves.

**Staleness.** Page proposals are bound to the page version, homepage proposals
to a hash of the draft and brand. A newer owner edit makes them stale, and they
are refused at approval and at apply.

**Data sent (owner-approved 2026-11-02, consent version 2026-11-02).** The
current business's page titles, descriptions and page section text were added to
the data sent, so the disclosure names them and `AI_CONSENT_VERSION` was bumped:
every owner consents again. `safePageSections` sends section ids, types and text
fields only: never images, styles, or the contact section's details. A page's
own contact-section details are removed by value from the rest of that page.

**Saved contact details.** The business's saved email, phone and address are
removed by value (`withoutKnownContact`) from EVERY text field sent: each prompt
builder requires `knownContact` and scrubs its whole input first (business,
products, SEO targets, homepage, pages and the owner's request), and the planner
scrubs its brief. `runAiRequest` then refuses a prompt that still contains one
(`assertNoKnownContact`, values of 8+ characters), before anything is charged. An
address worded differently cannot be detected, and the disclosure says so.
Expanding this data scope needs a separate approval. Everything else follows the rules above (no
customers, orders, payments, accounts, secrets, contact details, prices, stock
or SKUs). What the store HAS is sent as booleans only (`storeHas`). Policy text,
delivery settings, prices and the address stay on the server, used only by the
claims check, as with homepage suggestions.

**Claims.** `findUnsupportedClaims` runs on all generated store text. Placeholders
and FAQ questions are skipped: they state nothing. Theme advice is not store
text, so it is not checked.

**SEO fields (additive).** `Product.seoTitle`, `seoDescription`, `imageAlt` and
`ProductCategory.seoTitle`, `seoDescription`; empty means derived, as before.
Omitting them from a category update keeps the stored values. Canonical URLs and
the sitemap are unchanged. A page's SEO text is a draft until the page is
published, as before.

**History.** Homepage and page requests are listed from their proposals, with
the owner's words. SEO, theme and product requests are not stored anywhere
(`AiUsage` is counters only), so they are listed for the current visit only.

**Admin.** `/admin/ai-usage` (`backend/lib/admin/ai-usage.ts`) shows stored counters
only: totals, per business, per plan, by kind of request and by month, remaining
allowances, and businesses at 80% or more of their allowance. Tokens are shown
only as the provider reported them, no costs are estimated, and allowances are
changed in the plan manager.

**External setup still needed:** a dedicated staging key for
`npm run test:staging-ai`. The new tasks have only run against a mocked provider.
