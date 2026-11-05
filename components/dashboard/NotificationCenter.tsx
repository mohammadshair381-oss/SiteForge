"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill, Skeleton, type Tone } from "@/components/ui/Surface";
import type { NotificationPage, NotificationView } from "@/lib/notifications";

const KINDS: Array<{ value: string; label: string }> = [
  { value: "", label: "Everything" },
  { value: "order", label: "Orders" },
  { value: "payment", label: "Payments" },
  { value: "refund", label: "Refunds" },
  { value: "stock", label: "Stock" },
  { value: "subscription", label: "Subscription" },
  { value: "usage", label: "Plan limits" },
  { value: "domain", label: "Domains" },
  { value: "team", label: "Team" },
  { value: "store", label: "Store" },
];

const SEVERITY: Record<NotificationView["severity"], { tone: Tone; label: string }> = {
  info: { tone: "info", label: "Update" },
  success: { tone: "success", label: "Done" },
  warning: { tone: "warning", label: "Attention" },
  danger: { tone: "danger", label: "Urgent" },
};

/** The notification history for this store, filtered to what this person's role may see. */
export default function NotificationCenter({ businessId }: { businessId: string }) {
  const [data, setData] = useState<NotificationPage | null>(null);
  const [items, setItems] = useState<NotificationView[]>([]);
  const [kind, setKind] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ page: String(nextPage) });
        if (kind) params.set("kind", kind);
        if (unreadOnly) params.set("unread", "1");
        const res = await fetch(`/api/businesses/${businessId}/notifications?${params.toString()}`, { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as NotificationPage & { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Notifications could not be loaded.");
        setData(body);
        setItems((current) => (append ? [...current, ...body.notifications] : body.notifications));
        setPage(nextPage);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Notifications could not be loaded.");
      } finally {
        setLoading(false);
      }
    },
    [businessId, kind, unreadOnly],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  async function mark(ids?: string[]) {
    setBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/notifications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids ? { ids } : {}) });
      if (!res.ok) throw new Error();
      const read = ids ? new Set(ids) : null;
      setItems((current) => current.map((item) => (!read || read.has(item.id) ? { ...item, read: true } : item)));
      setData((current) => (current ? { ...current, unread: read ? Math.max(0, current.unread - read.size) : 0 } : current));
    } catch {
      setError("That could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <ManagementPageHeader
      title="Notifications"
      description="What has happened at this store: orders, payments, stock, your plan and more. These only appear here: no emails are sent from this page."
      actions={data?.ready && data.unread > 0 ? <Button variant="secondary" disabled={busy} onClick={() => void mark()}>Mark all as read</Button> : undefined}
    />
  );

  if (data && !data.ready) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="info">Notifications are not switched on yet, because a database step has not been done. Nothing is lost: when they start, the last 7 days of orders and payments appear here.</Notice>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-700">
          Show
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block min-h-10 rounded-lg border px-3 py-2 text-sm text-slate-900">
            {KINDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} className="h-4 w-4" />
          Unread only
        </label>
      </div>

      {error && <Notice tone="danger" role="alert" action={<Button variant="secondary" onClick={() => void load(1, false)}>Try again</Button>}>{error}</Notice>}

      {loading && items.length === 0 ? (
        <Card className="space-y-3 p-5">
          <p role="status" className="sr-only">Loading notifications…</p>
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </Card>
      ) : items.length === 0 ? (
        !error && (
          <EmptyState icon={<Icon name="notifications" size={20} />} title={unreadOnly || kind ? "Nothing matches" : "No notifications yet"}>
            {unreadOnly || kind ? "Try showing everything." : "New orders, payments and anything that needs your attention will appear here."}
          </EmptyState>
        )
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <li key={item.id} className={`flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6 ${item.read ? "" : "bg-slate-50"}`}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                    {!item.read && <span className="sr-only">Unread: </span>}
                    <span className="min-w-0 break-words">{item.title}</span>
                    <Pill tone={SEVERITY[item.severity].tone}>{SEVERITY[item.severity].label}</Pill>
                  </p>
                  {item.body && <p className="mt-1 break-words text-sm text-slate-600">{item.body}</p>}
                  <p className="mt-1 text-xs text-slate-500">{new Date(item.occurredAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {item.link && (
                    <Link href={item.link} onClick={() => { if (!item.read) void mark([item.id]); }} className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium text-slate-700 underline underline-offset-2 hover:text-slate-950">
                      View
                    </Link>
                  )}
                  {!item.read && <Button variant="ghost" disabled={busy} onClick={() => void mark([item.id])}>Mark as read</Button>}
                </div>
              </li>
            ))}
          </ul>
          {data?.hasMore && (
            <div className="border-t border-slate-200 p-4 text-center">
              <Button variant="secondary" disabled={loading} onClick={() => void load(page + 1, true)}>{loading ? "Loading…" : "Show older"}</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
