# SiteForge design system: "The Forge"

The look and feel of the SiteForge platform: marketing site, authentication,
dashboard, website builder and Super Admin. **Storefront themes are not part of
it:** each theme keeps its own design (`themes/skins/<id>.ts`).

## Direction

Precise, calm and confident, like a well-made tool. Near-black ink carries the
interface; clean neutral surfaces stay out of the way of the owner's content; one
molten **ember** accent marks what is alive: focus, the current place, AI and the
brand. Ember is a highlight, never a wash: if a screen has a lot of orange, it is
wrong.

## Tokens

`slate` and `brand` are CSS variables (`app/globals.css`, `tailwind.config.ts`).
A page holding `.app-surface` switches the whole document to the platform values;
`.store-surface` (in `ThemeRenderer`) restores the storefront values, so a theme
rendered inside a platform page is untouched. Preview iframes are separate
documents and keep the storefront values.

| Token | Use |
| --- | --- |
| `slate-50` | page canvas |
| `white` | cards and panels |
| `slate-200` / `slate-300` | borders / input borders |
| `slate-500` / `slate-600` / `slate-900` | quiet text / body text / headings |
| `brand-600` (ink), `brand-700` (hover) | primary actions |
| `slate-900` | active navigation, selected segment |
| `brand-500`, `ember` | focus rings and highlights |
| `brand-50`, `brand-100` | soft ember tint (use `text-[#b23a12]` on it) |
| `ember-soft` | ember on dark backgrounds |
| `ink`, `ink-deep` | dark panels (always dark, on any surface) |

`text-brand-*` is ink. It gains an underline on hover by itself. Red, amber,
emerald and sky are only for meaning: danger, warning, success, information.
Primary buttons are ink, not ember, so they can never be mistaken for a warning
or an error.

## Type

- `font-heading` (Bricolage Grotesque): `h1` to `h4` get it automatically.
- `font-ui` (Instrument Sans): everything else, automatically inside `.app-surface`.
- `font-display` and `font-body` belong to storefront themes: never use them here.
- Page title `text-2xl sm:text-[1.75rem] font-semibold tracking-tight`; section
  title `text-lg font-semibold`; card title `text-sm font-semibold`. Prefer
  `font-semibold` to `font-bold` for headings; display type carries the weight.
- Quiet labels: `text-xs font-medium text-slate-500`. Reserve uppercase for the
  small tracked labels (`Eyebrow`, table headers).

## Components

Import from `components/ui/`. They work in server and client components, unless
noted.

- `Button.tsx`: `Button`, `ButtonLink`, `buttonClass({ variant, size, block, className })`,
  `focusRing`. Variants `primary`, `ember` (one top-level call to action only),
  `secondary`, `ghost`, `danger`, and `invert` / `outline-light` on dark panels.
- `Surface.tsx`: `Card`, `cardClass`, `Pill` (`tone`, `dot`), `Notice` (`tone`,
  `title`, `action`, `role`), `StatTile`, `EmptyState`, `Skeleton`, `Eyebrow`.
- `Field.tsx` (client only: it uses `useId`): `Field`, `inputClass`, `labelClass`.
- `Icon.tsx`: `Icon name=…`, `SectionIcon segment=…`. Use it rather than pasting SVG.
- `ConfirmDialog.tsx` (client): `await confirmDialog({ title, message, confirmLabel, tone })`.
  Replaces `window.confirm`. Mounted by `<ConfirmHost />` in the dashboard and admin layouts.
- `Toast.tsx`: `useToastHelpers()`.
- `Logo.tsx`: `Logo`, `LogoMark`.
- `dashboard/editor/SectionControls.tsx`: section rows (drag, move, show/hide, remove),
  panel actions and the add-section list, shared by both website editors.
- `dashboard/ManagementPageHeader.tsx`: the page header of every management screen.

Inputs need only `rounded-lg border px-3 py-2`, or `inputClass`: background, border
colour, hover and the focus ring come from the base styles.

## Layout and patterns

- Radius: cards `rounded-2xl`, controls `rounded-lg`, pills `rounded-full`.
- Depth comes from a hairline border plus `shadow-sm`. `shadow-lg` is for things that
  float (dialogs, toasts), nothing else.
- Page rhythm: `space-y-6` between sections, `p-5` / `sm:p-6` in cards. One clear
  primary action per screen.
- Tables: a `rounded-2xl` card with `overflow-x-auto`; header `bg-slate-50 text-xs
  font-medium text-slate-500`; rows divided by `divide-y divide-slate-100`, `hover:bg-slate-50`.
  Below `sm`, prefer stacked cards to a sideways scroll when a list is an everyday task.
- Actions: while working, the button is disabled and says so ("Saving…"); a result is
  announced (`Notice` with `role="status"` or `role="alert"`, or a toast); a network
  failure says that nothing changed. Destructive actions go through `confirmDialog`.
- Empty states say what the thing is for and offer the one action that starts it.
  Loading states use `Skeleton` in the shape of the content. Errors say what happened,
  whether anything was lost, and what to do next.
- Segmented controls: `rounded-lg border bg-slate-100 p-0.5`, selected segment
  `bg-white shadow-sm text-slate-900`.

## Motion

CSS only, transform and opacity only, no libraries, and off for reduced motion:
`ui-page` (route change), `ui-pop` (dialog), `ui-fade` (backdrop), `ui-toast`,
`ui-rise` (marketing, with `--ui-i` as the stagger), `ui-lift` (hoverable card).
Motion confirms something happened. It never decorates and never delays work.

## Voice

Owners are not technical. Say what will happen in plain words ("Visitors will see
this right away"), name things by what they do, and always make clear whether a
change is a draft or live. Never mention internal terms such as tenant, schema or
slug in main copy when there is a plainer word.

## Honesty rules

- UI connects to real functionality: no fake buttons, numbers, testimonials, customer
  logos or statistics. Measured values only, or a plainly labelled sample.
- Marketing states what is actually available. Features gated behind an activation
  (AI, online payments, custom domain routing) are labelled as such.
- Locked features show what plan includes them; the server still enforces every limit.

## Accessibility

Visible focus on everything (`focusRing`), labels on every control, text contrast at
least AA (`slate-500` is the lightest colour for text on white; `slate-400` is for
icons and decoration only), targets at least 40px on touch screens, dialogs trap focus
and restore it, and status changes are announced with `role="status"` or `role="alert"`.
