import Link from "next/link";
import { headers } from "next/headers";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getEntitlements } from "@/lib/billing";
import { storeLinkRoot } from "@/lib/host";
import { getThemeMeta } from "@/lib/themes";
import { formatPrice } from "@/lib/format";
import { getBusinessInsights, parseDateRange } from "@/lib/business-insights";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { ProductReview } from "@/models/ProductReview";
import { WebsiteProposal } from "@/models/WebsiteProposal";
import { BUSINESS_CATEGORIES } from "@/lib/constants";
import { loadSetupFacts } from "@/lib/store-setup-data";
import { SETUP_STEPS, SETUP_STEP_INFO, resumeStep, stepStates, storeReadiness } from "@/lib/store-setup";
import PublishToggle from "@/components/dashboard/PublishToggle";
import ThemeThumbnail from "@/components/dashboard/ThemeThumbnail";
import { Icon, SectionIcon } from "@/components/ui/Icon";
import { Card, Notice, Pill, StatTile, cardClass } from "@/components/ui/Surface";
import { buttonClass, focusRing } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

function QuickLink({ href, label, detail, segment, external = false }: { href: string; label: string; detail: string; segment: string; external?: boolean }) {
  return (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={`group flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 transition-colors hover:border-slate-300 hover:bg-slate-50 ${focusRing}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
        {external ? <Icon name="external" size={17} /> : <SectionIcon segment={segment} size={17} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-900">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-slate-500">{detail}</span>
      </span>
      <Icon name="chevron-right" size={16} className="text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500" />
    </Link>
  );
}

export default async function BusinessOverview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  await dbConnect();

  const [business, entitlements] = await Promise.all([
    Business.findById(id).lean(),
    getEntitlements(id),
  ]);
  const [productCount, memberCount, pageCount] = await Promise.all([
    Product.countDocuments({ business: id, status: { $ne: "archived" } }),
    Membership.countDocuments({ business: id }),
    Page.countDocuments({ business: id }),
  ]);

  const rootDomain = storeLinkRoot((await headers()).get("host"));
  const storefrontUrl = business?.subdomain
    ? `http://${business.subdomain}.${rootDomain}`
    : null;
  const theme = business ? getThemeMeta(business.themeId) : null;
  const isPublished = business?.status === "published";
  const base = `/dashboard/businesses/${id}`;
  // Guided setup progress, from the store's real data (lib/store-setup.ts).
  const setup = await loadSetupFacts(id, user);
  const setupStates = setup ? stepStates(setup.facts, setup.progress) : null;
  const setupDone = setupStates ? SETUP_STEPS.filter((s) => setupStates[s] === "complete").length : SETUP_STEPS.length;
  const setupNext = setup ? resumeStep(setup.facts, setup.progress) : null;
  const setupReadiness = setup ? storeReadiness(setup.facts) : null;
  const remainingSetup = setupStates ? SETUP_STEPS.filter((s) => setupStates[s] !== "complete") : [];
  const canManageWebsite =
    membership.role === "owner" || membership.role === "manager";

  // Measured from this store's own records. Sales and customers are for the
  // same audience as the Orders page: staff never get these numbers.
  const [insights, pendingProposals, pendingReviews] = canManageWebsite
    ? await Promise.all([
        getBusinessInsights(id, parseDateRange()),
        WebsiteProposal.countDocuments({ business: id, status: "pending" }),
        ProductReview.countDocuments({ business: id, status: "pending" }),
      ])
    : [null, 0, 0];
  const sales = insights?.sales.find((row) => row.currency === insights.primaryCurrency) ?? insights?.sales[0] ?? null;

  const quickActions = [
    ...(canManageWebsite ? [{ href: `${base}/ai-builder`, label: "AI Builder", detail: "Describe a change in your own words", segment: "ai-builder" }] : []),
    { href: `${base}/products`, label: "Products", detail: `${productCount} in your catalog`, segment: "products" },
    ...(canManageWebsite ? [{ href: `${base}/orders`, label: "Orders", detail: "See and manage what customers bought", segment: "orders" }] : []),
    { href: `${base}/pages`, label: "Pages", detail: `${pageCount} on your website`, segment: "pages" },
    ...(canManageWebsite ? [{ href: `${base}/insights`, label: "Insights", detail: "Sales, best sellers and stock alerts", segment: "insights" }] : []),
    ...(canManageWebsite ? [{ href: `${base}/settings`, label: "Business settings", detail: "Business details and team", segment: "settings" }] : []),
    ...(membership.role === "owner" ? [{ href: `${base}/billing`, label: "Subscription", detail: entitlements.active ? entitlements.planName : "No active subscription", segment: "billing" }] : []),
  ];

  // What needs attention now: only things that are true and can be acted on.
  const attention = [
    ...(insights && insights.orders.byStatus.pending > 0 ? [{ tone: "ember" as const, label: `${insights.orders.byStatus.pending} order${insights.orders.byStatus.pending === 1 ? "" : "s"} waiting`, detail: "Placed in the last 30 days and not paid yet", href: `${base}/orders` }] : []),
    ...(pendingProposals > 0 ? [{ tone: "ember" as const, label: `${pendingProposals} website suggestion${pendingProposals === 1 ? "" : "s"} to review`, detail: "Nothing changes until you approve", href: `${base}/proposals` }] : []),
    ...(pendingReviews > 0 ? [{ tone: "neutral" as const, label: `${pendingReviews} review${pendingReviews === 1 ? "" : "s"} to approve`, detail: "Not shown on your store yet", href: `${base}/reviews` }] : []),
    ...(insights && insights.outOfStock.length > 0 ? [{ tone: "danger" as const, label: `${insights.outOfStock.length} product${insights.outOfStock.length === 1 ? " is" : "s are"} out of stock`, detail: "Customers can't buy these right now", href: `${base}/inventory` }] : []),
    ...(insights && insights.lowStock.length > 0 ? [{ tone: "warning" as const, label: `${insights.lowStock.length} product${insights.lowStock.length === 1 ? " is" : "s are"} running low`, detail: "Check your stock levels", href: `${base}/inventory` }] : []),
    ...(insights && insights.openDisputes > 0 ? [{ tone: "danger" as const, label: `${insights.openDisputes} open payment dispute${insights.openDisputes === 1 ? "" : "s"}`, detail: "Manage these in your Razorpay account", href: `${base}/insights` }] : []),
  ];
  const statusText = business?.status === "published" ? "Website published" : business?.status === "suspended" ? "Website suspended" : "Website is a draft";

  return (
    <div className="space-y-5">
      {/* The store at a glance */}
      <section className="relative isolate overflow-hidden rounded-2xl bg-ink text-white">
        <div aria-hidden="true" className="ui-dots absolute inset-0 -z-10" />
        <div className="grid items-end gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 self-center">
            <p className="text-sm text-white/60">{BUSINESS_CATEGORIES.find((category) => category.key === business?.category)?.name ?? business?.category}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{business?.name || "Your business"}</h1>
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/75">
              <span className="inline-flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${business?.status === "published" ? "bg-emerald-400" : business?.status === "suspended" ? "bg-red-400" : "bg-white/40"}`} aria-hidden="true" />
                {statusText}
              </span>
              {theme && <span className="text-white/50">Using {theme.name}</span>}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {canManageWebsite && (
                <Link href={`${base}/editor`} className={buttonClass({ variant: "invert" })}>
                  Edit website
                </Link>
              )}
              {isPublished && storefrontUrl && (
                <a href={storefrontUrl} target="_blank" rel="noreferrer" className={buttonClass({ variant: "outline-light" })}>
                  <Icon name="external" size={16} />
                  Preview website
                </a>
              )}
              {canManageWebsite && (
                <Link href={`${base}/theme`} className={buttonClass({ variant: "outline-light" })}>
                  Change theme
                </Link>
              )}
            </div>
          </div>
          {business && (
            <div aria-hidden="true" className="hidden translate-y-10 overflow-hidden rounded-t-xl border border-b-0 border-white/10 shadow-lg lg:block">
              <ThemeThumbnail themeId={business.themeId} className="!rounded-none" />
            </div>
          )}
        </div>
      </section>

      {canManageWebsite && setupStates && remainingSetup.length > 0 && (
        <Card as="section" className="p-5 sm:p-6" aria-labelledby="setup-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="setup-heading" className="text-lg font-semibold text-slate-900">
                Let&apos;s get your store ready
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {setupDone} of {SETUP_STEPS.length} setup steps done
                {setupReadiness && setupReadiness.remainingRequired > 0
                  ? ` · ${setupReadiness.remainingRequired} thing${setupReadiness.remainingRequired === 1 ? "" : "s"} needed before you can publish`
                  : ""}
                . Your progress is saved, so you can continue at any time.
              </p>
            </div>
            <Link href={`${base}/setup${setupNext ? `?step=${setupNext}` : ""}`} className={buttonClass()}>
              {setupDone === 0 ? "Start store setup" : "Continue setup"}
            </Link>
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Setup steps completed" aria-valuemin={0} aria-valuemax={SETUP_STEPS.length} aria-valuenow={setupDone}>
            <div className="h-full rounded-full bg-ember transition-[width] duration-500" style={{ width: `${(setupDone / SETUP_STEPS.length) * 100}%` }} />
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {SETUP_STEPS.map((step) => {
              const state = setupStates[step];
              return (
                <li key={step} className={`flex min-w-0 items-start gap-3 rounded-xl border p-3 ${state === "complete" ? "border-transparent bg-slate-50" : "border-slate-200 bg-white"}`}>
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                      state === "complete" ? "bg-emerald-600 text-white" : state === "skipped" ? "border-2 border-amber-400" : "border-2 border-slate-300"
                    }`}
                    aria-hidden="true"
                  >
                    {state === "complete" && <Icon name="check" size={12} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-semibold ${state === "complete" ? "text-slate-500" : "text-slate-900"}`}>
                      {SETUP_STEP_INFO[step].title}
                      <span className="sr-only">{state === "complete" ? " (done)" : state === "skipped" ? " (skipped for now)" : " (to do)"}</span>
                    </p>
                    {state !== "complete" && (
                      <>
                        <p className="mt-0.5 break-words text-xs leading-5 text-slate-500">{SETUP_STEP_INFO[step].description}</p>
                        <Link href={`${base}/setup?step=${step}`} className={`mt-1.5 inline-flex rounded text-xs font-semibold text-brand-700 ${focusRing}`}>
                          {state === "skipped" ? "Return to this step" : "Open this step"}
                        </Link>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Plan and limit warnings */}
      {!entitlements.active && (
        <Notice tone="warning" title="No active subscription">
          Choose a plan under{" "}
          <Link href={`${base}/billing`} className="font-semibold underline">
            Subscription
          </Link>{" "}
          to publish your storefront and add products.
        </Notice>
      )}
      {entitlements.active && productCount >= entitlements.productLimit && (
        <Notice tone="warning" title="Product limit reached">
          You&apos;ve used all {entitlements.productLimit} product{entitlements.productLimit === 1 ? "" : "s"} on your {entitlements.planName} plan.{" "}
          <Link href={`${base}/billing`} className="font-semibold underline">
            Upgrade
          </Link>{" "}
          to add more.
        </Notice>
      )}
      {entitlements.active && memberCount >= entitlements.staffLimit + 1 && (
        <Notice tone="warning" title="Team limit reached">
          You&apos;ve reached the maximum of {entitlements.staffLimit + 1} team member{entitlements.staffLimit === 0 ? "" : "s"} on your {entitlements.planName} plan.{" "}
          <Link href={`${base}/billing`} className="font-semibold underline">
            Upgrade
          </Link>{" "}
          to add more.
        </Notice>
      )}

      {/* Numbers */}
      <section aria-label="Your store in numbers" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {insights && (
          <>
            <StatTile label="Sales, last 30 days" value={sales ? formatPrice(sales.amount, sales.currency) : "None yet"} hint={insights.sales.length > 1 ? `Plus ${insights.sales.length - 1} other currenc${insights.sales.length === 2 ? "y" : "ies"}` : "From paid orders"} icon={<Icon name="insights" size={16} />} />
            <StatTile label="Orders, last 30 days" value={String(insights.orders.placed)} hint={`${insights.customers.inRange} customer${insights.customers.inRange === 1 ? "" : "s"}`} icon={<Icon name="orders" size={16} />} />
          </>
        )}
        <StatTile label="Products" value={String(productCount)} hint={`Plan limit: ${entitlements.productLimit}`} icon={<Icon name="products" size={16} />} />
        <StatTile label="Website pages" value={String(pageCount)} hint="Created in your site" icon={<Icon name="pages" size={16} />} />
        {!insights && (
          <>
            <StatTile label="Plan" value={entitlements.planName} hint={entitlements.active ? `Subscription ${entitlements.status}` : "No active subscription"} icon={<Icon name="billing" size={16} />} />
            <StatTile label="Team" value={String(memberCount)} hint={`of ${entitlements.staffLimit + 1} allowed`} icon={<Icon name="users" size={16} />} />
          </>
        )}
      </section>

      {/* min-w-0 on grid items lets truncated text shrink instead of widening the page. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] [&>*]:min-w-0">
        <div className="space-y-5">
          {canManageWebsite && (
            <Card as="section" className="overflow-hidden" aria-labelledby="attention-heading">
              <h2 id="attention-heading" className="border-b border-slate-100 px-5 py-4 text-base font-semibold text-slate-900">
                Needs your attention
              </h2>
              {attention.length === 0 ? (
                <p className="flex items-center gap-2.5 px-5 py-6 text-sm text-slate-600">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                    <Icon name="check" size={14} />
                  </span>
                  You&apos;re all caught up.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {attention.map((item) => (
                    <li key={item.label}>
                      <Link href={item.href} className={`group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-slate-50 ${focusRing} focus-visible:ring-inset`}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-slate-900">{item.label}</span>
                          <span className="block text-xs text-slate-500">{item.detail}</span>
                        </span>
                        <Pill tone={item.tone}>Review</Pill>
                        <Icon name="chevron-right" size={16} className="text-slate-300 group-hover:text-slate-500" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <section aria-labelledby="jump-heading">
            <h2 id="jump-heading" className="mb-3 text-base font-semibold text-slate-900">
              {remainingSetup.length > 0 ? "Manage your website" : "What would you like to do?"}
            </h2>
            <div className="grid gap-2.5 sm:grid-cols-2 [&>*]:min-w-0">
              {quickActions.map((action) => (
                <QuickLink key={action.href} {...action} />
              ))}
            </div>
          </section>
        </div>

        <div id="publishing" className="scroll-mt-20 space-y-5">
          {canManageWebsite ? (
            <PublishToggle businessId={id} initialStatus={business?.status ?? "draft"} storefrontUrl={storefrontUrl} />
          ) : (
            <div className={`${cardClass} p-5`}>
              <h2 className="text-base font-semibold text-slate-900">Publishing</h2>
              <p className="mt-1 text-sm text-slate-600">Only owners and managers can change publishing status.</p>
            </div>
          )}
          {canManageWebsite && (
            <dl className={`${cardClass} divide-y divide-slate-100 text-sm`}>
              <div className="flex items-center justify-between gap-3 px-5 py-3">
                <dt className="text-slate-500">Plan</dt>
                <dd className={`font-medium ${entitlements.active ? "text-slate-900" : "text-amber-800"}`}>{entitlements.planName}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-5 py-3">
                <dt className="text-slate-500">Team</dt>
                <dd className="font-medium text-slate-900">
                  {memberCount} of {entitlements.staffLimit + 1} allowed
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-5 py-3">
                <dt className="text-slate-500">Theme</dt>
                <dd className="truncate font-medium text-slate-900">{theme?.name ?? "—"}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
