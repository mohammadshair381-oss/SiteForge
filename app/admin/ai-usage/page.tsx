import Link from "next/link";
import { requireSuperAdminPage } from "@/lib/admin/page-access";
import { AI_USAGE_ROW_LIMIT, APPROACHING_LIMIT_SHARE, getAiUsageOverview, isValidUsagePeriod } from "@/lib/admin/ai-usage";
import { getAiRoutingOverview } from "@/lib/ai-providers/overview";
import { usagePeriod } from "@/lib/ai-builder/usage";
import AiProviderManager from "@/components/admin/AiProviderManager";
import {
  Card,
  EmptyNote,
  PageTitle,
  RowHeader,
  StatGrid,
  StatTile,
  TableCard,
  Td,
  Th,
  Tr,
  linkClass,
  listClass,
  secondaryButtonClass,
  segmentClass,
  segmentedClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

const TASK_LABELS: Record<string, string> = {
  storefront: "Homepage and sections",
  page: "Pages",
  seo: "SEO",
  theme: "Theme advice",
  product: "Product text",
  planning: "Website planner",
  discovery: "Website conversation",
  website: "Whole website generation",
  revision: "Website changes in a conversation",
};

const number = (value: number) => value.toLocaleString("en-US");
const percent = (share: number | null) => (share === null ? "No AI on plan" : `${Math.round(share * 100)}%`);

/**
 * AI usage across the platform (stored counters only) and which provider handles what. Allowances
 * are changed in the plan manager; routing through the audited API, using the form here. Never
 * prompts, generated text, keys, credential values or costs.
 */
export default async function AdminAiUsagePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requireSuperAdminPage();
  const { period: requested } = await searchParams;
  const period = isValidUsagePeriod(requested) ? requested : usagePeriod();
  const data = await getAiUsageOverview(period);
  const routing = await getAiRoutingOverview();
  const status = { available: routing.available };
  const providerName = (id: string) => routing.providers.find((provider) => provider.id === id)?.displayName ?? id;

  return (
    <div className="space-y-5">
      <PageTitle
        title="AI usage"
        description="Stored request counters per business and month. Prompts and generated text are never stored or shown, and no costs are estimated. Allowances are set per plan in the plan manager."
      >
        <Link href="/admin/plans" className={secondaryButtonClass}>
          Plan allowances
        </Link>
      </PageTitle>

      <p role="status" className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] ${status.available ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-100 text-slate-800"}`}>
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.available ? "bg-emerald-600" : "bg-slate-400"}`} />
        {status.available ? "AI requests can be served on this platform." : "No AI requests can be served on this platform now: nothing is being sent to a provider. See why below."}
      </p>

      <Card title="AI providers and routing">
        <AiProviderManager initial={routing} />
      </Card>

      <nav aria-label="Month" className={segmentedClass}>
        {data.months.map((month) => (
          <Link key={month.period} href={`/admin/ai-usage?period=${month.period}`} aria-current={month.period === period ? "page" : undefined} className={segmentClass(month.period === period)}>
            {month.period}
          </Link>
        ))}
      </nav>

      <StatGrid>
        <StatTile label="Total requests" value={number(data.totals.requests)} detail={`${number(data.totals.businesses)} businesses`} />
        <StatTile label="Successful" value={number(data.totals.successes)} />
        <StatTile label="Failed" value={number(data.totals.failures)} detail="Provider errors and timeouts" />
        <StatTile label="Rejected AI outputs" value={number(data.totals.rejected)} detail="Invalid, unsupported or invented facts" />
      </StatGrid>

      <Card title="Businesses approaching their limit">
        {data.approaching.length === 0 ? (
          <EmptyNote>No business has used {Math.round(APPROACHING_LIMIT_SHARE * 100)}% of its allowance this month.</EmptyNote>
        ) : (
          <ul className={listClass}>
            {data.approaching.map((row) => (
              <li key={row.businessId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/admin/businesses/${row.businessId}`} className={`min-w-0 break-words ${linkClass}`}>{row.name}</Link>
                <span className="text-slate-700">{row.planName}: {number(row.requests)} of {number(row.limit)} used ({percent(row.share)}), {number(row.remaining)} left</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Usage by plan" flush>
          {data.byPlan.length === 0 ? (
            <div className="p-4"><EmptyNote>No AI requests this month.</EmptyNote></div>
          ) : (
            <TableCard
              flush
              label="AI usage by subscription plan"
              minWidth="min-w-[420px]"
              head={
                <>
                  <Th>Plan</Th>
                  <Th right>Businesses</Th>
                  <Th right>Requests</Th>
                  <Th right>Remaining</Th>
                </>
              }
            >
              {data.byPlan.map((plan) => (
                <Tr key={plan.planName}>
                  <RowHeader>{plan.planName}</RowHeader>
                  <Td right>{number(plan.businesses)}</Td>
                  <Td right>{number(plan.requests)}</Td>
                  <Td right>{number(plan.remainingTotal)} of {number(plan.limitTotal)}</Td>
                </Tr>
              ))}
            </TableCard>
          )}
        </Card>
        <Card title="Requests by kind">
          {data.byTask.length === 0 ? (
            <EmptyNote>No AI requests this month.</EmptyNote>
          ) : (
            <ul className={listClass}>
              {data.byTask.map((task) => (
                <li key={task.task} className="flex justify-between gap-2 py-2">
                  <span>{TASK_LABELS[task.task] ?? task.task}</span>
                  <span className="font-medium text-slate-900 [font-variant-numeric:tabular-nums]">{number(task.requests)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500">
            Tokens as reported by the provider: {number(data.totals.totalTokens)} total, from {number(data.totals.tokenReports)} responses that reported them.
          </p>
        </Card>
      </div>

      <Card title="Usage by provider and model" flush>
        {data.byRoute.length === 0 ? (
          <div className="p-4"><EmptyNote>No requests recorded by provider this month.</EmptyNote></div>
        ) : (
          <TableCard
            flush
            label={`AI usage by provider and model in ${period}`}
            minWidth="min-w-[560px]"
            head={
              <>
                <Th>Provider and model</Th>
                <Th right>Requests</Th>
                <Th right>Successful</Th>
                <Th right>Failed</Th>
                <Th right>Rejected</Th>
              </>
            }
          >
            {data.byRoute.map((route) => (
              <Tr key={`${route.providerId}:${route.model}`}>
                <RowHeader>{providerName(route.providerId)}: {route.model}</RowHeader>
                <Td right>{number(route.requests)}</Td>
                <Td right>{number(route.successes)}</Td>
                <Td right>{number(route.failures)}</Td>
                <Td right>{number(route.rejected)}</Td>
              </Tr>
            ))}
          </TableCard>
        )}
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">Answered after trying another provider: {number(data.fallbacks)}. Requests from before providers were recorded are counted only in the totals.</p>
      </Card>

      <Card title="Monthly usage" flush>
        <TableCard
          flush
          label="AI usage in the last six months"
          minWidth="min-w-[560px]"
          head={
            <>
              <Th>Month</Th>
              <Th right>Businesses</Th>
              <Th right>Requests</Th>
              <Th right>Successful</Th>
              <Th right>Failed</Th>
              <Th right>Rejected</Th>
            </>
          }
        >
          {data.months.map((month) => (
            <Tr key={month.period}>
              <RowHeader>{month.period}</RowHeader>
              <Td right>{number(month.businesses)}</Td>
              <Td right>{number(month.requests)}</Td>
              <Td right>{number(month.successes)}</Td>
              <Td right>{number(month.failures)}</Td>
              <Td right>{number(month.rejected)}</Td>
            </Tr>
          ))}
        </TableCard>
      </Card>

      <Card title={`Usage by business (${period})`} flush>
        {data.rows.length === 0 ? (
          <div className="p-4"><EmptyNote>No AI requests this month.</EmptyNote></div>
        ) : (
          <TableCard
            flush
            label={`AI usage per business in ${period}`}
            minWidth="min-w-[760px]"
            head={
              <>
                <Th>Business</Th>
                <Th>Plan</Th>
                <Th right>Requests</Th>
                <Th right>Successful</Th>
                <Th right>Failed</Th>
                <Th right>Rejected</Th>
                <Th right>Allowance</Th>
                <Th right>Remaining</Th>
              </>
            }
          >
            {data.rows.map((row) => (
              <Tr key={row.businessId}>
                <RowHeader>
                  <Link href={`/admin/businesses/${row.businessId}`} className={linkClass}>{row.name}</Link>
                </RowHeader>
                <Td>{row.planName}</Td>
                <Td right>{number(row.requests)}</Td>
                <Td right>{number(row.successes)}</Td>
                <Td right>{number(row.failures)}</Td>
                <Td right>{number(row.rejected)}</Td>
                <Td right>{number(row.limit)} ({percent(row.share)})</Td>
                <Td right>{number(row.remaining)}</Td>
              </Tr>
            ))}
          </TableCard>
        )}
        {data.truncated && <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">Showing the {AI_USAGE_ROW_LIMIT} businesses with the most requests. Totals above count every business; plan figures count the businesses shown.</p>}
      </Card>
    </div>
  );
}
