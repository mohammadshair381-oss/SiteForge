import Link from "next/link";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { formatPrice } from "@/lib/format";
import { getDisputeDetail } from "@/lib/payments/disputes";
import { requireSuperAdminPage } from "@/lib/admin/page-access";
import DisputeNoteForm from "@/components/admin/DisputeNoteForm";
import { Badge, Card, DetailRow, PageTitle, detailListClass, formatDate, linkClass, listClass, monoClass } from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

export default async function AdminDisputePage({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdminPage();
  const { id } = await params;
  await dbConnect();
  let d;
  try {
    d = await getDisputeDetail(id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="space-y-5">
      <p className="text-[13px]"><Link href="/admin/payments?domain=dispute" className={linkClass}>← All disputes</Link></p>
      <PageTitle
        title={`Dispute ${d.reference}`}
        description="Status, amounts and dates come only from Razorpay (signed webhook, then re-read from the Razorpay API). Respond to the dispute in the business's Razorpay dashboard; SiteForge cannot submit evidence or change the outcome."
      >
        <Badge value={d.status === "open" || d.status === "under_review" ? "pending" : d.status === "lost" ? "failed" : d.status === "won" ? "succeeded" : "canceled"} label={d.status.replace("_", " ")} />
      </PageTitle>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Payment">
          <dl className={detailListClass}>
            <DetailRow label="Disputed"><span className="font-semibold">{formatPrice(d.amount, d.currency)}</span></DetailRow>
            <DetailRow label="Deducted by provider">{formatPrice(d.amountDeducted, d.currency)}</DetailRow>
            <DetailRow label="Razorpay payment"><span className={monoClass}>{d.providerPaymentId}</span></DetailRow>
            <DetailRow label="Mode">{d.mode}</DetailRow>
          </dl>
        </Card>
        <Card title="Business and order">
          {d.business ? <p className="text-[13px]"><Link className={linkClass} href={`/admin/businesses/${d.business.id}`}>{d.business.name}</Link></p> : <p className="text-[13px] text-slate-500">—</p>}
          {d.order && <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-slate-700">Order #{d.order.number} · <Badge value={d.order.status} /> · {formatPrice(d.order.total, d.order.currency || d.currency)}</p>}
          <p className="mt-3 text-xs text-slate-500">The order status is not changed by a dispute.</p>
        </Card>
        <Card title="Dates (UTC)">
          <dl className={detailListClass}>
            <DetailRow label="Opened">{formatDate(d.openedAt, true)}</DetailRow>
            <DetailRow label="Respond by"><span className="font-semibold">{formatDate(d.respondBy, true)}</span></DetailRow>
            <DetailRow label="Closed">{formatDate(d.closedAt, true)}</DetailRow>
            <DetailRow label="Last synced">{formatDate(d.lastSyncedAt, true)}</DetailRow>
          </dl>
          <p className="mt-3 text-xs text-slate-500">Reason: {d.reasonCode || "—"} · Phase: {d.phase || "—"}</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="History" className="lg:col-span-2">
          <ol className={listClass}>
            {d.history.map((h, i) => (
              <li key={i} className="py-2">
                <p>
                  <span className="text-xs text-slate-500">{formatDate(h.at, true)}</span>{" "}
                  {h.source === "provider" ? (
                    <>Razorpay reported <strong className="font-semibold text-slate-900">{h.status?.replace("_", " ")}</strong>{h.phase ? ` (${h.phase})` : ""}</>
                  ) : (
                    <>Note by <strong className="font-semibold text-slate-900">{h.actorName ?? "admin"}</strong></>
                  )}
                </p>
                {h.note && <p className="mt-1 whitespace-pre-wrap break-words text-slate-700">{h.note}</p>}
              </li>
            ))}
          </ol>
        </Card>
        <Card title="Add an internal note">
          <DisputeNoteForm disputeId={d.id} />
        </Card>
      </div>
    </div>
  );
}
