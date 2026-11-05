import Link from "next/link";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { getAdminBusinessDetail } from "@/lib/admin/control-center";
import { getAdminBusinessDomains } from "@/lib/admin/domain-health";
import { DOMAIN_WARNING_TEXT } from "@/lib/domains/health";
import { requireSuperAdminPage } from "@/lib/admin/page-access";
import { formatUsageValue, isOverLimit, type UsageLine } from "@/lib/plan-limits";
import { describeStoreAccess } from "@/lib/store-access";
import { getBusinessUsage } from "@/lib/usage-limits";
import { Plan } from "@/models/Plan";
import AssignPlanForm from "@/components/admin/AssignPlanForm";
import BusinessStatusAction from "@/components/admin/BusinessStatusAction";
import UserAdminActions from "@/components/admin/UserAdminActions";
import { Pill } from "@/components/ui/Surface";
import { Badge, Card, EmptyNote, PageTitle, formatDate, linkClass, listClass, monoClass } from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

function Usage({ line }: { line: UsageLine }) {
  const { label, used, limit, unit } = line;
  const over = line.key !== "themes" && isOverLimit(line);
  const share = limit === null ? null : limit === 0 ? (used > 0 ? 100 : 0) : Math.min(100, (used / limit) * 100);
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-slate-900">
        {formatUsageValue(used, unit)} <span className="text-sm font-normal text-slate-500">/ {limit === null ? "no limit" : formatUsageValue(limit, unit)}</span>
      </dd>
      {share !== null && (
        <dd aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full ${over ? "bg-red-600" : "bg-slate-900"}`} style={{ width: `${share}%` }} />
        </dd>
      )}
      {over && <dd className="mt-1.5"><Pill tone="danger" dot>Over limit</Pill></dd>}
    </div>
  );
}

export default async function AdminBusinessDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireSuperAdminPage();
  const { id } = await params;
  let detail;
  try {
    detail = await getAdminBusinessDetail(id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }
  const { business: b } = detail;
  const [domains, usage, plans] = await Promise.all([
    getAdminBusinessDomains(id),
    getBusinessUsage(id),
    Plan.find({ active: true }).sort({ sort: 1, price: 1 }).select("key name").lean(),
  ]);
  const { entitlements } = usage;
  const access = describeStoreAccess({ status: b.status, planAccess: entitlements.active, ...detail.publishFacts });

  return (
    <div className="space-y-5">
      <p className="text-[13px]"><Link href="/admin/businesses" className={linkClass}>← All businesses</Link></p>
      <PageTitle title={b.name} description={`${b.subdomain}${b.customDomain ? ` · ${b.customDomain}` : ""} · ${b.category} · theme ${b.themeId} · created ${formatDate(b.createdAt)}`}>
        <div className="flex items-center gap-3">
          <Badge value={b.status} />
          <BusinessStatusAction business={{ id: b.id, name: b.name, status: b.status }} />
        </div>
      </PageTitle>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Owner">
          {b.owner ? (
            <p className="break-words text-[13px] font-medium text-slate-900">{b.owner.name}<span className="block font-normal text-slate-500">{b.owner.email}</span></p>
          ) : <EmptyNote>No owner recorded.</EmptyNote>}
          {b.owner && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge value={b.owner.active ? "active" : "inactive"} label={b.owner.active ? "Account active" : "Account deactivated"} />
              <UserAdminActions user={{ id: b.owner.id, name: b.owner.name, platformRole: b.owner.platformRole, active: b.owner.active }} isSelf={b.owner.id === String(admin._id)} />
            </div>
          )}
          <dl className="mt-3 space-y-0.5 text-xs text-slate-500">
            <div>Created: {formatDate(b.createdAt)}</div>
            <div>Published: {formatDate(b.publishedAt)}</div>
            <div>Last order: {detail.recentOrders[0] ? formatDate(detail.recentOrders[0].createdAt) : "None"}</div>
            <div>Store record last changed: {formatDate(b.updatedAt)}</div>
          </dl>
        </Card>
        <Card title={`Plan and usage: ${entitlements.planName}`}>
          <dl className="grid grid-cols-2 gap-4">
            {usage.lines.map((line) => <Usage key={line.key} line={line} />)}
          </dl>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Subscription status: {entitlements.expired ? "expired" : entitlements.status.replace("_", " ")}. Feature access: {access.featureAccess ? "yes" : "no"}. Store online: {access.storeOnline ? "yes" : "no"}. Can publish: {access.publishEligible ? "yes" : `no (${access.blockers.join(", ").toLowerCase()})`}. Custom domain: {entitlements.customDomain ? "yes" : "no"}. Remove branding: {entitlements.removeBranding ? "yes" : "no"}. Counted exactly as the limits are enforced. Being over a limit removes nothing: it only stops new things being added.
          </p>
        </Card>
        <Card title="Online payments">
          {detail.paymentAccount ? (
            <div className="space-y-1.5 text-[13px]">
              <p className="flex flex-wrap items-center gap-1.5 text-slate-900">Razorpay <Badge value={detail.paymentAccount.status} /> <Badge value={detail.paymentAccount.mode} label={`${detail.paymentAccount.mode} mode`} /></p>
              <p className="text-slate-500">Key id <span className={monoClass}>{detail.paymentAccount.keyId}</span></p>
              <p className="text-xs text-slate-500">Connected {formatDate(detail.paymentAccount.connectedAt)}{detail.paymentAccount.rotatedAt ? ` · rotated ${formatDate(detail.paymentAccount.rotatedAt)}` : ""}</p>
            </div>
          ) : <EmptyNote>Not connected.</EmptyNote>}
          <p className="mt-3 text-xs text-slate-500">Cash on delivery: {b.codEnabled ? "enabled" : "off"} · Customer accounts: {detail.customerAccounts}</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Plan payments received" action={<Link href={`/admin/payments?domain=subscription&business=${b.id}`} className={`text-[13px] ${linkClass}`}>All records →</Link>}>
          {detail.planPayments.length === 0 ? <EmptyNote>No plan payments recorded.</EmptyNote> : (
            <ul className={listClass}>
              {detail.planPayments.map((row) => (
                <li key={`${row.verified}-${row.currency}`} className="py-2">
                  <p className="font-medium text-slate-900">
                    {row.currency === "—" ? row.amount.toFixed(2) : formatPrice(row.amount, row.currency)} <span className="text-xs font-normal text-slate-500">({row.count}) {row.verified ? "from the payment provider" : "manual or sandbox, not real revenue"}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {row.refunded > 0 ? `${row.currency === "—" ? row.refunded.toFixed(2) : formatPrice(row.refunded, row.currency)} refunded · ` : ""}last paid {formatDate(row.lastPaidAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Assign a plan">
          <AssignPlanForm businessId={b.id} plans={plans.map((plan) => ({ key: plan.key, name: plan.name }))} currentKey={entitlements.planKey} providerManaged={detail.providerManaged} />
          <p className="mt-3 text-xs leading-5 text-slate-500">For a complimentary or support change. No payment is recorded, and it never marks anything paid. In production, paid plans also need manual billing to be allowed.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Subscriptions" action={<Link href={`/admin/billing?business=${b.id}`} className={`text-[13px] ${linkClass}`}>Billing details →</Link>}>
          {detail.subscriptions.length === 0 ? <EmptyNote>No subscription.</EmptyNote> : (
            <ul className={listClass}>
              {detail.subscriptions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 break-words font-medium text-slate-900">{s.plan?.name ?? "Unknown plan"} <span className="text-xs font-normal text-slate-500">via {s.provider}</span></span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Badge value={s.status} /> renews/ends {formatDate(s.currentPeriodEnd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Team">
          <ul className={listClass}>
            {detail.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 break-words font-medium text-slate-900">{m.user?.name ?? "Unknown user"}<span className="block text-xs font-normal text-slate-500">{m.user?.email}</span></span>
                <span className="flex gap-2"><Badge value={m.role} /><Badge value={m.status} /></span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-slate-500">Business roles only; they grant no platform admin rights.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Catalog and orders">
          <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            {Object.entries(detail.products).map(([k, v]) => (
              <div key={`p-${k}`}><dt className="text-xs text-slate-500">Products {k}</dt><dd className="font-semibold text-slate-900">{v}</dd></div>
            ))}
            {Object.entries(detail.orders).map(([k, v]) => (
              <div key={`o-${k}`}><dt className="text-xs text-slate-500">Orders {k}</dt><dd className="font-semibold text-slate-900">{v}</dd></div>
            ))}
          </dl>
          <h3 className="mt-4 border-t border-slate-100 pt-3 text-[13px] font-semibold text-slate-900">Paid orders (all time, per currency)</h3>
          {detail.paidOrders.length === 0 ? <div className="mt-1"><EmptyNote>None.</EmptyNote></div> : (
            <ul className="mt-1 space-y-0.5 text-[13px] text-slate-700">
              {detail.paidOrders.map((r) => (
                <li key={`${r.method}-${r.currency}`}>
                  {r.method === "online" ? "Online (Razorpay-verified)" : r.method === "cod" ? "Cash on delivery (owner-confirmed)" : "Unknown method"}:{" "}
                  <strong className="font-semibold text-slate-900">{r.currency === "—" ? r.amount.toFixed(2) : formatPrice(r.amount, r.currency)}</strong> <span className="text-xs text-slate-500">({r.count})</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent orders" action={<Link href={`/admin/payments?domain=order&business=${b.id}`} className={`text-[13px] ${linkClass}`}>Online payment records →</Link>}>
          <p className="mb-2 text-xs text-slate-500">Shopper names and emails are not shown here.</p>
          {detail.recentOrders.length === 0 ? <EmptyNote>No orders.</EmptyNote> : (
            <ul className="divide-y divide-slate-100 text-[13px] text-slate-700">
              {detail.recentOrders.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 font-medium text-slate-900">#{o.orderNumber} <span className="text-xs font-normal text-slate-500">{o.paymentMethod ?? "no method"} · {formatDate(o.createdAt, true)}</span></span>
                  <span className="flex items-center gap-2"><Badge value={o.status} /> <span className="[font-variant-numeric:tabular-nums]">{formatPrice(o.total, o.currency || "USD")}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Custom domains" action={<Link href="/admin/domains" className={`text-[13px] ${linkClass}`}>All custom domains →</Link>}>
        {domains.length === 0 ? <EmptyNote>No custom domains.</EmptyNote> : (
          <ul className={listClass}>
            {domains.map((d) => (
              <li key={d.id} className="py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-medium text-slate-900">{d.domain}</span>
                  <Badge value={d.lifecycle} />
                  {d.health.status !== "not_applicable" && <Badge value={d.health.status} label={`health: ${d.health.status}`} />}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  DNS last confirmed {formatDate(d.lastDnsOkAt, true)} · certificate last confirmed {formatDate(d.lastCertificateOkAt, true)} · expires {formatDate(d.certificateExpiresAt)} · renewal {d.renewalStatus.replace(/_/g, " ")}
                </p>
                {d.health.warnings.map((warning) => (
                  <p key={warning} className="mt-0.5 text-xs text-slate-600">{DOMAIN_WARNING_TEXT[warning]}</p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Admin history for this business" action={<Link href={`/admin/audit?targetType=business&targetId=${b.id}`} className={`text-[13px] ${linkClass}`}>Open in audit log →</Link>}>
        {detail.audit.length === 0 ? <EmptyNote>No admin actions recorded.</EmptyNote> : (
          <ul className={listClass}>
            {detail.audit.map((a) => (
              <li key={a.id} className="py-2">
                <p><span className="font-mono text-xs font-medium text-slate-900">{a.action}</span> by {a.actorName || "unknown"} · <span className="text-slate-500">{formatDate(a.createdAt, true)}</span></p>
                {a.reason && <p className="mt-0.5 break-words text-xs text-slate-600">Reason: {a.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
