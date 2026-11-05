import Link from "next/link";
import { THEMES } from "@/lib/themes";
import { getSession } from "@/lib/auth/session";
import { isAiProviderEnabled } from "@/lib/env";
import SiteHeader from "@/components/marketing/SiteHeader";
import SiteFooter, { footerLinkClass } from "@/components/marketing/SiteFooter";
import StorefrontPreview from "@/components/marketing/StorefrontPreview";
import PlanCards from "@/components/marketing/PlanCards";
import { loadPublicPlans, themePlanNames } from "@/components/marketing/plans";
import ThemePreviewImage from "@/components/marketing/ThemePreviewImage";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Eyebrow } from "@/components/ui/Surface";

export const dynamic = "force-dynamic";

const STEPS = [
  {
    title: "Tell us about your business",
    description: "Your name, what you sell and how people reach you. Guided setup saves your progress, so you can stop and come back.",
  },
  {
    title: "Pick a design and make it yours",
    description: "Choose one of nine complete themes, then change anything by clicking on it. Your starting homepage and pages are prepared for your type of business.",
  },
  {
    title: "Publish when you are ready",
    description: "Everything stays a private draft until you press Publish. After that, your store lives on its own web address.",
  },
] as const;

const SELL = [
  { icon: "products", title: "Products and variants", description: "Sizes, colours, images, sale prices and categories, each variant with its own stock." },
  { icon: "inventory", title: "Inventory you can trust", description: "Stock is reserved at checkout, and every change is recorded in a history you can read." },
  { icon: "orders", title: "Orders and tracking", description: "One queue for new, paid and delivered orders, with a status page for your customers." },
  { icon: "billing", title: "Cash on delivery and Razorpay", description: "Offer cash on delivery, or take online payments through your own Razorpay account." },
  { icon: "coupons", title: "Coupons", description: "Discount codes with limits and dates. Totals are always worked out on the server." },
  { icon: "reviews", title: "Real reviews only", description: "Reviews come from paid orders, and you approve each one before it appears." },
  { icon: "customers", title: "Customer accounts", description: "Shoppers can sign in to your store to see their orders. Their account belongs to your store." },
  { icon: "insights", title: "Insights", description: "Sales, best sellers and stock alerts, measured from your own orders with no estimates." },
  { icon: "globe", title: "Found on search engines", description: "Page titles, descriptions and a sitemap are handled for you, and you can fine-tune them." },
] as const;

const FAQ = [
  {
    q: "Do I need to know how to code or design?",
    a: "No. You choose a theme and change things by clicking on them. Guided setup takes you through each step, from your business details to publishing.",
  },
  {
    q: "Will I lose my work if I change themes?",
    a: "No. Every theme uses the same products, pages and settings, so you can preview any theme with your own store and switch without losing anything.",
  },
  {
    q: "Can my customers see my changes while I work?",
    a: "No. Edits are saved as drafts, and visitors see them only after you publish. You can preview a draft on desktop, tablet and phone sizes first.",
  },
  {
    q: "What does the AI assistant do with my data?",
    a: "It sees only your store's content: things like your business description, page text and product details. Customer information, orders, payment details and contact details are never sent. The store owner must turn it on, and nothing changes until you approve it.",
  },
  {
    q: "Can I start for free?",
    a: "Compare the plans on the pricing page. Limits such as products, team members and themes depend on your plan, and you can change plan as your business grows.",
  },
] as const;

export default async function HomePage() {
  const [plans, session] = await Promise.all([loadPublicPlans(), getSession()]);
  const authed = Boolean(session);
  const planNames = themePlanNames(plans);
  const aiLive = isAiProviderEnabled();

  return (
    <div className="app-surface bg-white text-slate-900">
      <SiteHeader authed={authed} />

      <main>
        {/* HERO */}
        <section className="relative isolate overflow-hidden bg-ink text-white">
          <div aria-hidden="true" className="ui-dots absolute inset-0 -z-10" />
          <div aria-hidden="true" className="ui-ember-glow absolute inset-0 -z-10" />
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 pb-20 pt-16 sm:px-6 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:pb-28">
            <div>
              <p className="ui-rise inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/80">
                <span className="h-1.5 w-1.5 rounded-full bg-ember" aria-hidden="true" />
                The online store builder for every kind of business
              </p>
              <h1 style={{ "--ui-i": 1 } as React.CSSProperties} className="ui-rise mt-6 text-[2.75rem] font-semibold leading-[1.02] tracking-tight [text-wrap:balance] sm:text-6xl xl:text-7xl">
                A store that looks custom-built. <span className="ui-ember-text">Without building it.</span>
              </h1>
              <p style={{ "--ui-i": 2 } as React.CSSProperties} className="ui-rise mt-6 max-w-xl text-lg leading-8 text-white/70">
                SiteForge gives your business a complete online store: professional designs, a visual editor, products, orders and payments, all in one place and with no code anywhere.
              </p>
              <div style={{ "--ui-i": 3 } as React.CSSProperties} className="ui-rise mt-9 flex flex-col gap-3 sm:flex-row">
                <Link href={authed ? "/dashboard" : "/register"} className={buttonClass({ variant: "ember", size: "lg" })}>
                  {authed ? "Go to your dashboard" : "Start building"} <Icon name="arrow-right" size={18} />
                </Link>
                <Link href="/themes" className={buttonClass({ variant: "outline-light", size: "lg" })}>
                  See the {THEMES.length} themes
                </Link>
              </div>
              <ul style={{ "--ui-i": 4 } as React.CSSProperties} className="ui-rise mt-9 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/60">
                {["No code", "Draft until you publish", "Switch themes any time"].map((item) => (
                  <li key={item} className="flex items-center gap-1.5">
                    <Icon name="check" size={15} className="text-ember-soft" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div style={{ "--ui-i": 3 } as React.CSSProperties} className="ui-rise">
              <div className="hidden md:block">
                <StorefrontPreview themeId="atelier" />
                <p className="mt-3 text-center text-xs text-white/50">The Atelier theme, shown with a fictional sample store.</p>
              </div>
              <ul className="grid grid-cols-2 gap-3 md:hidden" aria-label="Examples of themes">
                {(["bistro", "volt", "market", "atelier"] as const).map((id) => (
                  <li key={id}>
                    <span className="block overflow-hidden rounded-xl ring-1 ring-white/10">
                      <ThemePreviewImage themeId={id} className="aspect-[16/10]" />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* STEPS */}
        <section id="how-it-works" className="scroll-mt-20 bg-white py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="max-w-2xl">
              <Eyebrow>How it works</Eyebrow>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">From first idea to open for business</h2>
            </div>
            <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="bg-white p-6 sm:p-8">
                  <span aria-hidden="true" className="font-heading text-5xl font-semibold text-ember">
                    {index + 1}
                  </span>
                  <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{step.description}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* BUILD */}
        <section id="build" className="scroll-mt-20 bg-slate-50 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="max-w-2xl">
              <Eyebrow>Website builder</Eyebrow>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">Click on it. Change it. See it.</h2>
              <p className="mt-4 text-lg leading-8 text-slate-600">A real visual editor that shows your actual store as you work, with no separate preview to second-guess.</p>
            </div>
            <div className="mt-12 grid gap-4 lg:grid-cols-6">
              {/* Illustration of the editor, with a real picture of the theme and a sample store. */}
              <div className="overflow-hidden rounded-2xl bg-ink p-6 text-white sm:p-8 lg:col-span-4">
                <h3 className="text-xl font-semibold">Edit the page itself</h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-white/70">Select any section, change its text, images and colours in the side panel, and move it up or down the page. Undo anything.</p>
                <div aria-hidden="true" className="mt-6 grid gap-3 rounded-xl border border-white/10 bg-white/5 p-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
                  <div className="overflow-hidden rounded-lg bg-white">
                    <ThemePreviewImage themeId="bistro" className="aspect-[4/3] sm:aspect-auto sm:h-[26rem]" />
                  </div>
                  <div className="hidden space-y-2.5 rounded-lg bg-white p-3 text-xs text-slate-700 sm:block">
                    <p className="text-sm font-semibold text-slate-900">Hero banner</p>
                    <div>
                      <p className="mb-1 font-medium text-slate-500">Heading</p>
                      <p className="rounded border border-slate-200 px-2 py-1.5 text-slate-900">Baked fresh every morning</p>
                    </div>
                    <div>
                      <p className="mb-1 font-medium text-slate-500">Text</p>
                      <p className="rounded border border-slate-200 px-2 py-1.5 leading-4 text-slate-900">Slow-proved bread, warm pastries and coffee roasted a few streets away.</p>
                    </div>
                    <div>
                      <p className="mb-1 font-medium text-slate-500">Image</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/samples/hero-bistro.webp" alt="" loading="lazy" decoding="async" className="h-14 w-full rounded object-cover" />
                    </div>
                    <div>
                      <p className="mb-1 font-medium text-slate-500">Colours</p>
                      <div className="flex gap-1.5">
                        {["#9a4a26", "#3b2417", "#f8f1e6"].map((color) => (
                          <span key={color} className="h-5 w-5 rounded-full ring-1 ring-black/10" style={{ background: color }} />
                        ))}
                      </div>
                    </div>
                    <p className="rounded bg-ink py-1.5 text-center font-semibold text-white">Save draft</p>
                  </div>
                </div>
              </div>
              <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 lg:col-span-2">
                <span className="flex gap-2 text-slate-900" aria-hidden="true">
                  <Icon name="monitor" size={24} />
                  <Icon name="tablet" size={24} />
                  <Icon name="phone" size={24} className="text-ember" />
                </span>
                <h3 className="mt-5 text-xl font-semibold">Right on every screen</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Switch between desktop, tablet and phone while you edit. Each preview uses that device&apos;s real width, so what you see is what your customers get.</p>
                <div aria-hidden="true" className="relative mt-auto pr-10 pt-8">
                  <div className="overflow-hidden rounded-lg border border-slate-200 shadow-sm">
                    <ThemePreviewImage themeId="market" className="aspect-square" />
                  </div>
                  <div className="absolute bottom-0 right-0 w-24 overflow-hidden rounded-2xl border-4 border-ink bg-white shadow-lg">
                    <ThemePreviewImage themeId="market" device="mobile" className="aspect-[9/19]" />
                  </div>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 lg:col-span-2">
                <Icon name="pages" size={24} className="text-slate-900" />
                <h3 className="mt-5 text-xl font-semibold">Pages made for your business</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Start with draft pages suited to what you do, using your own details. Anything we don&apos;t know is left as a clear placeholder for you to fill in.</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 lg:col-span-2">
                <Icon name="eye" size={24} className="text-slate-900" />
                <h3 className="mt-5 text-xl font-semibold">Safe by default</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Edits stay in a draft. Your live store only changes when you press Publish, and never by surprise.</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 lg:col-span-2">
                <Icon name="navigation" size={24} className="text-slate-900" />
                <h3 className="mt-5 text-xl font-semibold">Menus without the fuss</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Choose which pages appear in your header and footer, put them in order, and your whole site stays in step.</p>
              </div>
            </div>
          </div>
        </section>

        {/* AI */}
        <section id="ai" className="relative isolate scroll-mt-20 overflow-hidden bg-ink py-20 text-white sm:py-24">
          <div aria-hidden="true" className="ui-dots absolute inset-0 -z-10" />
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
            <div>
              <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ember-soft">
                <Icon name="ai-builder" size={16} /> AI Builder
                {!aiLive && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-white/80">Rolling out soon</span>}
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">Describe what you want. Stay in charge of what changes.</h2>
              <p className="mt-4 text-lg leading-8 text-white/70">Ask in your own words for a new page, a sharper homepage, better product text or a design suggestion. Powered by Google Gemini.</p>
              <ul className="mt-8 space-y-3 text-sm text-white/80">
                {[
                  "You see exactly what would change, before anything does.",
                  "Approved changes go to a draft. Publishing stays your decision.",
                  "It won't invent facts: anything it doesn't know is left for you to fill in.",
                  "Customer, order and payment information is never sent.",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2.5">
                    <Icon name="check" size={17} className="mt-0.5 text-ember-soft" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            {/* An illustration of the review flow, not a live result. */}
            <figure className="rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-4">
              <div aria-hidden="true" className="space-y-3">
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-white px-4 py-3 text-sm text-slate-900">Add an About page about our family bakery</div>
                <div className="rounded-2xl rounded-bl-md border border-white/10 bg-ink-soft p-4 text-sm">
                  <p className="flex items-center gap-2 text-xs font-medium text-ember-soft">
                    <Icon name="ai-builder" size={14} /> New page · waiting for your approval
                  </p>
                  <p className="mt-3 font-heading text-lg font-semibold">About us</p>
                  <p className="mt-1 leading-6 text-white/70">A family bakery serving fresh bread and pastries every morning.</p>
                  <p className="mt-2 rounded-lg bg-brand-500/15 px-2.5 py-1.5 text-xs text-ember-soft">[[Add the year you opened]]</p>
                  <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
                    <span className="rounded-lg bg-white px-3 py-2 text-ink">Apply to draft</span>
                    <span className="rounded-lg border border-white/20 px-3 py-2">Edit request</span>
                    <span className="rounded-lg border border-white/20 px-3 py-2">Reject</span>
                  </div>
                </div>
              </div>
              <figcaption className="mt-3 px-1 text-xs text-white/50">An illustration of how a suggestion is reviewed.</figcaption>
            </figure>
          </div>
        </section>

        {/* THEMES */}
        <section id="themes" className="scroll-mt-20 bg-white py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-2xl">
                <Eyebrow>Themes</Eyebrow>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">{THEMES.length} designs. Not {THEMES.length} colour swaps.</h2>
                <p className="mt-4 text-lg leading-8 text-slate-600">Each theme has its own layouts, type and motion. Your products and pages move with you whenever you switch.</p>
              </div>
              <Link href="/themes" className={buttonClass({ variant: "secondary" })}>
                Preview all themes <Icon name="arrow-right" size={16} />
              </Link>
            </div>
            <ul className="mt-12 grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-3">
              {THEMES.map((theme) => (
                <li key={theme.id}>
                  <Link href={`/themes#${theme.id}`} className="ui-lift group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-4">
                    <span className="block overflow-hidden rounded-xl border border-slate-200 shadow-sm">
                      <ThemePreviewImage themeId={theme.id} />
                    </span>
                    <span className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-heading text-base font-semibold text-slate-900 group-hover:underline group-hover:underline-offset-4">{theme.name}</span>
                      {planNames[theme.id] && <span className="text-xs text-slate-500">{planNames[theme.id]?.free ? "Free plan" : `${planNames[theme.id]?.name} plan`}</span>}
                    </span>
                    <span className="mt-0.5 block text-sm text-slate-600">{theme.tagline}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* SELL */}
        <section id="sell" className="scroll-mt-20 border-t border-slate-200 bg-slate-50 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="max-w-2xl">
              <Eyebrow>Selling online</Eyebrow>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">A store that works, not just one that looks good</h2>
            </div>
            <ul className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {SELL.map((item) => (
                <li key={item.title}>
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-900 shadow-sm">
                    <Icon name={item.icon} size={19} />
                  </span>
                  <h3 className="mt-4 text-base font-semibold">{item.title}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-slate-600">{item.description}</p>
                </li>
              ))}
            </ul>
            <p className="mt-10 text-xs text-slate-500">Online payments and customer accounts are switched on platform by platform as they roll out. Availability is shown in your dashboard.</p>
          </div>
        </section>

        {/* PRICING */}
        <section id="pricing" className="scroll-mt-20 bg-white py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-2xl">
                <Eyebrow>Pricing</Eyebrow>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">Start small. Grow when you&apos;re ready.</h2>
              </div>
              <Link href="/pricing" className={buttonClass({ variant: "secondary" })}>
                Compare plans in detail <Icon name="arrow-right" size={16} />
              </Link>
            </div>
            <div className="mt-12">
              <PlanCards plans={plans} authed={authed} />
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-20 border-t border-slate-200 bg-slate-50 py-20 sm:py-24">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_2fr]">
            <div>
              <Eyebrow>Questions</Eyebrow>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Good to know</h2>
            </div>
            <div className="divide-y divide-slate-200 border-y border-slate-200">
              {FAQ.map((item) => (
                <details key={item.q} className="group py-1">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg py-4 font-heading text-base font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <Icon name="plus" size={18} className="text-slate-400 transition-transform group-open:rotate-45" />
                  </summary>
                  <p className="max-w-2xl pb-5 text-sm leading-6 text-slate-600">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="relative isolate overflow-hidden bg-ink py-24 text-center text-white">
          <div aria-hidden="true" className="ui-ember-glow absolute inset-0 -z-10" />
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <h2 className="text-4xl font-semibold tracking-tight [text-wrap:balance] sm:text-6xl">Your business deserves a better website.</h2>
            <p className="mx-auto mt-5 max-w-xl text-lg text-white/70">Set up your store today, and keep it private until it&apos;s exactly right.</p>
            <Link href={authed ? "/dashboard" : "/register"} className={buttonClass({ variant: "ember", size: "lg", className: "mt-9" })}>
              {authed ? "Go to your dashboard" : "Start building"} <Icon name="arrow-right" size={18} />
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter>
        <Link href="/terms" className={footerLinkClass}>
          Terms of Service
        </Link>
        <Link href="/privacy" className={footerLinkClass}>
          Privacy Policy
        </Link>
      </SiteFooter>
    </div>
  );
}
