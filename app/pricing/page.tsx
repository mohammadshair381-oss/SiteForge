import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getSession } from "@/lib/auth/session";
import { formatPrice } from "@/lib/format";
import { THEMES } from "@/lib/themes";
import PublicPage from "@/components/marketing/PublicPage";
import PlanCards from "@/components/marketing/PlanCards";
import { loadPublicPlans, type PublicPlan } from "@/components/marketing/plans";
import { Icon } from "@/components/ui/Icon";
import { Eyebrow } from "@/components/ui/Surface";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing | SiteForge",
  description: "Compare SiteForge plans: products, themes, team members, AI suggestions and more.",
};

const yes = (
  <>
    <Icon name="check" size={18} className="mx-auto text-ember" />
    <span className="sr-only">Included</span>
  </>
);
const no = (
  <>
    <span aria-hidden="true" className="text-slate-300">
      –
    </span>
    <span className="sr-only">Not included</span>
  </>
);

const ROWS: Array<{ label: string; value: (plan: PublicPlan) => ReactNode }> = [
  { label: "Products", value: (plan) => plan.productLimit.toLocaleString("en-US") },
  { label: "Store themes", value: (plan) => `${plan.themes.length} of ${THEMES.length}` },
  { label: "Team members besides you", value: (plan) => plan.staffLimit.toLocaleString("en-US") },
  { label: "AI suggestions per month*", value: (plan) => plan.aiRequestsPerMonth.toLocaleString("en-US") },
  { label: "Your own domain name**", value: (plan) => (plan.customDomain ? yes : no) },
  { label: "No SiteForge branding", value: (plan) => (plan.removeBranding ? yes : no) },
];

export default async function PricingPage() {
  const [plans, session] = await Promise.all([loadPublicPlans(), getSession()]);
  const authed = Boolean(session);

  return (
    <PublicPage authed={authed}>
      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-14 text-center sm:px-6 sm:py-20">
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold tracking-tight [text-wrap:balance] sm:text-6xl">Plans that grow with your business</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-slate-600">Every plan includes the visual editor, your online store, orders and guided setup. Choose by how much you sell and how many designs you want.</p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
        <PlanCards plans={plans} authed={authed} />
      </section>

      {plans.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 sm:pb-24" aria-labelledby="compare-heading">
          <h2 id="compare-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Compare plans
          </h2>
          <div className="relative mt-6 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th scope="col" className="px-5 py-4 text-left text-xs font-medium text-slate-500">
                    <span className="sr-only">Feature</span>
                  </th>
                  {plans.map((plan) => (
                    <th key={plan.key} scope="col" className="px-5 py-4 text-center">
                      <span className="block font-heading text-base font-semibold text-slate-900">{plan.name}</span>
                      <span className="block text-xs font-normal text-slate-500">{plan.price === 0 ? "Free" : `${formatPrice(plan.price, plan.currency)} / ${plan.interval}`}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row" className="px-5 py-3.5 text-left font-medium text-slate-700">
                      {row.label}
                    </th>
                    {plans.map((plan) => (
                      <td key={plan.key} className="px-5 py-3.5 text-center text-slate-900">
                        {row.value(plan)}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="px-5 py-3.5 text-left font-medium text-slate-700">
                    Included themes
                  </th>
                  {plans.map((plan) => (
                    <td key={plan.key} className="px-5 py-3.5 text-center align-top text-xs leading-5 text-slate-600">
                      {THEMES.filter((theme) => plan.themes.includes(theme.id))
                        .map((theme) => theme.name)
                        .join(", ")}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-4 space-y-1 text-xs leading-5 text-slate-500">
            <p>* The AI Builder is being rolled out and needs the store owner&apos;s consent. Every suggestion is reviewed before anything changes.</p>
            <p>** Domain ownership verification is available today. Automatic connection of your domain is being finalised.</p>
          </div>
        </section>
      )}
    </PublicPage>
  );
}
