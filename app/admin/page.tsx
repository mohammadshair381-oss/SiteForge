import Link from "next/link";
import type { ReactNode } from "react";
import { getPlatformOverview, parseDateRange, toIsoDay } from "@/lib/admin/control-center";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import { Icon } from "@/components/ui/Icon";
import {
  Badge,
  Card,
  DailyBarChart,
  EmptyNote,
  FilterField,
  Money,
  PageTitle,
  StatGrid,
  StatTile,
  buttonClass,
  formatDate,
  inputClass,
  linkClass,
  listClass,
  segmentClass,
  segmentedClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

const PRESETS = [7, 30, 90, 365];

function MoneyItem({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] font-medium text-slate-800">{title}</dt>
      <dd className="mt-1 text-[13px]">{children}</dd>
      {note && <dd className="mt-1 text-xs leading-5">{note}</dd>}
    </div>
  );
}

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSuperAdminPage();
  const params = singleParams(await searchParams);
  const range = parseDateRange(params.from, params.to);
  const o = await getPlatformOverview(range);
  const today = toIsoDay(new Date());
  const presetFrom = (days: number) => toIsoDay(new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000));

  const sum = (record: Record<string, number>) => Object.values(record).reduce((n, v) => n + v, 0);
  const p = o.inRange.payments;

  return (
    <div className="space-y-5">
      <PageTitle title="Platform overview" description={`Measured from the database for ${o.range.from} to ${o.range.to} (UTC, ${o.range.days} days). Totals are all-time.`}>
        <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Date range">
          <FilterField label="From" className="w-[9.5rem]">
            <input type="date" name="from" defaultValue={o.range.from} className={inputClass} />
          </FilterField>
          <FilterField label="To" className="w-[9.5rem]">
            <input type="date" name="to" defaultValue={o.range.to} className={inputClass} />
          </FilterField>
          <button type="submit" className={buttonClass}>Apply</button>
        </form>
      </PageTitle>

      <div className={segmentedClass}>
        {PRESETS.map((days) => {
          const active = o.range.from === presetFrom(days) && o.range.to === today;
          return (
            <Link key={days} href={`/admin?from=${presetFrom(days)}&to=${today}`} aria-current={active ? "true" : undefined} className={segmentClass(active)}>
              Last {days} days
            </Link>
          );
        })}
      </div>

      {o.alerts.length > 0 && (
        <section aria-labelledby="alerts-title" className="space-y-2">
          <h2 id="alerts-title" className="sr-only">Alerts</h2>
          {o.alerts.map((alert) => (
            <Link
              key={alert.kind}
              href={alert.href}
              className={`flex items-start gap-3 rounded-xl border px-4 py-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 motion-reduce:transition-none ${
                alert.severity === "critical" ? "border-red-200 bg-red-50 text-red-900 hover:border-red-300" : "border-amber-200 bg-amber-50 text-amber-950 hover:border-amber-300"
              }`}
            >
              <Icon name="alert" size={16} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <strong className="mr-1 font-semibold">{alert.severity === "critical" ? "Critical:" : "Warning:"} {alert.count}</strong>
                {alert.message}
              </span>
              <Icon name="chevron-right" size={15} className="mt-0.5 opacity-60" />
            </Link>
          ))}
        </section>
      )}

      <StatGrid>
        <StatTile label="Businesses" value={sum(o.totals.businesses)} href="/admin/businesses"
          detail={`${o.totals.businesses.published} published · ${o.totals.businesses.draft} draft · ${o.totals.businesses.suspended} suspended`} />
        <StatTile label="Platform users" value={o.totals.users.total} href="/admin/users"
          detail={`${o.totals.users.superAdmins} super admins · ${o.totals.users.inactive} inactive`} />
        <StatTile label="Products" value={sum(o.totals.products) - (o.totals.products.archived ?? 0)}
          detail={`${o.totals.products.active} active · ${o.totals.products.draft} draft · ${o.totals.products.archived} archived (not counted)`} />
        <StatTile label="Orders" value={sum(o.totals.orders)}
          detail={`${o.totals.orders.paid} paid · ${o.totals.orders.pending} pending · ${o.totals.orders.cancelled} cancelled · ${o.totals.orders.refunded} refunded`} />
        <StatTile label="Customer accounts" value={o.totals.customerAccounts} detail="Storefront shopper accounts (all stores)" />
        <StatTile label="Subscriptions" value={sum(o.totals.subscriptions)}
          detail={`${o.totals.subscriptions.active} active · ${o.totals.subscriptions.trialing} trialing · ${o.totals.subscriptions.past_due} past due · ${o.totals.subscriptions.canceled} canceled · ${o.totals.subscriptions.incomplete} incomplete`} />
        <StatTile label="New businesses" value={o.inRange.newBusinesses} detail="In the selected range" />
        <StatTile label="New users / orders" value={`${o.inRange.newUsers} / ${o.inRange.orders}`} detail="In the selected range" />
      </StatGrid>

      <Card
        title="Payments in range (by date paid)"
        flush
        action={<Link href="/admin/payments" className={`text-[13px] ${linkClass}`}>View payment records →</Link>}
      >
        <p className="border-b border-slate-100 px-4 py-2.5 text-xs leading-5 text-slate-500">
          Per currency, never converted or combined. Storefront order money belongs to each business (paid into its own account); it is not
          SiteForge revenue.
        </p>
        <div className="grid gap-px bg-slate-100 lg:grid-cols-2">
          <div className="min-w-0 bg-white p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">SiteForge subscriptions</h3>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <MoneyItem title="Subscription revenue (provider-recorded)">
                <Money rows={p.providerSubscriptions} empty="None yet" />
              </MoneyItem>
              <MoneyItem title="Manual / sandbox activations" note={<span className="text-amber-800">Not real money: recorded by the manual billing mode.</span>}>
                <Money rows={p.manualSubscriptions} />
              </MoneyItem>
            </dl>
          </div>
          <div className="min-w-0 bg-white p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">Store orders (each business&apos;s own money)</h3>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <MoneyItem title="Store orders paid online" note={<span className="text-slate-500">Confirmed with Razorpay before marked paid.</span>}>
                <Money rows={p.onlineOrders} />
              </MoneyItem>
              <MoneyItem title="Store orders paid cash on delivery" note={<span className="text-slate-500">Marked paid by the business owner; not provider-verified.</span>}>
                <Money rows={p.codOrders} />
              </MoneyItem>
            </dl>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><DailyBarChart title="Orders per day" series={o.series.orders} unit="orders" /></Card>
        <Card><DailyBarChart title="New businesses per day" series={o.series.businesses} unit="businesses" /></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent admin activity" action={<Link href="/admin/audit" className={`text-[13px] ${linkClass}`}>Full audit log →</Link>}>
          {o.recentActivity.length === 0 ? (
            <EmptyNote>No admin actions recorded yet.</EmptyNote>
          ) : (
            <ul className={listClass}>
              {o.recentActivity.map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-2">
                  <span className="min-w-0 break-words">
                    <span className="font-mono text-xs font-medium text-slate-900">{a.action}</span> · {a.targetLabel || a.targetId}
                    <span className="block text-xs text-slate-500">by {a.actorName || "unknown"}</span>
                  </span>
                  <span className="text-xs text-slate-500">{formatDate(a.createdAt, true)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Newest businesses">
          {o.recentBusinesses.length === 0 ? (
            <EmptyNote>No businesses yet.</EmptyNote>
          ) : (
            <ul className={listClass}>
              {o.recentBusinesses.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/admin/businesses/${b.id}`} className={`min-w-0 break-words ${linkClass}`}>{b.name}</Link>
                  <span className="flex items-center gap-2 text-xs text-slate-500">
                    <Badge value={b.status} /> {formatDate(b.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
