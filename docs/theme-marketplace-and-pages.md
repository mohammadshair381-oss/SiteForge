# Theme marketplace, plan-based theme access and default pages

Status: implemented (2026-10-31). This document records the architecture audit
done before the change, then the design that was built on top of it.

## 1. Audit (before any change)

### Entitlements
- **Authoritative source:** `backend/lib/billing.ts` `getEntitlements(businessId)`:
  the latest `Subscription` of the business, its populated `Plan`, and
  `isEntitlingSubscription` (active/trialing; paid plans only until
  `currentPeriodEnd`). Every limit (`assertCanAddProduct`, `assertCanPublish`,
  `assertCanAddStaff`, `assertCanAddCustomDomain`) and the AI allowance read
  from it. There is no second permission system.
- **Plans:** `backend/models/Plan.ts` `features` (product/staff limits, custom domain,
  branding, AI requests). Seeded plans (`backend/scripts/seed.ts`): `free` (0),
  `starter` (19), `pro` (49). There is no plan called "Max"; `pro` is the top
  tier.
- **Super Admin plan manager:** `POST /api/admin/plans` (create/update with
  zod schemas, audited in the same transaction via `runAuditedAdminAction`)
  and `frontend/components/admin/AdminPanel.tsx` `PlanManager`.
- New businesses get the `free` plan in the creation transaction
  (`POST /api/businesses`), and defaulted to `themeId: "aurora"` (model default).

### Themes
- Nine ids in `backend/lib/constants.ts` `THEME_IDS` (append-only), metadata in
  `backend/lib/themes.ts`, design systems in `frontend/themes/skins/<id>.ts`, one renderer
  (`CommerceShell` and its shared variants).
- **Every theme change goes through `PATCH /api/businesses/[id]`** (theme
  page, website editor via `backend/lib/editor-save.ts` and `HomeEditor`, setup brand
  step, legacy section editor) or `POST /api/businesses` (creation). No other
  code writes `themeId`. Neither route checked any theme permission.
- Pickers: theme page (`ThemeEditor`, live preview with draft data), editor
  theme menus (`HomeEditor`, `VisualEditor`), setup brand step (`BrandStep`).

### Pages
- `backend/models/Page.ts`: title, slug (unique per business, reserved slugs refused
  in `backend/lib/validation.ts`), `sections` (draft) / `publishedSections`
  (snapshot), status, `isHome`, SEO title/description with a published
  snapshot, `version` for optimistic concurrency.
- Routes: `GET/POST /api/businesses/[id]/pages`,
  `GET/PATCH/DELETE /api/businesses/[id]/pages/[pageId]` (publishing a page is
  `PATCH status: "published"`; store publish never publishes pages).
- Sections (`backend/lib/sections.ts`): hero, products, about, features, cta, footer,
  faq, testimonials, gallery, pricing, contact, newsletter, stats; strict zod
  schemas, safe links, media ownership checks.
- **Homepage resolution (`backend/lib/storefront-pages.ts`):** `/` renders the PUBLISHED
  `isHome` page (an empty published home page renders the commerce homepage).
  Until one exists (no Page documents, a draft Home, or no Home at all) `/`
  renders from the theme settings, which is the commerce homepage when they
  hold no sections. `/` is never a 404 on a public store, and drafts are never
  public. Page generation and proposals still add a published Home page that
  reproduces the current homepage. Without a published Home page the website
  editor opens this same fallback (`selectEditorPage`, `backend/lib/editor-mode.ts`),
  labelled "Store homepage" in the page menu; a draft Home page with sections stays in the page list.
- A home page WITH sections replaces the commerce homepage ("classic
  homepage"), so generated defaults never give the home page sections.
- Navigation (`themeSettings.navigation` draft, `publishedNavigation`
  public): items reference page ids; the public view keeps only PUBLISHED
  pages, so draft pages in the draft navigation never show publicly. The
  navigation builder only offered published pages.
- SEO (`backend/lib/seo.ts`): per-page metadata from the published SEO snapshot,
  canonical `/` for the home page, sitemap of published pages only.

### Rendering of non-home pages
- `frontend/components/storefront/SectionRenderer.tsx` (client) renders page sections
  inside the theme's header and footer. Before this change it had ONE layout
  for every theme plus a small palette map, its own plain product cards, and
  a `font-sans|serif|mono` class that overrode the theme typography.

### Editor
- `/dashboard/businesses/[id]/editor?page=<id>`: the home page opens the store
  homepage editor; every other page opens the section editor (`VisualEditor`:
  page switcher, add/remove/reorder/hide sections, content and style editing,
  undo/redo, devices, draft save, per-page publish). No section duplication.

### AI
- The AI planner (`/ai-builder`) already generates page plans through the
  owner-approved Gemini integration (consent, sanitization, proposals,
  draft-only apply). Production AI is off.

## 2. Plan-based theme access

- **Default distribution** (`backend/lib/theme-tiers.ts`, the only place it is
  written down): Free = Bistro, Market, Studio; Starter = Free + Aurora,
  Launch, Harvest; Max = all nine (Atelier, Volt, Forma added).
- **Which list applies:** `planThemes(plan)` uses `Plan.features.themes` when
  it is a valid, non-empty list; otherwise the tier for the plan key (`free`,
  `starter`, `max` or `pro`). Unknown keys: a free plan gets the Free tier, a
  paid plan all nine. The seeded plans set the list explicitly.
- **Entitlement:** `getEntitlements` returns `themes` with the other limits; a
  business without an entitling subscription (none, expired, cancelled) gets
  the Free themes. `getThemeAccess(businessId)` adds the current theme, the
  cheapest ACTIVE plan that includes each theme (upgrade information) and
  `grandfathered`. Every picker (theme page, editor menus, setup brand step)
  receives the same `ThemeAccess` from the server.
- **Enforcement:** `assertCanUseTheme` (402 `theme_not_in_plan`, naming the
  cheapest plan) in `PATCH /api/businesses/[id]` and `POST /api/businesses`,
  the only routes that write `themeId`.
- **Downgrades:** keeping the current theme is always allowed (re-saving it
  too), so a downgraded or expired store never changes; switching away to an
  included theme works, switching back needs the plan again.
- **New businesses:** `defaultThemeFor(category, allowed)` picks the best
  theme for the business type that the free plan includes (food -> Bistro,
  clothing -> Studio, electronics -> Market, ...). Existing businesses keep
  their stored `themeId`.
- **Super Admin plan manager:** each plan has a "Themes included" checklist.
  `POST /api/admin/plans` validates `features.themes` (known ids only, no
  duplicates, at least one; stored in catalogue order), audits the change in
  the same transaction, and treats a reordered identical list as a no-op.
  Unknown plans are 404 on `mode: "update"`; non-admins get 403. A change
  applies at once to every store on that plan.

## 3. Theme marketplace

`/dashboard/businesses/[id]/theme` (`frontend/components/dashboard/ThemeMarketplace.tsx`):
all nine themes are visible on every plan. Each card shows the marketplace
thumbnail, name, identity, best-fit categories, visual and motion notes, and a
badge: "Current", "Included" or "<Plan> plan". Filters: All / Included /
Upgrade. Locked themes show "Upgrade to <plan>" (owners, linking to Billing)
or "Ask the store owner to upgrade" (managers); the API refuses them anyway.

**Preview** opens a dialog (focus trapped, Escape closes) that renders the
REAL storefront renderer (`ThemeRenderer`/`CommerceShell` through the existing
preview frame) with the store's draft data in that theme, at Desktop, Tablet
or Mobile width, for the homepage or any content page. A store with no
products can switch on clearly-labelled sample products
(`backend/lib/theme-preview-samples.ts`), used only in the dialog. Preview never
saves, publishes or changes the theme. **Use in draft** puts the theme in the design draft and keeps the owner's other
design choices. The live store changes only when the owner publishes it, from this
page, Design or Publish, and that publish needs a plan that includes the theme.

## 4. Default pages

`backend/lib/page-presets.ts` (pure, deterministic) plans the pages;
`backend/lib/page-generation.ts` loads the real data and creates them.

**When:** after a business is created (best effort, outside the creation
transaction; a failure is logged without details and never fails the
creation), and whenever an owner or manager presses "Prepare" in
"Recommended pages" (Pages screen and setup wizard structure step):
`GET/POST /api/businesses/[id]/pages/defaults` (owner/manager, same-origin
JSON, rate limited, `{ keys? }` to prepare only some pages).

**Rules:**
- Pages are created as DRAFTS, never published. The home page is never
  generated and "Shop" is the built-in catalog at `/products`.
- A page is created only when no page with its slug or its generated kind
  exists: existing pages are never touched, repeated or concurrent runs create
  nothing twice (unique slug index; duplicate-key errors are reported as
  "existing").
- A store with no pages yet first gets a published Home page whose sections
  are exactly the legacy homepage sections, so `/` renders the same thing in
  multi-page mode (empty sections = the commerce homepage).
- Draft navigation is filled only for an area (header, footer) that is still
  empty, with a conditional update; public navigation changes only when the
  owner publishes. Header gets at most 5 links, footer at most 10. Category
  pages are not linked (the header already lists every product category).
- No invented facts: text comes only from the owner's data (name,
  description, contact details, delivery settings, policy text, COD/online
  payment status). Everything else is a visible `[[placeholder]]`.
  Category pages exist only for real product categories, "Offers" only when a
  product has a real compare-at price, "New arrivals" only with 2+ products,
  "Menu" only with products.
- Generated slugs are never reserved storefront routes (`terms` becomes
  `terms-and-conditions`).
- **Publishing a generated page** (`PATCH .../pages/[pageId]`): 422
  `placeholders_remaining` while any `[[...]]` remains; policy and legal
  templates (`needsReview`) also need `confirmReviewed: true` (409
  `review_required` otherwise); the review is recorded on the page
  (`generated.reviewedAt`, `reviewedBy`). Owner-created pages are unaffected.

## 5. Category mappings

| Business type | Family | Pages (when the data exists) |
| --- | --- | --- |
| clothing, shoes | Fashion | Men, Women (real categories), Collections (2+ categories), New arrivals, About the brand, Contact, FAQ, Shipping, Returns, Privacy, Terms |
| electronics, technology, hardware | Electronics | New arrivals, Offers, About, Contact, FAQ (with a warranty question), Product support, Warranty information (template), Shipping, Returns, Privacy, Terms |
| grocery | Grocery | Fresh produce (real category), New arrivals, Offers, Delivery information (template), About, Contact, FAQ, Shipping, Returns, Privacy, Terms |
| furniture | Furniture and home | Living room, Bedroom, Home decor (real categories), Collections, New arrivals, Delivery and returns (template), About, Contact, FAQ, Privacy, Terms |
| food | Restaurant | Menu (with products), About, Contact, Reservations and enquiries (no booking system: explains how to reach you), FAQ, Shipping (only with delivery set up), Privacy, Terms |
| anything else | General retail | New arrivals, Offers, About, Contact, FAQ, Shipping, Returns, Privacy, Terms |

The "Not suggested yet" list explains every page that was skipped and why.

## 6. AI and the deterministic fallback

Default pages are always generated by the deterministic templates above, so
they work with AI off (production) and never send store data anywhere.
AI-written page drafts remain the existing AI planner's job (`/ai-builder`):
consent, kill switch, sanitized allowlist inputs, no customer/order/payment
data, claim checks, proposals that an owner approves and applies as drafts.
"Recommended pages" links to it. No new AI path was added.

## 7. Page model and API changes (additive)

- `Page.description` (optional, max 300) and `Page.generated` (`key`,
  `source: template|ai`, `preset`, `needsReview`, `createdAt`, `reviewedAt`,
  `reviewedBy`). Existing documents are unaffected; no index changes.
- `Plan.features.themes` (optional enum array; absent = tier default).
- `pageCreateSchema`/`pageUpdateSchema`: `description`; `confirmReviewed`.
- Products section settings: optional `category`, `collection`
  (`all|new|sale`) and `limit` (1-48).
- New route: `/api/businesses/[id]/pages/defaults` (GET, POST).

## 8. Editor

The existing editor (`VisualEditor`) gains: section duplication, product
section filters (category from the store's real categories, all/new/sale,
number of products), a notice on generated pages (placeholders left, review
needed) and a review confirmation before publishing a policy template. Page
switching, add/remove/reorder/hide, styles, devices, undo/redo, draft save
and per-page publishing are unchanged. Theme menus show locked themes as
disabled with the plan that includes them. Switching theme only changes
`Business.themeId`; page sections are kept as they are and every section
type renders in every theme, so nothing becomes incompatible.

## 9. Theme-wide rendering

`SectionRenderer` now renders every content page through the theme's skin
(`frontend/themes/skins/<id>.ts`): container, typography and colour tokens, cards,
buttons, hero composition (overlay, split or type-led), product grid density
and the shared `ProductCard`, FAQ accordion style, footer. A page without a
hero gets exactly one `h1` (its first titled section). Product detail,
catalog, category, search, cart, checkout and account pages already used
`CommerceShell` and the skins.

## 10. Navigation and SEO

The navigation builder now lists draft pages too (labelled "draft: shows once
published"), so generated pages can be arranged before publishing; the public
navigation still shows only published pages. Generated pages carry a title,
SEO title and SEO description from the owner's data; drafts are not in the
sitemap and 404 publicly; canonical URLs, breadcrumbs and structured data are
unchanged (`backend/lib/seo.ts`).

## 11. Security

- Theme access: server-side only, through the central entitlements; the plan
  of one business never affects another; staff cannot change themes.
- Pages: owners and managers only (`requireBusinessRole`); staff 403; other
  businesses 403; same-origin JSON for preparation; drafts never public.
- Generation reads only the owner's own business data; no customers, orders,
  payments, secrets or environment values; nothing is sent to a provider.

## 12. Website history, page operations and redirects

Version history (`backend/models/WebsiteRevision.ts`, `backend/lib/website-revisions.ts`): one
scoped collection holding copies of pages, the homepage draft, the design and the
menus. A copy is kept when something is published, at most every 30 minutes while
a draft is being saved (`checkpoint`), before a restore, before going back to the
published version, and when a page is deleted. Twenty are kept per item; copies of
deleted pages are not pruned. Recording is best-effort: a failed copy never blocks
a save or a publish.

Restoring (`POST /api/businesses/[id]/revisions/[revisionId]/restore`) changes the
DRAFT only. A restored deleted page comes back as a new draft at a free address.
Every read and write is scoped by business, for owners and managers.

`WebsiteRevision` has `autoIndex`/`autoCreate` off. Creating this index is an
approved operation and has NOT been run on any persistent database:

```js
db.websiterevisions.createIndex({ business: 1, target: 1, targetId: 1, createdAt: -1 })
```

Page operations: duplicate (`pages/[pageId]/duplicate`, always a new draft),
go back to published (`pages/[pageId]/revert`), templates (`backend/lib/page-templates.ts`:
facts come from the business, unknowns are `[[placeholders]]`), unpublish
(`PATCH status: draft`). Changing a published page's address keeps the old one in
`Page.previousSlugs`, and the store answers it with a permanent redirect
(`findPageRedirect`). An address another page uses is refused with `slug_taken`.
Per-page search settings add `seoImage` and `noindex`, published with the page; a
`noindex` page also stays out of the sitemap.

