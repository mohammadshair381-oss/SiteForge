import { requireBusinessRole } from "@/lib/auth/guards";
import { formatPrice } from "@/lib/format";
import { getBusinessInsights, parseDateRange } from "@/lib/business-insights";
import { toIsoDay } from "@/lib/date-range";
import { formatUsageValue, isAtLimit } from "@/lib/plan-limits";
import ManagementPageHeader from "@/components/dashboard/ManagementPageHeader";
import DailyBarChart from "@/components/charts/DailyBarChart";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill, StatTile } from "@/components/ui/Surface";
import Link from "next/link";

export const dynamic = "force-dynamic";

const PRESETS = [7, 30, 90];

function money(amount: number, currency: string) {
  return currency === "—" ? amount.toFixed(2) : formatPrice(amount, currency);
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Actual change between two measured values (no projection). */
function Change({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return <span>{current === 0 ? "no change" : "new this period"}</span>;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return <span>no change vs previous period</span>;
  const up = pct > 0;
  return (
    <>
      <span className={`font-medium ${up ? "text-emerald-700" : "text-red-700"}`}>
        <span aria-hidden="true">{up ? "▲" : "▼"}</span> {Math.abs(pct)}%
      </span>{" "}
      vs previous period
    </>
  );
}

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card as="section" className={`min-w-0 p-5 sm:p-6 ${className}`}>
      <h2 className="mb-4 text-base font-semibold text-slate-900">{title}</h2>
      {children}
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">{children}</p>;
}

/** A thin share-of-total bar. Purely visual: the number beside it carries the value. */
function ShareBar({ value, total, tone = "bg-slate-900" }: { value: number; total: number; tone?: string }) {
  const percent = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

export default async function BusinessInsightsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // Aggregates of orders and customers: same audience as order management.
  await requireBusinessRole(id, ["owner", "manager"]);
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const range = parseDateRange(one(raw.from), one(raw.to));
  const data = await getBusinessInsights(id, range);
  const today = toIsoDay(new Date());
  const presetFrom = (days: number) => toIsoDay(new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000));
  const base = `/dashboard/businesses/${id}`;
  const primarySales = data.sales.find((s) => s.currency === data.primaryCurrency);
  const primaryRevenue = data.revenue.find((r) => r.currency === data.primaryCurrency);
  const methodTotal = data.paymentMethods.online + data.paymentMethods.cod + data.paymentMethods.unknown;
  const otherCurrencies = data.sales.filter((s) => s.currency !== data.primaryCurrency);
  const noActivity = data.orders.placed === 0 && data.revenue.length === 0;

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Insights"
        description={`Measured from your own orders, products and plan for ${data.range.from} to ${data.range.to} (dates in UTC). Your store's main currency is ${data.primaryCurrency}. Other currencies are listed separately and never converted. No estimates or AI suggestions are shown here.`}
        actions={
          <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Date range">
            <label className="text-xs font-medium text-slate-600">
              From
              <input type="date" name="from" defaultValue={data.range.from} className="mt-1 block min-h-10 rounded-lg border px-3 py-2 text-sm text-slate-900" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              To
              <input type="date" name="to" defaultValue={data.range.to} className="mt-1 block min-h-10 rounded-lg border px-3 py-2 text-sm text-slate-900" />
            </label>
            <Button type="submit">Apply</Button>
          </form>
        }
      />
      <nav aria-label="Quick date ranges" className="ui-scroll-x flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg border bg-slate-100 p-0.5">
        {PRESETS.map((days) => {
          const selected = data.range.to === today && data.range.from === presetFrom(days);
          return (
            <Link
              key={days}
              href={`${base}/insights?from=${presetFrom(days)}&to=${today}`}
              aria-current={selected ? "true" : undefined}
              className={`inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
            >
              Last {days} days
            </Link>
          );
        })}
      </nav>

      {(data.outOfStock.length > 0 || data.lowStock.length > 0 || data.openDisputes > 0 || !data.plan.active) && (
        <div className="space-y-2">
          {!data.plan.active && (
            <Notice tone="danger" role="alert" action={<ButtonLink href={`${base}/billing`} variant="secondary">Review your plan</ButtonLink>}>
              Your subscription is not active ({data.plan.expired ? "expired" : data.plan.status.replace("_", " ")}), so your storefront is offline.
            </Notice>
          )}
          {data.openDisputes > 0 && (
            <Notice tone="danger" action={<ButtonLink href={`${base}/orders`} variant="secondary">View orders</ButtonLink>}>
              {data.openDisputes === 1 ? "1 payment dispute reported by Razorpay is open." : `${data.openDisputes} payment disputes reported by Razorpay are open.`} Respond in your Razorpay dashboard.
            </Notice>
          )}
          {data.outOfStock.length > 0 && (
            <Notice tone="warning" action={<ButtonLink href={`${base}/products`} variant="secondary">Update stock</ButtonLink>}>
              {data.outOfStock.length === 1 ? "1 active product is out of stock and cannot be bought." : `${data.outOfStock.length} active products are out of stock and cannot be bought.`}
            </Notice>
          )}
          {data.lowStock.length > 0 && (
            <Notice tone="warning">
              {data.lowStock.length === 1 ? "1 active product has" : `${data.lowStock.length} active products have`} reached the low-stock level.
            </Notice>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label={`Net revenue (${data.primaryCurrency})`}
          value={money(primarySales?.amount ?? 0, data.primaryCurrency)}
          hint={<Change current={primarySales?.amount ?? 0} previous={primarySales?.previousPeriod ?? 0} />}
          icon={<Icon name="billing" size={16} />}
        />
        <StatTile
          label="Orders placed"
          value={data.orders.placed}
          hint={<Change current={data.orders.placed} previous={data.orders.previousPeriod} />}
          icon={<Icon name="orders" size={16} />}
        />
        <StatTile
          label="Average order value"
          value={primaryRevenue ? money(primaryRevenue.averageOrder, data.primaryCurrency) : "—"}
          hint={`Before refunds, from ${plural(primaryRevenue?.orders ?? 0, "paid order")}`}
          icon={<Icon name="activity" size={16} />}
        />
        <StatTile
          label="Products sold"
          value={data.unitsSold}
          hint="Units on paid orders"
          icon={<Icon name="products" size={16} />}
        />
        <StatTile
          label="Customers"
          value={data.customers.inRange}
          hint={`${data.customers.new} new · ${data.customers.returning} returning`}
          icon={<Icon name="customers" size={16} />}
        />
      </div>

      <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
        <summary className="min-h-6 cursor-pointer font-medium text-slate-900">How these figures are worked out</summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><dt className="font-medium text-slate-900">Gross sales</dt><dd className="text-slate-600">The full total of orders paid in this period, including delivery and tax, before any refund.</dd></div>
          <div><dt className="font-medium text-slate-900">Refunds on those orders</dt><dd className="text-slate-600">What has gone back so far on orders paid in this period, whenever the refund happened. It can grow later, so an earlier period&apos;s net can change.</dd></div>
          <div><dt className="font-medium text-slate-900">Net revenue</dt><dd className="text-slate-600">Gross sales minus refunds on those orders.</dd></div>
          <div><dt className="font-medium text-slate-900">Refunds by refund date</dt><dd className="text-slate-600">Money that went back during this period, whenever the order was paid. It is not taken from net revenue, because that would count refunds on earlier orders against this period&apos;s sales.</dd></div>
          <div><dt className="font-medium text-slate-900">Unpaid orders</dt><dd className="text-slate-600">Placed in this period and still waiting for payment. Not revenue.</dd></div>
          <div><dt className="font-medium text-slate-900">Cancelled orders</dt><dd className="text-slate-600">Placed in this period and since cancelled. Not revenue.</dd></div>
        </dl>
      </details>

      {noActivity ? (
        <EmptyState icon={<Icon name="insights" size={20} />} title="No orders in this period yet">
          When customers order from your published storefront, sales, products and customer trends appear here.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Sales trend">
            <DailyBarChart
              title={`Paid sales per day (${data.primaryCurrency})`}
              series={data.series.sales}
              unit="in sales"
              formatValue={(n) => money(n, data.primaryCurrency)}
            />
          </Panel>
          <Panel title="Order trend">
            <DailyBarChart title="Orders placed per day" series={data.series.orders} unit="orders" />
          </Panel>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Gross, refunds and net, by payment date">
          {data.revenue.length === 0 ? <Empty>No orders were paid in this period.</Empty> : (
            <ul className="space-y-4 text-sm">
              {data.revenue.map((r) => (
                <li key={r.currency}>
                  <dl className="space-y-1">
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-600">Gross sales</dt>
                      <dd className="shrink-0 font-medium tabular-nums text-slate-900">{money(r.gross, r.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-600">Refunds on these orders</dt>
                      <dd className="shrink-0 font-medium tabular-nums text-slate-900">{r.refunds > 0 ? "−" : ""}{money(r.refunds, r.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-3 border-t border-slate-100 pt-1">
                      <dt className="font-semibold text-slate-900">Net revenue</dt>
                      <dd className="shrink-0 font-semibold tabular-nums text-slate-900">{money(r.net, r.currency)}</dd>
                    </div>
                  </dl>
                  <p className="mt-1 text-xs text-slate-500">From {plural(r.orders, "order")} paid in this period.</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">Includes delivery and tax charged. Unpaid and cancelled orders are not counted. Other currencies are never combined.</p>
        </Panel>
        <Panel title="Orders by status">
          <dl className="space-y-3 text-sm">
            {Object.entries(data.orders.byStatus).map(([status, count]) => (
              <div key={status}>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-slate-600">{status === "pending" ? "Awaiting payment" : `${status.charAt(0).toUpperCase()}${status.slice(1)}`}</dt>
                  <dd className="font-semibold tabular-nums text-slate-900">{count}</dd>
                </div>
                <ShareBar value={count} total={data.orders.placed} />
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title="How customers paid">
          {data.sales.length === 0 ? <Empty>No paid orders in this period.</Empty> : (
            <ul className="space-y-4 text-sm">
              {data.sales.map((s) => (
                <li key={s.currency}>
                  <p className="font-semibold text-slate-900">
                    {money(s.amount, s.currency)} <span className="font-normal text-slate-500">from {plural(s.orders, "order")}</span>
                  </p>
                  <dl className="mt-2 space-y-1 text-xs text-slate-600">
                    <div className="flex justify-between gap-3">
                      <dt>Online (verified by Razorpay)</dt>
                      <dd className="shrink-0 font-medium tabular-nums text-slate-900">{money(s.online, s.currency)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Cash on delivery (marked paid by you)</dt>
                      <dd className="shrink-0 font-medium tabular-nums text-slate-900">{money(s.cod, s.currency)}</dd>
                    </div>
                    {s.other > 0 && (
                      <div className="flex justify-between gap-3">
                        <dt>Other</dt>
                        <dd className="shrink-0 font-medium tabular-nums text-slate-900">{money(s.other, s.currency)}</dd>
                      </div>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}
          {otherCurrencies.length > 0 && <p className="mt-3 text-xs text-slate-500">Charts show {data.primaryCurrency} only; other currencies are listed here and never combined.</p>}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Refunds by refund date">
          {data.refundsByRefundDate.length === 0 ? <Empty>No money was refunded during this period.</Empty> : (
            <ul className="space-y-2 text-sm">
              {data.refundsByRefundDate.map((r) => (
                <li key={r.currency} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-semibold tabular-nums text-slate-900">{money(r.amount, r.currency)}</span>
                  <span className="text-xs text-slate-600">{plural(r.orders, "refund")}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">When the money went back, whenever the order was paid. This is a separate view from the refunds in the panel above, and is not taken off net revenue again.</p>
        </Panel>
        <Panel title="Not counted as revenue">
          {data.notRevenue.unpaid.length === 0 && data.notRevenue.cancelled.length === 0 ? <Empty>No unpaid or cancelled orders from this period.</Empty> : (
            <dl className="space-y-3 text-sm">
              {[
                { label: "Unpaid", rows: data.notRevenue.unpaid },
                { label: "Cancelled", rows: data.notRevenue.cancelled },
              ].map(({ label, rows }) => (
                <div key={label}>
                  <dt className="font-medium text-slate-900">{label}</dt>
                  {rows.length === 0 ? <dd className="text-slate-500">None</dd> : rows.map((r) => (
                    <dd key={r.currency} className="flex flex-wrap items-baseline justify-between gap-x-3 text-slate-600">
                      <span>{plural(r.orders, "order")}</span>
                      <span className="tabular-nums">{money(r.amount, r.currency)}</span>
                    </dd>
                  ))}
                </div>
              ))}
            </dl>
          )}
          <p className="mt-3 text-xs text-slate-500">Orders placed in this period, as they stand now. Shown for information only.</p>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Payment methods">
          {methodTotal === 0 ? <Empty>No orders in this period.</Empty> : (
            <dl className="space-y-3 text-sm">
              {[
                { label: "Online", value: data.paymentMethods.online },
                { label: "Cash on delivery", value: data.paymentMethods.cod },
                ...(data.paymentMethods.unknown > 0 ? [{ label: "Not recorded", value: data.paymentMethods.unknown }] : []),
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-slate-600">{row.label}</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">{row.value}</dd>
                  </div>
                  <ShareBar value={row.value} total={methodTotal} />
                </div>
              ))}
            </dl>
          )}
          <p className="mt-3 text-xs text-slate-500">Orders placed in this period, paid or not, except cancelled ones.</p>
        </Panel>
        <Panel title="Coupon usage">
          {data.coupons.length === 0 ? <Empty>No coupons were used in this period.</Empty> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.coupons.map((c) => (
                <li key={`${c.code}-${c.currency}`} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                  <span className="min-w-0 break-all font-medium text-slate-900">{c.code}</span>
                  <span className="text-xs text-slate-600">{plural(c.orders, "order")} · <span className="tabular-nums">{money(c.discount, c.currency)}</span> off</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">Orders placed in this period, except cancelled ones.</p>
        </Panel>
        <Panel title="Customers">
          {data.customers.inRange === 0 ? <Empty>No customers ordered in this period.</Empty> : (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">New</dt>
                <dd className="font-semibold tabular-nums text-slate-900">{data.customers.new}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">Returning</dt>
                <dd className="font-semibold tabular-nums text-slate-900">{data.customers.returning}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">Repeat (two or more orders)</dt>
                <dd className="font-semibold tabular-nums text-slate-900">{data.customers.repeat}</dd>
              </div>
            </dl>
          )}
          <p className="mt-3 text-xs text-slate-500">Customers are counted by email address, as on your Customers page. Orders without a usable address are not counted.</p>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Best-selling products">
          {data.topProducts.length === 0 ? <Empty>No products sold in this period.</Empty> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs font-medium text-slate-500">
                  <tr>
                    <th scope="col" className="py-2 font-medium">Product</th>
                    <th scope="col" className="py-2 pl-3 text-right font-medium">Units</th>
                    <th scope="col" className="py-2 pl-3 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.topProducts.map((p) => (
                    <tr key={`${p.productId}-${p.currency}`}>
                      <td className="py-2 pr-3 text-slate-900">{p.name}</td>
                      <td className="py-2 pl-3 text-right tabular-nums text-slate-700">{p.units}</td>
                      <td className="py-2 pl-3 text-right font-medium tabular-nums text-slate-900">{money(p.revenue, p.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            {data.unsoldActiveProducts} of {plural(data.activeProducts, "active product")} had no paid sales in this period.
          </p>
        </Panel>
        <Panel title="Stock alerts">
          {data.outOfStock.length === 0 && data.lowStock.length === 0 ? (
            <Empty>All active products are above their low-stock level.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.outOfStock.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-slate-900">{p.name}</span>
                  <Pill tone="danger" dot>Out of stock</Pill>
                </li>
              ))}
              {data.lowStock.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-slate-900">{p.name}</span>
                  <Pill tone="warning" dot>{p.stock} left</Pill>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">Stock already excludes units reserved by unpaid orders. Each product&apos;s low-stock level is set on the product, and is 5 units otherwise.</p>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Customer acquisition">
          {data.customers.new === 0 ? <Empty>No first-time customers in this period.</Empty> : (
            <DailyBarChart title="First-time customers per day" series={data.customers.newSeries} unit="new customers" />
          )}
        </Panel>
        <Panel title="Plan usage">
          <p className="mb-3 text-sm text-slate-600">{data.plan.name} plan</p>
          <dl className="space-y-3 text-sm">
            {data.plan.usage.filter((line) => line.key !== "themes").map((line) => (
              <div key={line.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <dt className="text-slate-600">{line.label}</dt>
                  <dd className={`font-semibold tabular-nums ${isAtLimit(line) && (line.limit ?? 0) > 0 ? "text-amber-800" : "text-slate-900"}`}>
                    {formatUsageValue(line.used, line.unit)} / {line.limit === null ? "no limit" : formatUsageValue(line.limit, line.unit)}
                  </dd>
                </div>
                {line.limit !== null && <ShareBar value={line.used} total={line.limit} tone={isAtLimit(line) && line.limit > 0 ? "bg-amber-500" : "bg-slate-900"} />}
              </div>
            ))}
          </dl>
          {data.plan.usage.some((line) => line.key !== "themes" && isAtLimit(line) && (line.limit ?? 0) > 0) && (
            <p className="mt-3 text-xs text-slate-600">
              You have reached a limit on your plan. Nothing is removed, but you can&apos;t add more.{" "}
              <Link className="font-semibold text-brand-700 underline" href={`${base}/billing`}>Change plan</Link>
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
