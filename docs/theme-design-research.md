# Storefront themes: design research and direction

Status: research and audit for the nine-theme collection (2026-10-31). The
implementation notes are in `docs/storefront-commerce.md` ("Theme collection").

## 1. Sources (inspiration only, nothing copied)

- Shopify Theme Store (feature lists of well-rated themes: Prestige, Impulse,
  Focal, Stiletto, Local) and Shopify's theme requirements
  (https://shopify.dev/docs/storefronts/themes/store/requirements).
- Awwwards e-commerce honourees (full-bleed media, scroll storytelling).
- Tailwind Plus e-commerce blocks: only the public category list was reachable
  (product overviews, product lists, order history, incentives); block content
  needs a login and was not used.
- Motion for React docs (bundle sizes, LazyMotion, reduced motion,
  `"use client"`); GSAP docs, pricing and standard licence.

## 2. Audit of the existing five themes

Architecture (kept): one renderer for every theme. `themes/*Theme.tsx` wrap
`CommerceShell` with a skin; `CommerceShell` → `StoreHeader`, `CommerceHome`
(hero + owner-ordered sections), `StoreFooter`; inner pages use `StoreFrame`
with the same header/footer; the editor renders the same tree in
`PreviewFrame`.

Weaknesses found:

1. **Five colourways of one layout.** Every theme had the same header, grid,
   card, category tiles, promotions and footer; only class strings and one hero
   variant differed. Grid density, image proportions and typography were
   identical.
2. **Typography**: one system sans for every store (Bistro alone used the
   generic `font-serif`); no display/body pairing.
3. **Product detail**: gallery thumbnails were not interactive (only the first
   image could be seen large); no accordions; no option/variant comparison.
4. **Catalog**: search, category chips and sort only; no availability filter,
   no category counts, no filter layout for large catalogs.
5. **Motion**: hover zoom only; no entrance, reveal, drawer or add-to-cart
   feedback; nothing honoured `prefers-reduced-motion` explicitly.
6. **Product cards** could not show a second image even when the product has
   one.
7. Theme picker showed three colour dots per theme: no idea of the layout.

Strengths to keep: real data only (no fabricated reviews, stock or discounts),
accessible drawer and menus, one h1, skip link, CLS 0 on every measured page,
light inner pages for dark themes.

## 3. Recurring premium patterns (what we adopt)

- Sticky, compact header; prominent search for large catalogs; category bar.
- Hero: full-bleed image or a strong typographic statement; one LCP image,
  eager; everything below lazy.
- Product cards: fixed-ratio media (no layout shift), second image on hover,
  badges only from real data, quick add.
- Product page: gallery with selectable images, sticky details on desktop,
  accordions for details and shipping, related products.
- Catalog: facet sidebar on desktop, a disclosure on mobile, result count,
  sort, availability.
- Footer: columns; editorial themes end with a large wordmark.
- Rejected (would need fabricated or unavailable data): countdown timers,
  stock counters, "press" strips, testimonials without real reviews, "buy
  again" (needs per-customer order queries in the storefront frame).

## 4. Direction per theme

| Theme | For | Layout signature | Type | Motion language |
|---|---|---|---|---|
| Aurora | premium modern lifestyle | immersive full-height hero, bento category mosaic, large 4:5 cards with lift | system sans, tight display | soft, slow fades, image settle |
| Bistro | restaurant, café, food | centered header, arched hero image, menu-style product list with dotted price leaders, menu category tabs | old-style serif display | gentle |
| Launch | bold DTC brand | giant statement headline with offset colour block, marquee of real categories/benefits, block categories, brutal offset-shadow cards | heavy system sans, uppercase | crisp, quick |
| Market | retail / marketplace | search-first header + category bar, panel hero with category tiles, dense 5-column grid, catalog sidebar | system sans | minimal |
| Studio | creative / editorial | minimal header, asymmetric editorial hero, typographic category index, borderless portrait cards, stacked gallery | grotesk, light display | calm |
| Atelier (new) | luxury fashion, jewellery | centered header, full-bleed campaign hero, tall portrait cards with image rollover, campaign category tiles, stacked editorial gallery, wordmark footer | Didone serif display + small caps | slow, refined |
| Volt (new) | electronics, gadgets | dark search-first header, spotlight hero on a grid backdrop, spec chips on cards, specification and option-comparison tables | system sans + mono for specs | crisp |
| Harvest (new) | grocery, organic, essentials | search-first header, mobile dock (shop, search, cart), banner hero, round category bubbles, compact fresh cards with quick add | rounded sans | lively but short |
| Forma (new) | furniture, home decor | spacious header, room hero with overlapping caption card, alternating "room" collection stories, spacious 3-column gallery cards | old-style serif light display | calm |

Colour: the owner's primary/accent colours drive buttons and accents in every
theme (with automatic readable text); each theme adds its own neutrals
(midnight, cream paper, white/black, grey, ivory, graphite, fresh white, warm
stone).

## 5. Animation decision

- **No animation library.** Motion's full `motion` component is ~43 kB and
  `LazyMotion` + `m` ~5 kB + 24 kB of features
  (motion.dev/docs/react-reduce-bundle-size), and both require client
  components, which would turn today's server-rendered homepage sections into
  hydrated islands. GSAP's standard licence prohibits use in no-code visual
  animation builders that compete with Webflow (gsap.com/community/standard-license),
  a real risk for a website builder.
- Instead: CSS keyframes/transitions (transform and opacity only) inside
  `prefers-reduced-motion: no-preference`, plus one ~1 kB client island
  (`MotionRoot`) that reveals sections below the fold with
  `IntersectionObserver`. Content above the fold is never hidden, content is
  visible without JavaScript, and nothing is hidden on the server (no
  hydration mismatch). The island uses the element's own document (editor
  frame) and disconnects on unmount.

## 6. Accessibility and performance requirements

- Contrast 4.5:1 for text (button text picked automatically from the brand
  colour); visible focus rings; 24px+ targets; skip link; one h1.
- Drawer: `role="dialog"`, focus moves in, is trapped, Escape closes and
  returns focus (existing behaviour kept).
- Fixed aspect ratios for all media (CLS stays 0); only the hero image eager.
- Reduced motion: every animation is off; the marquee becomes static.
- Bundle: storefront first-load JS must not grow beyond a few kB.
