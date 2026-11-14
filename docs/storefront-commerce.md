# Storefront commerce homepage

How the public store's header, homepage, product discovery and footer work,
and how owners configure them. Applies to all nine themes (see "Theme
collection" below; design research: `docs/theme-design-research.md`).

## Rendering

```
app/store/[[...slug]]/page.tsx ─┐
app/store/products|product|cart|order|policies|account ─┤
                                └─ backend/lib/storefront-commerce.ts  loadStorefrontFrame()  (server only)
                                      ├─ published pages + navigation (toStorefrontView)
                                      ├─ best sellers: PAID orders of this business, last 180 days
                                      ├─ account state (shopperBarProps), online payment, COD
                                      └─ backend/lib/storefront-home.ts  buildCommerceData()  (pure)
                                            └─ themeSettings.publishedStorefront (backend/lib/storefront-config.ts)
```

- `frontend/themes/*Theme.tsx` are thin wrappers around
  `frontend/components/storefront/commerce/CommerceShell.tsx` with a per-theme
  `StoreSkin` (`frontend/themes/skins/<id>.ts`, registry and types in
  `frontend/components/storefront/commerce/skins.ts`). Behaviour, data and
  accessibility are shared; the skin decides colours, type, shapes, density,
  motion and which shared layout variant each part uses (see "Theme
  collection"). Exactly one `<header>`; editor targets (`data-editor-id`) only
  when `editable`.
- A homepage with configured sections (legacy `themeSettings.sections` or a
  published home Page with sections) keeps rendering those sections inside the
  commerce header/footer. The commerce homepage body renders when there are
  no sections (new stores, empty published home page).
- Inner pages use `StoreFrame` (same header/footer). Cart, order and account
  content keeps a light content area inside the dark themes (Aurora, Volt).
- Content pages (About, FAQ, policies, custom pages) render their sections
  through `SectionRenderer`, which uses the same theme skin (typography,
  cards, buttons, hero composition, the shared `ProductCard`). Theme access
  per plan and default page generation: `docs/theme-marketplace-and-pages.md`.
- Client islands only: `CartCount` (reads the existing cart API, listens for
  `siteforge:cart-updated` from `backend/lib/cart-events.ts`), `MobileMenu` (modal
  drawer: focus moved in, trapped, Escape closes, focus returns),
  `QuickAddButton` (existing cart POST; server re-checks stock and price),
  `PreviewLinkGuard` (dashboard previews do not navigate).

## Theme collection

Nine themes, one renderer. The first five ids are the original themes
(`THEME_IDS` is append-only, so stored values stay valid); switching themes
changes only `Business.themeId` (`tests/integration/theme-switching.test.ts`,
`navigation-design.test.ts`).

A theme is more than colours and fonts: `skin.layout` picks one of nine shared
compositions for each part of the page, and no two themes share one (locked by
`tests/unit/theme-collection.test.ts`). Spacing and rules between sections
(`skin.spacing`, `skin.divider`) differ too. Section order stays the owner's
(or the business-type preset's): a theme never moves or hides content.

| Theme | For | header | section heading | hero | products | card | categories | benefits | promotions | story | footer | account |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| aurora | premium lifestyle | glass pill | glow | immersive | scroller | lift (details on the image) | mosaic | glass | overlay | statement | wordmark | rail |
| market | retail | marketplace bar | bar | panel | white panel | retail | rail | one-line strip | compact strip | plain | columns | rail |
| bistro | food | signboard | flourish | arch | menu board | menu | menu | notes | band | centered | postcard | tabs |
| studio | editorial | minimal | numbered index | editorial | heading column | plain | index | ruled | caption | offset | ledger | tabs |
| launch | bold DTC | slab cells | slab | statement (+ marquee) | bento with a tile | bold | blocks | joined cells | poster | shout | slab | blocks |
| atelier | luxury fashion | centred masthead | caps | campaign | lookbook | couture | campaign | line | full-bleed | manifesto | couture | tabs |
| volt | electronics | console | path | spotlight window | hairline cells | tech | tech | spec table | feature | readme | terminal | rail |
| harvest | grocery | grocer chips | chip | banner | shelf | fresh | bubbles | bubbles | tiles | note | sheet | rail |
| forma | furniture | words, no icons | quiet | room | stagger | gallery | rooms | list | inset | spread | colophon | tabs |

Pages built from sections (`SectionRenderer`) follow the same theme: hero
composition, product framing (`RAIL_LAYOUT`), feature cards (`FEATURE_LAYOUT`),
heading marks, call-to-action blocks and their own footer section. Catalog and
category pages open with `StorePageHead`, and the product page sets its details in
`skin.detailPanel`. Account, cart and order pages use `accountVars` / `surfaceVars`
and the `sf-acc-*` classes, so client forms need no skin and dark themes stay dark.

**Previews on the marketing pages.** `frontend/components/marketing/sample-store.ts` gives
each theme a fictional business, with photos from `public/samples`
(`docs/sample-media-credits.md`). Those images are added after the config is read
and never reach a saved config: owner configs still accept media-library images
only. `ThemePreviewImage` shows a screenshot of the real renderer with that sample
store, saved in `public/theme-previews` (800 x 1000 desktop, 360 x 720 phone). They
do not update themselves, so retake them after changing a theme's look. The
dashboard's own store cards keep the schematic `ThemeThumbnail`, so a sample store's
name never appears on an owner's store.

- Variants live in the shared components: `StoreHeader` (header),
  `StoreHero`, `ProductCard`, `CategoryShowcase`, `CommerceHome`
  (promotions, story, marquee), `StoreFooter` (columns or wordmark),
  `MobileDock`, the product page (`ProductGallery`, stacked images,
  `Specifications`) and the catalog page (toolbar or sticky sidebar). Every
  variant shows the same facts from the same data; a new theme is a new skin
  file plus a registry entry, never a new renderer.
- Typography: each theme has its own self-hosted typeface (`app/fonts/theme-*`,
  declared with `--sf-font-*` in `app/globals.css`; open licences, 25-60 KB, only
  downloaded when used, `font-display: swap`). Each skin sets `--sf-display`/`--sf-body` on the page root
  (`storeRootProps`). The owner's font setting "Theme default" (stored as
  `sans`) keeps the theme's type; "Serif" or "Mono" replaces it everywhere.
- Volt's specification table shows category, option names and values and
  availability; the comparison table lists each purchasable variant with its
  own price and availability. Nothing else (no invented specs).
- Cards show a second image on hover only when the product has a different
  real image (`StorefrontProduct.hoverImageUrl`).
- The brand colour is always visible in the header: a letter tile (bar and
  commerce headers, when there is no logo) or a thin brand rule (centered and
  minimal headers, which set the name in type), so palette changes show even
  for an empty store.
- Catalog: `?stock=in` ("In stock only", server-side stock) in every theme;
  sidebar themes add category counts in a sticky sidebar (a horizontal list
  on phones).

### Motion

No animation library (Motion would add ~5-43 kB and client components; GSAP's
licence excludes no-code animation builders). CSS keyframes/transitions in
`app/globals.css`, transform and opacity only, all inside
`prefers-reduced-motion: no-preference`:

- hero entrance (`sf-enter`, staggered, capped at 0.9s), hero image settle
  (`sf-settle`), card hover lift/zoom and image rollover, button press, the
  add-to-cart "Added" pop and cart-badge bump, drawer slide and backdrop fade,
  gallery crossfade, Launch's marquee (pauses on hover/focus).
- Scroll reveals: `MotionRoot` (one tiny client island per page) marks
  `[data-reveal]` elements that are still below the fold after mount as
  pending and reveals them with `IntersectionObserver`. Nothing is hidden by
  the server, content on screen is never hidden, it is off in the editor
  (`editable`) and with reduced motion, uses the element's own document, and
  disconnects on unmount.
- Each skin sets `--sf-ease`/`--sf-dur` (its motion language: e.g. Atelier
  slow, Launch and Volt crisp, Harvest lively).
- With reduced motion every animation is off and the marquee shows each item
  once, wrapped.

## Content rules (nothing fabricated)

| Section | Source | Hidden when |
| --- | --- | --- |
| Categories | product `category` strings of active products (owner may choose/order and add images) | fewer than 2 categories with products |
| Featured | owner's selection, else newest products | no products / `showProducts` off |
| Best sellers | units in **paid** orders of this business (180 days) | fewer than 2 products with sales |
| New arrivals | product `createdAt` within 45 days | none, or identical to Featured |
| On sale | `compareAtPrice` strictly greater than `price` | no real reductions |
| Promotions | owner banners (max 3) | disabled or without a title |
| Shopping information | owner text + automatic "Secure online payment" (Razorpay connected and usable) and "Cash on delivery" (accounts on + `codEnabled`) + support from contact details | nothing to say |
| Story | business description / theme about | empty |

- Ratings and reviews appear only from APPROVED verified-purchase reviews
  (`docs/commerce-operations.md`); a product without them shows none. No
  testimonials are ever generated.
- Availability comes from `stock` but only as a derived value
  (`availability`: `in_stock` / `low_stock` at ≤ 5 / `out_of_stock`, shown as
  "Sold out" or "Only a few left"). The exact stock count is never part of the
  public view, which client components receive.
- Every owner link is an internal path, re-checked at render time
  (`resolveInternalHref`) against active products, categories with products and
  published pages. A button whose target does not exist is not rendered.
- `removeBranding` hides "Powered by SiteForge" only; the store name is always
  shown (pricing copy: "Remove SiteForge branding").

## Owner configuration

Dashboard → **Storefront** (`/dashboard/businesses/[id]/storefront`, owners and
managers): announcement bar, hero (desktop/mobile image, text, alignment,
overlay, two buttons), section order and visibility, featured products (≤ 12),
categories (≤ 12, optional images), promotional banners (≤ 3), shopping
information, shipping/returns policy text (shown on `/policies`), footer text
and social profiles (HTTPS on the listed networks only).

| API | Who | Notes |
| --- | --- | --- |
| `GET /api/businesses/[id]/storefront` | owner, manager | draft, published, `hasUnpublishedChanges` |
| `PUT /api/businesses/[id]/storefront` | owner, manager | same-origin JSON; zod schema (no HTML, internal links only); featured products must be this business's non-archived products; images must be this business's media (external HTTPS allowed, as elsewhere); writes only `themeSettings.storefront` with `$set` |
| `POST /api/businesses/[id]/storefront/publish` | verified owner, manager | `assertCanPublish`, refused while suspended (conditional write); copies the draft to `themeSettings.publishedStorefront` |

Publishing the store itself (`POST /api/businesses/[id]/publish`) also
snapshots the storefront draft, like navigation and design tokens. The public
store reads only `publishedStorefront`; `toStorefrontView` strips both keys
from `view.theme` so a draft never reaches the page payload. The dashboard
preview (`/preview`) renders the draft.

Products: optional **Original price** (`Product.compareAtPrice`, default
`null`). Create/update reject an original price that is not higher than the
price (`invalid_compare_at_price`), including a later price change that would
invert it.

## Data and compatibility

- No migration: both config keys are optional inside the existing Mixed
  `themeSettings`; a missing or invalid stored value renders the defaults.
- `compareAtPrice` defaults to `null`; existing products are unaffected.
- The best-seller aggregate uses `{ business, status: "paid", paidAt }`; the
  existing `business` and `status` indexes serve it. No new index is required.
- A business that already has a published page with the slug `policies` keeps
  that page at `/policies`; the policies link is then not added.

## Known limitations

- No wishlist or quick view (deliberately not shown).
- Newsletter sign-up is not offered (no subscription workflow exists).
- Categories are linked by the product `category` text; managed categories
  (`ProductCategory`) add order, images, descriptions and `/category/<slug>`
  pages.
- Product image galleries show `imageUrl` plus `images[]` as thumbnails (no
  zoom or carousel).
- Stores whose home page uses custom sections keep those sections; the
  commerce homepage body is used only without sections.

## Homepage sections, presets and the website editor (version 2)

- The homepage is an ordered list of section INSTANCES in
  `themeSettings.storefront.sections` (draft) / `publishedStorefront.sections`
  (live): `categories`, `featured` (product collection; may appear several
  times), `bestSellers`, `newArrivals`, `sale`, `promotions` (several
  allowed), `benefits`, `story`. Each has an id, heading, small heading,
  appearance (background, spacing, alignment) and its own content. Version-1
  settings are upgraded on read (`backend/lib/storefront-config.ts`); no migration.
- Presets (`backend/lib/storefront-presets.ts`) give each business type a starting
  layout: clothing, shoes, electronics, grocery, furniture, cosmetics,
  hardware, general retail. The business type is `Business.category`
  (new store types were added to `BUSINESS_CATEGORIES`; older types map to
  the closest preset). New businesses get their preset as the draft; a store
  without stored settings uses its preset. Presets contain headings only:
  sections are filled from real data and hidden while empty (best sellers
  need paid orders, new arrivals recent products, deals real reductions).
  There is no "Featured brands" section because SiteForge has no brand data.
- Website editor (`/dashboard/businesses/[id]/editor`): the homepage opens
  the store homepage editor (`frontend/components/dashboard/editor/HomeEditor.tsx`):
  a section navigator, settings for the selected section, add / duplicate /
  remove / reorder / show-hide, undo/redo, save draft, preview, publish. The
  preview is rendered by `ThemeRenderer -> CommerceShell -> CommerceHome`
  with `buildCommerceData` and the DRAFT settings: the same code as the public
  store; only selection outlines and disabled links differ. Other pages and
  homepages that still use classic custom sections open the section editor
  (`VisualEditor`), which offers "Switch to the store homepage"; publishing
  the store homepage then retires the classic sections (empty published page
  sections render the store homepage).
- Editor layout (`EditorWorkspace`): a docked 340px editing sidebar on
  desktop with independent scrolling (never covering the preview), a reopen
  button when closed; a modal slide-in drawer below 1024px (backdrop, Escape,
  focus trap, inert background, focus restored).
- Device preview (`PreviewFrame`): both editors render the store components
  into a same-origin iframe whose viewport is the device width (desktop at
  least 1024px, tablet 768px, phone 375px), so the store's responsive styles
  behave as on that device; the frame is zoomed out to fit a narrower canvas.
  It is still the editor's own React tree (live draft, no second renderer).
  Consequence for storefront client components: use the element's
  `ownerDocument` (listeners, portals, body scroll lock), never the global
  `document`, and never `instanceof Element` on event targets.
- The classic section editor no longer fills an empty page with generated
  placeholder sections, and the classic "About" section no longer shows
  "Information coming soon." (preview hint only; nothing on the live store).

## Page editor autosave and rate limits

- The page editor saves a draft 5 seconds after the last change, through the same route as every other page
  change (`PATCH /api/businesses/[id]/pages/[pageId]`).
- That route has two limits. Every write by one person to one store counts towards 240 per 15 minutes, checked
  before the body is read: autosave needs at most 180. A write that changes anything besides draft `sections` also
  counts towards the existing 20 per 15 minutes per address: publishing, page addresses, the homepage choice, titles.
  Which applies is decided from the validated body, never from anything a client says about itself. Roles,
  validation, media checks, tenant scope and `expectedVersion` are the same for both.
- A refused save loses nothing: the edits stay in the window, and leaving still warns. A `429` is always shown,
  with roughly how long until the save is tried again, using the server's `Retry-After`. A connection or server failure
  is tried again after 30 seconds, and says so. A value the server refuses, such as something half-typed, is not
  repeated: the editor says the changes are not saved, and the next edit or "Save now" tries again.
- The store homepage, design and menu editors have no rate limit on their draft routes, and are not affected.

## Guided store setup (wizard)

`/dashboard/businesses/[id]/setup` (owners and managers; "Store setup" in the
dashboard menu). New businesses start here after creation; the overview shows
progress and a "Continue setup" button until every step is done.

1. Business details: name, business type, description, location, contact, logo
   (business route).
2. Brand: one of the nine themes (a suggestion per business type), a palette or
   custom primary/accent colours, font and logo, with a live device preview
   (`backend/lib/brand-presets.ts`; store-wide settings, applied when saved).
3. Homepage: the business type's preset with each section's real-data status;
   applying it replaces the DRAFT homepage sections only.
4. Products: the existing product manager (skippable).
5. Store settings: delivery, payments (owner), customer-account availability,
   contact details, policies (existing components; skippable).
6. Preview and publish: the draft store on every screen size, what is required
   to publish (the publish route's own checks) and recommendations; publishing
   is an explicit action.

`PUT /api/businesses/[id]/setup` stores only progress (`Business.setup`: last
step, confirmed and skipped steps); step completion comes from real data where
possible (`backend/lib/store-setup.ts`).

## Design drafts, menus, homepage blocks and publishing

Design draft (`backend/lib/design-settings.ts`, `backend/lib/design-service.ts`, `/design`): theme,
colours, heading and text fonts, button corners and text size are saved to
`themeSettings.designDraft` and go live only when published. Only previews read the
draft (`toStorefrontView` with `useDraft`); the public view strips it. Live choices
are `themeSettings.design`. A saved draft cannot use a theme outside the plan.
These choices change tokens only: `storeRootProps` applies fonts, a button shape
class on `sf-btn` and a zoom, while each theme keeps its own layouts. The theme
gallery, both editors, AI theme suggestions and the setup wizard on a live store all
fill this draft through `PATCH /api/businesses/[id]/design` (`updateDesignDraft`),
which changes only the fields it is given and refuses locked themes, so the owner's
colours and fonts stay. Publishing is the only way the live design changes.

Menus (`backend/lib/navigation.ts`): an item links to a page or to a safe `href`, and a
header item can hold one level of `children`. Drafts live in
`themeSettings.navigation`, the live menus in `publishedNavigation`, and links to
unpublished or missing pages are left out of the public store. A store without a
published copy shows its saved menus, so the first draft saved through
`PATCH /api/businesses/[id]` first freezes them into `publishedNavigation`. External links open
in a new tab. `NavDropdown` uses its own `ownerDocument`, as the editor renders the
store inside a frame.

Homepage blocks: a `block` homepage section holds one content section from
`HOME_BLOCK_TYPES` and renders through `SectionRenderer` (`embedded`), so there is
no second renderer. `block` is deliberately not in `HOME_SECTION_TYPES`, which is
what the AI planner may name.

Content sections added: `richText` (`frontend/components/storefront/RichText.tsx`, a small
safe format, never raw HTML), `imageText`, `video`, `logos`, `team`, `steps`,
`spacer`. `video` shows a picture and a play link that opens YouTube or Vimeo: an
inline player would need a `frame-src` allowance, and the security headers test pins
`frame-src 'none'`. Any section can be limited to phones or larger screens (`hideOn`).

Publish overview (`backend/lib/website-publish.ts`, `/publish`): lists what differs between
drafts and the live site, and publishes only the chosen items, each independently.
Pages that still have `[[placeholders]]` or an unreviewed policy template are listed
as not ready. Publishing is always an explicit action.

Both editors save drafts quietly a few seconds after the last change. A value the
server refuses stays unsaved until it is corrected; version conflicts always show.

## Publishing rules

Published copies (`publishedNavigation`, `publishedDesignTokens`,
`publishedStorefront`, `design`, a page's `publishedSections`) are written only by
the publishing services and the store publish route. `PATCH /api/businesses/[id]`
refuses them with a 422. A live store's theme, colours, font and older hero and about
settings cannot be changed through that route (`409 use_design_draft`), nor its
homepage sections (`409 use_website_editor`); a store that is not live can still set
them, as nothing is public and going live is checked. Changes to pages that show at
once pass `assertCanChangeLiveWebsite` (`backend/lib/publish-gates.ts`: not suspended,
verified email, a plan that allows publishing): publishing a page, choosing or
replacing the Home page, and renaming or moving a published page.

Taking content down is different on purpose: unpublishing or deleting a page needs
no plan or verified email, so an owner can always remove something from their store.
A suspended store can do neither, so its content stays as it is for review. Restoring
a version changes drafts only, a restored deleted page is a draft, and proposals and
plans never publish; AI brand changes go to the design draft.

Direct settings by design, not published content: business name, description, logo,
contact details, category, payment and shipping settings, and products and categories.

Menus prepared with generated pages carry `navigationDraftOnly`, so a store with no
published copy does not show them until the store or its menus are published.

## Older homepages

A homepage kept only in `themeSettings.sections` moves to a Home page record the
first time an owner or manager opens it for editing (`backend/lib/legacy-homepage.ts`,
`POST /api/businesses/[id]/homepage/adopt`). The record's published copy is exactly
what the store shows, so visitors see no change, and a draft Home page keeps its own
draft. A published Home page is never overwritten. The old sections are renamed to
`themeSettings.legacySections`, never shown or deleted. Stores nobody opens stay as
they are and keep rendering.

## Draft preview links

`backend/lib/preview-links.ts`, `backend/models/PreviewLink.ts`, `app/preview/view`. Owners and
managers with a verified email create a link to the whole site or one page, for 1
hour, 1 day or 7 days. It needs the same active plan as publishing, so it cannot
serve as free public hosting. The token is 256 random bits, returned once; only its
SHA-256 hash is stored, and it must never be logged. Every view re-checks expiry,
revocation, that the business is not suspended and has an active plan, and that the
creator is still an active, verified owner or manager. All failures are the same 404.

Links are served on the platform address only: a store address rewrites to `/store`,
which never reads drafts. Responses carry `X-Robots-Tag: noindex` and
`Referrer-Policy: no-referrer`, and the page sets the same in its metadata. The page
is deliberately not listed in robots.txt: a crawler must be able to read `noindex`,
and listing it would advertise the path. It shows the current saved draft through
the normal renderer with links and the cart off, and only an allowlist of settings
reaches the browser. A single-page link uses the published header and footer, so the
draft homepage is not part of what it shares. `next dev` adds debug data that can
include whole stored records, so outside production a link only opens on localhost:
never expose a development server. Reverse proxies and hosting logs can record the
address, so keep their retention short or strip `/preview/` paths. Indexes:
`docs/database-preparation.md`.

## Website builder additions

Everything below is saved to drafts, reaches the public store only by publishing, and is drawn by the one
renderer (`ThemeRenderer`, `SectionRenderer`, `CommerceShell`). Unset choices keep what the theme does, so a store
that changes nothing looks exactly as before.

**Sections.** A section can have an owner's `name`, shown only in the editor (`sectionDisplayName`, `homeSectionName`).
Drag, duplicate, remove with a confirmation, show and hide, undo and redo work in both editors.

**Section library** (`backend/lib/section-library.ts`, `frontend/components/dashboard/editor/SectionLibrary.tsx`). Add a template by adding
an entry to `SECTION_TEMPLATES`. Inserted templates are ordinary sections. Wording an owner must write is a `[[placeholder]]`,
and publishing any page or the homepage is refused while a visible section holds one (`findVisiblePlaceholders`,
`assertNoHomePlaceholders`). On the homepage a template becomes a block or a native section, and the hero template opens the
one existing hero. The `reviews` section shows only approved reviews from real orders (`recentApprovedReviews`), and nothing at
all to visitors until there are some. The public route reads reviews only when what it renders has a visible reviews section
(`reviewsWanted`), so no other page pays for that query or carries review text. Dashboard previews do the same, except the editor,
where a section can be added at any moment.

**Screen sizes** (`backend/lib/section-responsive.ts`). Per section and per screen size: hidden, spacing, text alignment, columns, content
width and picture alignment. Stored as `style.responsive` on page sections and `responsive` on homepage sections. The renderer
prints them as media queries for elements marked `data-rs`, so the store and the editor's preview iframe behave the same.

**Header and footer** (`header` and `footer` in `backend/lib/storefront-config.ts`). Logo display and size, links' position, sticky, an
announcement colour, footer columns and what to show. Layouts offered instead of the theme's are limited to `HEADER_LAYOUTS` and
`FOOTER_LAYOUTS`, which use only the skin's own tokens. Links' position applies to single-row headers (`glass`, `console`, `minimal`,
`textual`). A footer column's internal link is checked with `resolveInternalHref` and left out if it leads nowhere.

**Design** (`backend/lib/design-settings.ts`). Heading and text weight, heading size, page background and text colour, button style, corners,
section spacing, content width and link style join the fonts and colours. Each is a class on the store root (`designClasses`, styled
in `app/globals.css`), and "theme" adds none. Read and copy the choices only through `pickStoreDesign`. `sf-container` marks each skin's
container so a width can apply without knowing its size.

**Menus.** A link can be limited to larger screens or the phone menu (`showOn`), dragged within a level, into or out of a dropdown,
and copied to the other menu. A dropdown can be a heading with no address. Public menus still resolve only through `resolveNavItems`.

**Page SEO.** `canonicalUrl` follows the draft and published split of the other search fields. Published pages with nothing set fall back
to text and a picture from their PUBLISHED sections (`backend/lib/page-seo-defaults.ts`), and publish `WebPage` structured data. `FAQPage` is added
only for questions with both a question and an answer, in a section a visitor can see, with no placeholder left. A section hidden on every
screen size counts as hidden.

**Newer edits.** Homepage, design and menu drafts carry a version (`Business.storefrontDraftVersion`, `designDraftVersion`,
`navigationDraftVersion`, `backend/lib/draft-version.ts`). A save that sends `x-expected-version` is refused with `409 draft_conflict` if another save
came first, and the editor stops saving until it is reloaded. Saves that send no version, such as AI proposals and restoring a version, are
not checked but do move the version on. Menus are written only through `saveNavigationDraft` (`backend/lib/navigation-draft.ts`), which also freezes
what visitors see on the first draft; generating default pages is the one other writer, and it moves the version on too. Pages keep using
`Page.version`. A store or page with no version yet counts as version 0.

**Older documents.** Nothing here migrates data. Absent optional fields are filled in where they are read: `readStorefrontConfig`,
`readStoreDesign`, `pickStoreDesign` and the defaults in the Zod schemas. `PATCH /api/businesses/[id]` writes each named setting by itself, so
it cannot replace settings the request does not name. A page published before live copies existed has no `publishedSections`, and visitors see
its saved fields until its first draft edit stores them as the live copy (`liveCopyToKeep`): read such a page lean, because the model fills
in an empty list. A stored homepage draft that no longer parses is never published in the starting layout's place, and it goes to the
history before a save replaces it (`storedConfigIsReadable`).

**Readability advice.** The Design screen warns about a page background and text colour that are hard to read (`textReadability`). It never
stops a save or a publish and never changes a colour.

**Publishing checks.** `/publish`, `/storefront/publish` and `/website/publish` all need a verified email, `PUBLISH_ROLES`, no maintenance, a
store that is not suspended and an active plan. Publishing one page through `PATCH /pages/[pageId]` needs the same, except that a plan is only
checked when the store is already live: a store that is not live shows nothing, and the plan is checked when it goes live. Any of these
stops on a placeholder in a visible section, including a homepage still kept in `themeSettings.sections`.
