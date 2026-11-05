import Link from "next/link";
import { PAYMENT_STATUSES } from "@/lib/constants";
import { DISPUTE_STATUSES } from "@/models/PaymentDispute";
import { formatPrice } from "@/lib/format";
import { ORDER_PAYMENT_STATUS_FILTERS, listAdminPayments, paymentQuerySchema } from "@/lib/admin/control-center";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import {
  Badge,
  EmptyRow,
  FilterActions,
  FilterBar,
  FilterField,
  PageTitle,
  Pagination,
  TableCard,
  Td,
  Th,
  Tr,
  formatDate,
  hrefWith,
  inputClass,
  linkClass,
  monoClass,
  segmentClass,
  segmentedClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSuperAdminPage();
  const query = paymentQuerySchema.parse(singleParams(await searchParams));
  const result = await listAdminPayments(query);
  const current = { domain: query.domain, status: query.status, review: query.review, business: query.business };
  const statuses: readonly string[] =
    query.domain === "order" ? ORDER_PAYMENT_STATUS_FILTERS : query.domain === "dispute" ? ["open_any", ...DISPUTE_STATUSES] : PAYMENT_STATUSES;

  return (
    <div className="space-y-5">
      <PageTitle
        title="Payment records"
        description="Read-only. Payment state changes only through provider-verified flows; there is no admin control to mark anything paid or refunded."
      />
      <div className={segmentedClass} role="tablist" aria-label="Payment type">
        {(["subscription", "order", "dispute"] as const).map((domain) => (
          <Link
            key={domain}
            role="tab"
            aria-selected={query.domain === domain}
            href={hrefWith("/admin/payments", {}, { domain })}
            className={segmentClass(query.domain === domain)}
          >
            {domain === "subscription" ? "Subscription billing" : domain === "order" ? "Store orders (online)" : "Disputes"}
          </Link>
        ))}
      </div>

      <FilterBar className="sm:flex sm:flex-wrap sm:items-end">
        <input type="hidden" name="domain" value={query.domain} />
        {query.business && <input type="hidden" name="business" value={query.business} />}
        <FilterField label="Status" className="sm:w-56">
          <select name="status" defaultValue={query.status ?? ""} className={inputClass}>
            <option value="">Any</option>
            {statuses.map((s) => <option key={s} value={s}>{s === "open_any" ? "open or under review" : s.replace("_", " ")}</option>)}
          </select>
        </FilterField>
        {query.domain === "order" && (
          <label className="flex min-h-10 items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="review" value="1" defaultChecked={query.review === "1"} className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1" /> Needs review only
          </label>
        )}
        <FilterActions label="Apply" />
        {query.business && (
          <Link href={hrefWith("/admin/payments", { domain: query.domain }, {})} className={`inline-flex min-h-10 items-center text-[13px] ${linkClass}`}>Clear business filter</Link>
        )}
      </FilterBar>

      {result.domain === "dispute" ? (
        <TableCard
          label="Disputes"
          minWidth="min-w-[960px]"
          head={
            <>
              <Th>Dispute</Th>
              <Th>Business / order</Th>
              <Th right>Disputed</Th>
              <Th>Status</Th>
              <Th>Reason / phase</Th>
              <Th>Respond by</Th>
              <Th>Last synced</Th>
            </>
          }
        >
          {result.records.length === 0 && <EmptyRow colSpan={7} title="No disputes have been reported by Razorpay." />}
          {result.records.map((r) => (
            <Tr key={r.id}>
              <Td><Link href={`/admin/disputes/${r.id}`} className={`${linkClass} font-mono text-xs`}>{r.reference}</Link></Td>
              <Td>{r.business ? <Link href={`/admin/businesses/${r.business.id}`} className={linkClass}>{r.business.name}</Link> : "—"}
                {r.order && <span className="block text-xs text-slate-500">Order #{r.order.number}</span>}</Td>
              <Td right>{formatPrice(r.amount, r.currency)}
                {r.amountDeducted > 0 && <span className="block text-xs text-red-700">deducted {formatPrice(r.amountDeducted, r.currency)}</span>}</Td>
              <Td><Badge value={r.status === "open" || r.status === "under_review" ? "pending" : r.status === "lost" ? "failed" : r.status === "won" ? "succeeded" : "canceled"} label={r.status.replace("_", " ")} /></Td>
              <Td className="text-xs text-slate-600">{r.reasonCode || "—"}<span className="block">{r.phase || ""}</span></Td>
              <Td className="whitespace-nowrap text-xs">{formatDate(r.respondBy, true)}</Td>
              <Td className="whitespace-nowrap text-xs text-slate-500">{formatDate(r.lastSyncedAt, true)}</Td>
            </Tr>
          ))}
        </TableCard>
      ) : result.domain === "subscription" ? (
        <TableCard
          label="Subscription billing records"
          minWidth="min-w-[820px]"
          head={
            <>
              <Th>Business</Th>
              <Th right>Amount</Th>
              <Th>Status</Th>
              <Th>Provider</Th>
              <Th>Reference</Th>
              <Th>Paid / created</Th>
            </>
          }
        >
          {result.records.length === 0 && <EmptyRow colSpan={6} title="No payment records." />}
          {result.records.map((r) => (
            <Tr key={r.id}>
              <Td>{r.business ? <Link href={`/admin/businesses/${r.business.id}`} className={linkClass}>{r.business.name}</Link> : "—"}
                {r.description && <span className="block text-xs text-slate-500">{r.description}</span>}</Td>
              <Td right>{formatPrice(r.amount, r.currency)}</Td>
              <Td><Badge value={r.status} /></Td>
              <Td>
                <span className="flex flex-wrap items-center gap-1.5">
                  {r.provider} {r.verified ? <Badge value="verified" label="provider" /> : <Badge value="unverified" label="manual — not real money" />}
                </span>
              </Td>
              <Td className={monoClass}>{r.reference || "—"}</Td>
              <Td className="whitespace-nowrap text-xs text-slate-500">{formatDate(r.paidAt, true)}<span className="block">{formatDate(r.createdAt, true)}</span></Td>
            </Tr>
          ))}
        </TableCard>
      ) : (
        <TableCard
          label="Online store order payments"
          minWidth="min-w-[900px]"
          head={
            <>
              <Th>Business</Th>
              <Th>Order</Th>
              <Th right>Amount</Th>
              <Th>Payment</Th>
              <Th>Outcome</Th>
              <Th>Razorpay references</Th>
              <Th>Paid / created</Th>
            </>
          }
        >
          {result.records.length === 0 && <EmptyRow colSpan={7} title="No online order payments." />}
          {result.records.map((r) => (
            <Tr key={r.id}>
              <Td>{r.business ? <Link href={`/admin/businesses/${r.business.id}`} className={linkClass}>{r.business.name}</Link> : "—"}</Td>
              <Td>
                {r.order ? (
                  <span className="flex flex-wrap items-center gap-1.5">#{r.order.number} <Badge value={r.order.status} /></span>
                ) : "—"}
              </Td>
              <Td right>{formatPrice(r.amount, r.currency)}</Td>
              <Td>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge value={r.status} /> <Badge value={r.mode} label={`${r.mode} mode`} />
                </span>
              </Td>
              <Td>{r.orderOutcome ? <Badge value={r.orderOutcome} /> : <span className="text-slate-500">—</span>}
                {r.outcomeReason && <span className="mt-0.5 block text-xs text-slate-500">{r.outcomeReason}</span>}</Td>
              <Td className={monoClass}>{r.reference}{r.providerPaymentId && <span className="block">{r.providerPaymentId}</span>}</Td>
              <Td className="whitespace-nowrap text-xs text-slate-500">{formatDate(r.paidAt, true)}<span className="block">{formatDate(r.createdAt, true)}</span></Td>
            </Tr>
          ))}
        </TableCard>
      )}
      <Pagination path="/admin/payments" params={current} page={result.page} pageSize={result.pageSize} total={result.total} />
      <p className="text-xs leading-5 text-slate-500">
        Disputes are recorded only from Razorpay&apos;s signed dispute webhooks for online store-order payments, re-read from the Razorpay API; statuses
        are never set here. Subscription billing has no provider, so it has no disputes. Cash-on-delivery orders have no payment record; they appear in
        each business&apos;s order counts.
      </p>
    </div>
  );
}
