import Link from "next/link";
import { dbConnect } from "@/lib/db";
import { auditFilter, auditQuerySchema } from "@/lib/admin/control-center";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import { AdminAuditLog, ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_TARGET_TYPES } from "@/models/AdminAuditLog";
import { User } from "@/models/User";
import {
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
  inputClass,
  linkClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

function describe(value: Record<string, unknown> | null): string {
  if (!value) return "—";
  return Object.entries(value).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSuperAdminPage();
  const query = auditQuerySchema.parse(singleParams(await searchParams));
  const filter = auditFilter(query);
  await dbConnect();
  const [entries, total] = await Promise.all([
    AdminAuditLog.find(filter).sort({ _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit)
      .populate({ path: "actor", select: "name email", model: User }).lean(),
    AdminAuditLog.countDocuments(filter),
  ]);
  const current = { action: query.action, targetType: query.targetType, targetId: query.targetId, actor: query.actor, from: query.from, to: query.to };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Audit log"
        description="Append-only record of sensitive admin actions (written in the same transaction as the action). Records cannot be edited or deleted through the application. Secrets, passwords and request bodies are never recorded."
      />
      <FilterBar className="sm:grid-cols-2 lg:grid-cols-5">
        <FilterField label="Action">
          <select name="action" defaultValue={query.action ?? ""} className={inputClass}>
            <option value="">Any</option>
            {ADMIN_AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </FilterField>
        <FilterField label="Target type">
          <select name="targetType" defaultValue={query.targetType ?? ""} className={inputClass}>
            <option value="">Any</option>
            {ADMIN_AUDIT_TARGET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </FilterField>
        <FilterField label="Target id / plan key">
          <input name="targetId" defaultValue={query.targetId ?? ""} maxLength={80} className={inputClass} />
        </FilterField>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={query.from ?? ""} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={query.to ?? ""} className={inputClass} />
        </FilterField>
        {query.actor && <input type="hidden" name="actor" value={query.actor} />}
        <FilterActions resetHref="/admin/audit" className="sm:col-span-2 lg:col-span-5" />
      </FilterBar>

      <TableCard
        label="Audit records"
        minWidth="min-w-[900px]"
        head={
          <>
            <Th>When (UTC)</Th>
            <Th>Actor</Th>
            <Th>Action</Th>
            <Th>Target</Th>
            <Th>Change</Th>
            <Th>Reason</Th>
          </>
        }
      >
        {entries.length === 0 && (
          <EmptyRow colSpan={6} title="No audit records match these filters.">Try a wider date range, or reset the filters.</EmptyRow>
        )}
        {entries.map((e) => {
          const actor = e.actor as unknown as { _id?: unknown; name?: string; email?: string } | null;
          return (
            <Tr key={String(e._id)}>
              <Td className="whitespace-nowrap text-xs text-slate-500">{formatDate(e.createdAt, true)}</Td>
              <Td>
                {actor?._id ? (
                  <Link href={`/admin/audit?actor=${String(actor._id)}`} className={linkClass}>{actor.name || actor.email}</Link>
                ) : <span className="text-slate-500">unknown</span>}
              </Td>
              <Td className="font-mono text-xs font-medium text-slate-900">{e.action}</Td>
              <Td>
                {e.targetType === "business" ? (
                  <Link href={`/admin/businesses/${e.targetId}`} className={linkClass}>{e.targetLabel || e.targetId}</Link>
                ) : <span>{e.targetLabel || e.targetId} <span className="text-xs text-slate-500">({e.targetId})</span></span>}
              </Td>
              <Td className="max-w-xs break-words text-xs text-slate-600">
                <span className="block"><span className="text-slate-500">Before:</span> {describe(e.before)}</span>
                <span className="mt-0.5 block"><span className="text-slate-500">After:</span> {describe(e.after)}</span>
              </Td>
              <Td className="max-w-xs break-words text-xs text-slate-600">{e.reason || "—"}</Td>
            </Tr>
          );
        })}
      </TableCard>
      <Pagination path="/admin/audit" params={current} page={query.page} pageSize={query.limit} total={total} />
    </div>
  );
}
