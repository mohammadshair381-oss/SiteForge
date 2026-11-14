import Link from "next/link";
import { formatPrice } from "@/lib/format";
import { THEMES } from "@/lib/themes";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { PublicPlan } from "./plans";

const countLabel = (count: number, one: string) => `${count.toLocaleString("en-US")} ${one}${count === 1 ? "" : "s"}`;

export function planHighlights(plan: PublicPlan): string[] {
  return [
    countLabel(plan.productLimit, "product"),
    plan.themes.length >= THEMES.length ? `All ${THEMES.length} themes` : `${plan.themes.length} of ${THEMES.length} themes`,
    plan.staffLimit === 0 ? "Just you" : `You and ${countLabel(plan.staffLimit, "team member")}`,
    plan.removeBranding ? "No SiteForge branding" : "Small SiteForge credit in your footer",
  ];
}

/** Plans from the plan manager. The largest plan is simply called that: never a fabricated "most popular". */
export default function PlanCards({ plans, authed = false }: { plans: PublicPlan[]; authed?: boolean }) {
  if (plans.length === 0) {
    return <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">Plans are being configured. Check back soon.</p>;
  }
  const top = [...plans].sort((a, b) => b.price - a.price)[0];
  return (
    <ul className={`grid gap-4 ${plans.length >= 3 ? "lg:grid-cols-3" : plans.length === 2 ? "md:grid-cols-2" : ""}`}>
      {plans.map((plan) => {
        const featured = plan.key === top.key && plans.length > 1;
        return (
          <li key={plan.key} className={`flex flex-col rounded-2xl border p-6 sm:p-8 ${featured ? "border-ink bg-ink text-white" : "border-slate-200 bg-white shadow-sm"}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              {featured && <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-semibold text-ember-soft">Our biggest plan</span>}
            </div>
            <p className={`mt-1.5 min-h-10 text-sm leading-5 ${featured ? "text-white/70" : "text-slate-600"}`}>{plan.description}</p>
            <p className="mt-6 font-heading text-4xl font-semibold tracking-tight">
              {plan.price === 0 ? "Free" : formatPrice(plan.price, plan.currency)}
              {plan.price > 0 && <span className={`font-ui text-sm font-normal tracking-normal ${featured ? "text-white/60" : "text-slate-500"}`}> / {plan.interval}</span>}
            </p>
            <ul className={`mt-6 flex-1 space-y-2.5 text-sm ${featured ? "text-white/85" : "text-slate-700"}`}>
              {planHighlights(plan).map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Icon name="check" size={16} className={`mt-0.5 ${featured ? "text-ember-soft" : "text-ember"}`} />
                  {line}
                </li>
              ))}
            </ul>
            <Link href={authed ? "/dashboard" : "/register"} className={buttonClass({ variant: featured ? "invert" : "secondary", block: true, size: "lg", className: "mt-8" })}>
              {plan.price === 0 ? "Start free" : `Choose ${plan.name}`}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
