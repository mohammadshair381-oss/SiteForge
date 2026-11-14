"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { Button, ButtonLink } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill, cardClass, type Tone } from "@/components/ui/Surface";

export interface InventoryItem {
  productId: string;
  productName: string;
  productStatus: string;
  variantId: string | null;
  label: string;
  sku: string;
  stock: number;
  threshold: number;
  state: "in_stock" | "low_stock" | "out_of_stock";
}

interface Movement {
  id: string;
  variantId: string | null;
  delta: number;
  stockAfter: number | null;
  reason: string;
  orderId: string | null;
  note: string;
  createdAt: string;
}

const REASONS = [
  { value: "restock", label: "Restock (received goods)" },
  { value: "adjustment", label: "Adjustment" },
  { value: "damage", label: "Damaged / lost" },
  { value: "correction", label: "Stock count correction" },
] as const;

const REASON_LABELS: Record<string, string> = {
  order_reserved: "Order placed",
  order_released: "Order cancelled / expired",
  adjustment: "Adjustment",
  restock: "Restock",
  damage: "Damaged / lost",
  correction: "Count correction",
  initial: "Initial stock",
  variants_created: "Converted to variants",
  product_restored: "Restored from archive",
};

const STATE_TONE: Record<InventoryItem["state"], Tone> = {
  in_stock: "success",
  low_stock: "warning",
  out_of_stock: "danger",
};
const STATE_LABEL: Record<InventoryItem["state"], string> = { in_stock: "In stock", low_stock: "Low stock", out_of_stock: "Out of stock" };

const segmentClass = (selected: boolean) =>
  `inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
    selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
  }`;

/** Shared by the list header and its rows, so the columns line up. */
const rowGridClass = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 md:grid-cols-[minmax(0,1fr)_7.5rem_4.5rem_12rem] md:gap-x-4";

/**
 * Stock per product/variant with low-stock state, atomic adjustments
 * (add/remove or set a counted amount) and the stock history. Exact numbers
 * are shown here only; shoppers see availability.
 */
export default function InventoryManager({ businessId, initialItems }: { businessId: string; initialItems: InventoryItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [filter, setFilter] = useState<"all" | "low" | "out">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<{ productId: string; rows: Movement[] } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const historyRef = useRef<HTMLElement>(null);
  const historyProductId = history?.productId ?? null;

  const shown = useMemo(
    () =>
      items.filter((i) => {
        if (filter === "low" && i.state !== "low_stock") return false;
        if (filter === "out" && i.state !== "out_of_stock") return false;
        const q = query.trim().toLowerCase();
        return !q || `${i.productName} ${i.label} ${i.sku}`.toLowerCase().includes(q);
      }),
    [items, filter, query],
  );
  const counts = { low: items.filter((i) => i.state === "low_stock").length, out: items.filter((i) => i.state === "out_of_stock").length };

  // The history panel sits below the list: bring it into view when it opens.
  useEffect(() => {
    if (historyProductId) historyRef.current?.scrollIntoView({ block: "nearest" });
  }, [historyProductId]);

  async function reload() {
    try {
      const res = await fetch(`/api/businesses/${businessId}/inventory`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      setItems((await res.json()).items);
    } catch {
      setMessage({ ok: false, text: "Could not refresh the stock list. Please reload the page." });
    }
  }

  async function loadHistory(productId: string) {
    try {
      const res = await fetch(`/api/businesses/${businessId}/inventory/${productId}/movements`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error();
      setHistory({ productId, rows: data.movements });
    } catch {
      setMessage({ ok: false, text: "Could not load the stock history. Please try again." });
    }
  }

  async function submit(item: InventoryItem, form: HTMLFormElement) {
    if (saving) return;
    setMessage(null);
    const data = new FormData(form);
    const mode = String(data.get("mode"));
    const amount = Math.trunc(Number(data.get("amount")));
    if (!Number.isFinite(amount) || (mode !== "set" && amount <= 0) || amount < 0) {
      setMessage({ ok: false, text: "Enter a whole number." });
      return;
    }
    const body = {
      productId: item.productId,
      variantId: item.variantId,
      reason: String(data.get("reason")),
      note: String(data.get("note") ?? ""),
      ...(mode === "set" ? { set: amount, expected: item.stock } : { delta: mode === "remove" ? -amount : amount }),
    };
    setSaving(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/inventory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: result.error || "Could not adjust stock." });
        if (result.code === "stock_changed") await reload();
        return;
      }
      setMessage({ ok: true, text: `${item.productName}${item.label ? ` (${item.label})` : ""}: stock is now ${result.stock}.` });
      setOpen(null);
      await reload();
      if (history?.productId === item.productId) await loadHistory(item.productId);
    } catch {
      setMessage({ ok: false, text: "Could not reach the server. The stock was not changed." });
    } finally {
      setSaving(false);
    }
  }

  const rowKey = (i: InventoryItem) => `${i.productId}:${i.variantId ?? ""}`;

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Inventory"
        description="Stock for every product and variant. Checkouts reserve stock and cancellations return it automatically; use adjustments for deliveries, damage and stock counts. Every change is recorded."
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<Icon name="inventory" size={20} />}
          title="No products to track yet"
          action={<ButtonLink href={`/dashboard/businesses/${businessId}/products`}>Go to products</ButtonLink>}
        >
          Once you add a product, its stock appears here so you can record deliveries, damage and stock counts.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="ui-scroll-x flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg border bg-slate-100 p-0.5">
              {([["all", `All (${items.length})`], ["low", `Low (${counts.low})`], ["out", `Out of stock (${counts.out})`]] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={segmentClass(filter === key)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="block w-full sm:w-64">
              <span className="sr-only">Search inventory</span>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or SKU" className={inputClass} />
            </label>
          </div>

          {message && (
            <Notice tone={message.ok ? "success" : "danger"} role="status">
              {message.text}
            </Notice>
          )}

          <Card as="section" aria-label="Stock levels">
            {shown.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <Icon name="search" size={28} className="mx-auto text-slate-400" />
                <h2 className="mt-3 text-base font-semibold text-slate-900">Nothing matches</h2>
                <p className="mt-1 text-sm text-slate-600">Try a different search, or show every product again.</p>
                <Button
                  variant="secondary"
                  className="mt-4"
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                >
                  Show all stock
                </Button>
              </div>
            ) : (
              <>
                <div aria-hidden="true" className={`${rowGridClass} hidden rounded-t-2xl bg-slate-50 px-5 py-2.5 text-xs font-medium text-slate-500 md:grid`}>
                  <span>Product</span>
                  <span>State</span>
                  <span className="text-right">In stock</span>
                  <span />
                </div>
                <ul className="divide-y divide-slate-100">
                  {shown.map((item) => (
                    <li key={rowKey(item)} className="px-4 py-4 sm:px-5 md:py-3">
                      <div className={rowGridClass}>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{item.productName}</p>
                          <p className="truncate text-xs text-slate-500">{[item.label, item.sku && `SKU ${item.sku}`, item.productStatus !== "active" && item.productStatus].filter(Boolean).join(" · ") || "No variants"}</p>
                        </div>
                        <div className="col-start-1 row-start-2 md:col-start-2 md:row-start-1">
                          <Pill tone={STATE_TONE[item.state]} dot>{STATE_LABEL[item.state]}</Pill>
                        </div>
                        <span className="col-start-2 row-span-2 row-start-1 text-right font-heading text-xl font-semibold tabular-nums text-slate-900 md:col-start-3 md:row-span-1" aria-label={`${item.stock} in stock`}>{item.stock}</span>
                        <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1 md:col-start-4 md:row-start-1 md:justify-end">
                          <Button variant="secondary" aria-expanded={open === rowKey(item)} onClick={() => setOpen(open === rowKey(item) ? null : rowKey(item))}>
                            Adjust
                          </Button>
                          <Button variant="ghost" onClick={() => void loadHistory(item.productId)}>
                            History
                          </Button>
                        </div>
                      </div>
                      {open === rowKey(item) && (
                        <form
                          className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-[auto_6rem_auto_minmax(10rem,1fr)_auto] lg:items-end sm:p-4"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void submit(item, e.currentTarget);
                          }}
                        >
                          <label className="block text-sm font-medium text-slate-800">
                            Change
                            <select name="mode" className={`mt-1.5 ${inputClass}`} defaultValue="add">
                              <option value="add">Add</option>
                              <option value="remove">Remove</option>
                              <option value="set">Set counted amount</option>
                            </select>
                          </label>
                          <label className="block text-sm font-medium text-slate-800">
                            Amount
                            <input name="amount" type="number" min={0} step={1} required className={`mt-1.5 ${inputClass}`} />
                          </label>
                          <label className="block text-sm font-medium text-slate-800">
                            Reason
                            <select name="reason" className={`mt-1.5 ${inputClass}`} defaultValue="restock">
                              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          </label>
                          <label className="block text-sm font-medium text-slate-800">
                            Note (optional)
                            <input name="note" maxLength={200} className={`mt-1.5 ${inputClass}`} />
                          </label>
                          <Button type="submit" disabled={saving} aria-busy={saving}>{saving ? "Saving…" : "Save"}</Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          {history && (
            <section ref={historyRef} aria-labelledby="inv-history" className={`${cardClass} scroll-mt-44 lg:scroll-mt-32`}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
                <h2 id="inv-history" className="min-w-0 text-lg font-semibold text-slate-900">
                  Stock history: {items.find((i) => i.productId === history.productId)?.productName ?? "product"}
                </h2>
                <Button variant="ghost" onClick={() => setHistory(null)}>Close</Button>
              </div>
              {history.rows.length === 0 ? (
                <p className="px-4 py-6 text-sm text-slate-600 sm:px-5">No recorded changes yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                      <tr>
                        <th scope="col" className="px-4 py-2.5 font-medium sm:pl-5">When</th>
                        <th scope="col" className="px-4 py-2.5 font-medium">Variant</th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">Change</th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">After</th>
                        <th scope="col" className="px-4 py-2.5 font-medium sm:pr-5">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {history.rows.map((m) => (
                        <tr key={m.id} className="hover:bg-slate-50">
                          <td className="whitespace-nowrap px-4 py-2.5 text-slate-600 sm:pl-5">{new Date(m.createdAt).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-slate-700">{m.variantId ? items.find((i) => i.variantId === m.variantId)?.label ?? "Archived variant" : "—"}</td>
                          <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${m.delta < 0 ? "text-red-700" : "text-emerald-700"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{m.stockAfter ?? "—"}</td>
                          <td className="px-4 py-2.5 text-slate-700 sm:pr-5">{REASON_LABELS[m.reason] ?? m.reason}{m.note ? <span className="block text-xs text-slate-500">{m.note}</span> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
