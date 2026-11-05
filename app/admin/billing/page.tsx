import Link from "next/link";
import { billingQuerySchema, BILLING_FILTERS, getAdminBillingDetail, listAdminBilling } from "@/lib/billing-admin";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import { integrationStatuses } from "@/lib/integration-status";
import { FEATURE_LABELS, missingIndexes, type IndexedFeature } from "@/lib/required-indexes";
import { getScheduledJobStatus } from "@/lib/scheduled-jobs";
import { formatPrice } from "@/lib/format";
import { isValidObjectId } from "@/lib/ids";
import BillingReconcileButton from "@/components/admin/BillingReconcileButton";
import {
  Badge,
  Card,
  EmptyNote,
  EmptyRow,
  PageTitle,
  Pagination,
  TableCard,
  Td,
  Th,
  Tr,
  formatDate,
  hrefWith,
  linkClass,
  listClass,
  monoClass,
  segmentClass,
  segmentedClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

const FILTER_LABELS: Record<(typeof BILLING_FILTERS)[number], string> = {
  all: "All",
  active: "Active",
  past_due: "Payment failed",
  halted: "Retries ended",
  ending: "Ending",
  ended: "Ended",
  attention: "Needs attention",
};

const FEATURES: IndexedFeature[] = ["subscription_billing", "team_invitations", "custom_domains", "customer_carts", "notifications", "order_refunds", "customer_accounts"];

export default async function AdminBillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSuperAdminPage();
  const params = singleParams(await searchParams);
  const query = billingQuerySchema.parse(params);
  const selected = typeof params.business === "string" && isValidObjectId(params.business) ? params.business : null;
  const [list, detail, readiness, reconcileJob] = await Promise.all([
    listAdminBilling(query),
    selected ? getAdminBillingDetail(selected) : null,
    Promise.all(FEATURES.map(async (feature) => ({ feature, missing: await missingIndexes(feature) }))),
    getScheduledJobStatus("billing-reconcile"),
  ]);
  const current = { filter: query.filter };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Subscription billing"
        description="SiteForge charging store owners through Razorpay. Read-only: state changes only from what Razorpay reports, and refunds are made in Razorpay's dashboard. Store-order payments are under Payments."
      />

      <div className={segmentedClass} role="tablist" aria-label="Filter subscriptions">
        {BILLING_FILTERS.map((filter) => (
          <Link key={filter} role="tab" aria-selected={query.filter === filter} href={hrefWith("/admin/billing", {}, { filter })} className={segmentClass(query.filter === filter)}>
            {FILTER_LABELS[filter]}
          </Link>
        ))}
      </div>

      <TableCard
        label="Subscriptions"
        head={
          <>
            <Th>Business</Th>
            <Th>Plan</Th>
            <Th>State</Th>
            <Th>Paid until</Th>
            <Th>Grace ends</Th>
            <Th>Razorpay reference</Th>
            <Th>Last event</Th>
            <Th>Last check</Th>
          </>
        }
      >
        {list.items.length === 0 ? (
          <EmptyRow colSpan={8} title="No subscriptions here" />
        ) : (
          list.items.map((row) => (
            <Tr key={row.businessId}>
              <Td>
                <Link className={linkClass} href={hrefWith("/admin/billing", current, { business: row.businessId })}>
                  {row.businessName}
                </Link>
                {row.checkoutPending && <p className="mt-0.5 text-xs text-slate-500">Payment page open</p>}
              </Td>
              <Td>{row.planName}</Td>
              <Td>
                <Badge value={row.state.key} label={row.state.label} />
                {row.cancelAtPeriodEnd && <p className="mt-0.5 text-xs text-slate-500">Cancels at period end</p>}
              </Td>
              <Td>{formatDate(row.currentPeriodEnd)}</Td>
              <Td>{formatDate(row.graceUntil)}</Td>
              <Td><span className={monoClass}>{row.providerSubscriptionId ?? "—"}</span></Td>
              <Td>{formatDate(row.lastWebhookAt, true)}</Td>
              <Td>
                {formatDate(row.lastReconciledAt, true)}
                {row.lastReconcileError && <p className="mt-0.5 text-xs text-red-700">Failed: {row.lastReconcileError}</p>}
                <div className="mt-1"><BillingReconcileButton businessId={row.businessId} /></div>
              </Td>
            </Tr>
          ))
        )}
      </TableCard>
      <Pagination path="/admin/billing" params={current} page={list.page} pageSize={list.pageSize} total={list.total} />

      {detail && (
        <p className="text-[13px] text-slate-700">
          Showing billing for <Link className={linkClass} href={`/admin/businesses/${detail.businessId}`}>{detail.businessName}</Link>.
        </p>
      )}
      {detail && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="Payments">
            {detail.payments.length === 0 ? <EmptyNote>No subscription payments.</EmptyNote> : (
              <ul className={listClass}>
                {detail.payments.map((payment) => (
                  <li key={payment.id} className="py-2">
                    <p className="font-medium text-slate-900">{formatPrice(payment.amount, payment.currency)} <Badge value={payment.status} /></p>
                    {payment.refundedAmount > 0 && <p className="text-xs text-slate-600">Refunded {formatPrice(payment.refundedAmount, payment.currency)}</p>}
                    <p className={monoClass}>{payment.providerPaymentId}</p>
                    <p className="text-xs text-slate-500">{formatDate(payment.paidAt ?? payment.createdAt, true)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Refunds and disputes">
            {detail.adjustments.length === 0 ? <EmptyNote>None reported.</EmptyNote> : (
              <ul className={listClass}>
                {detail.adjustments.map((item) => (
                  <li key={item.id} className="py-2">
                    <p className="font-medium capitalize text-slate-900">{item.kind}: {formatPrice(item.amount, item.currency)} <Badge value={item.status} /></p>
                    <p className={monoClass}>{item.providerId}</p>
                    {item.respondBy && <p className="text-xs text-amber-800">Respond by {formatDate(item.respondBy)}, in Razorpay&apos;s dashboard</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Events acted on">
            {detail.events.length === 0 ? <EmptyNote>No events yet.</EmptyNote> : (
              <ul className={listClass}>
                {detail.events.map((event) => (
                  <li key={event.id} className="py-2">
                    <p className="font-medium text-slate-900">{event.type}</p>
                    <p className="text-xs text-slate-500">{event.outcome.replace(/_/g, " ")} · Razorpay said {event.remoteStatus || "—"} · {formatDate(event.createdAt, true)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <Card title="Scheduled reconciliation">
        {reconcileJob.lastStartedAt ? (
          <div className="space-y-2 text-[13px] text-slate-700">
            <p>
              {reconcileJob.running ? "A run is going now. " : ""}Last run {formatDate(reconcileJob.lastStartedAt, true)}
              {reconcileJob.lastOutcome ? `: ${reconcileJob.lastOutcome}` : ""}.
              {reconcileJob.overlapsSkipped > 0 ? ` ${reconcileJob.overlapsSkipped} calls were skipped because a run was already going.` : ""}
            </p>
            <ul className={listClass}>
              {reconcileJob.recent.slice(0, 5).map((run) => (
                <li key={new Date(run.startedAt).toISOString()} className="flex flex-wrap items-center gap-2 py-2">
                  <Badge value={run.outcome} />
                  <span>{formatDate(run.startedAt, true)}</span>
                  <span className="text-xs text-slate-500">
                    {run.checked} checked, {run.changed} changed, {run.failed} failed{run.stoppedEarly ? ", stopped at its time limit" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyNote>No scheduled run has been recorded. Nothing is checked on a schedule until a scheduler is set up (docs/scheduled-jobs.md).</EmptyNote>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Integrations">
          <ul className={listClass}>
            {integrationStatuses().map((item) => (
              <li key={item.key} className="py-2">
                <p className="font-medium text-slate-900">{item.label} <Badge value={item.configured ? "active" : "inactive"} label={item.configured ? "Settings present" : "Not set up"} /></p>
                <p className="text-xs text-slate-500">{item.note}</p>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Database readiness">
          <ul className={listClass}>
            {readiness.map(({ feature, missing }) => (
              <li key={feature} className="py-2">
                <p className="font-medium text-slate-900">{FEATURE_LABELS[feature]} <Badge value={missing.length === 0 ? "active" : "inactive"} label={missing.length === 0 ? "Ready" : "Off until indexes exist"} /></p>
                {missing.map((item) => <p key={item} className={monoClass}>{item}</p>)}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
