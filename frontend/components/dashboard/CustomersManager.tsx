"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { formatPrice } from "@/lib/format";
import { Button, focusRing } from "@/components/ui/Button";
import { inputClass, labelClass } from "@/components/ui/Field";
import { Card, EmptyState, Notice, Skeleton } from "@/components/ui/Surface";

// tests/unit/customers.test.ts imports this module directly (no React global),
// so nothing imported here may create JSX at module level. That rules out
// `components/ui/Icon` and `components/ui/Toast`.

interface CustomerTotal {
  currency: string;
  paid: number;
  pending: number;
}

export interface CustomerSummaryView {
  id: string;
  name: string;
  email: string;
  orderCount: number;
  paidOrderCount: number;
  totals: CustomerTotal[];
  firstOrderAt: string;
  lastOrderAt: string;
}

const PAGE_SIZE = 20;

/** Shared by the list header and its rows, so the columns line up. */
const rowGridClass = "grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 lg:grid-cols-[2.5rem_minmax(0,1.3fr)_5rem_7rem_minmax(0,1.2fr)] lg:gap-x-4";

/** "USD 40.00 paid · USD 10.00 awaiting payment", one line per currency. */
export function formatCustomerTotals(totals: CustomerTotal[]): string[] {
  if (totals.length === 0) return ["—"];
  return totals.map((t) => {
    const parts = [`${formatPrice(t.paid, t.currency || "USD")} paid`];
    if (t.pending > 0) parts.push(`${formatPrice(t.pending, t.currency || "USD")} awaiting payment`);
    return parts.join(" · ");
  });
}

export default function CustomersManager({ businessId }: { businessId: string }) {
  const searchId = useId();
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [customers, setCustomers] = useState<CustomerSummaryView[]>([]);
  const [total, setTotal] = useState(0);
  const [unidentified, setUnidentified] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the latest request may update the list (fast paging/searching).
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      const res = await fetch(`/api/businesses/${businessId}/manage/customers?${params.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== requestSeq.current) return;
      if (!res.ok) throw new Error(data.error ?? "Unable to load customers");
      setCustomers(data.customers ?? []);
      setTotal(data.total ?? 0);
      setUnidentified(data.unidentifiedOrderCount ?? 0);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err instanceof Error ? err.message : "Unable to load customers");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [businessId, page, query]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(searchInput.trim().slice(0, 100));
  }

  function clearSearch() {
    setSearchInput("");
    setQuery("");
    setPage(1);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Customers"
        description="People who have ordered from your storefront, grouped by email address. Totals count paid orders; cancelled and refunded orders are listed but not counted."
      />

      <form onSubmit={submitSearch} className="flex flex-wrap items-end gap-2" role="search">
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor={searchId} className={labelClass}>
            Search customers
          </label>
          <input
            id={searchId}
            type="search"
            value={searchInput}
            maxLength={100}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Name or email"
            className={inputClass}
          />
        </div>
        <Button type="submit">Search</Button>
        {query && (
          <Button variant="secondary" onClick={clearSearch}>
            Clear
          </Button>
        )}
      </form>

      {loading ? (
        <Card>
          <p role="status" className="sr-only">Loading customers…</p>
          <ul aria-hidden="true" className="divide-y divide-slate-100">
            {Array.from({ length: 5 }, (_, index) => (
              <li key={index} className="flex items-center gap-3 px-4 py-4 sm:px-6">
                <Skeleton className="h-10 w-10 shrink-0 !rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : loadError ? (
        <Notice tone="danger" role="alert" title="Customers could not be loaded" action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>}>
          {loadError}
        </Notice>
      ) : customers.length === 0 ? (
        <EmptyState
          title={query ? "No customers match your search" : "No customers yet"}
          action={query ? <Button variant="secondary" onClick={clearSearch}>Clear search</Button> : undefined}
        >
          {query
            ? "Try a different name or email address."
            : "When shoppers place orders on your published storefront, they appear here automatically."}
        </EmptyState>
      ) : (
        <Card>
          <div aria-hidden="true" className={`${rowGridClass} hidden rounded-t-2xl bg-slate-50 px-6 py-2.5 text-xs font-medium text-slate-500 lg:grid`}>
            <span className="col-span-2">Customer</span>
            <span className="text-right">Orders</span>
            <span>Last order</span>
            <span className="text-right">Totals</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {customers.map((customer) => (
              <li key={customer.id}>
                <Link
                  href={`/dashboard/businesses/${businessId}/customers/${customer.id}`}
                  className={`${rowGridClass} px-4 py-4 transition-colors hover:bg-slate-50 sm:px-6 lg:py-3 ${focusRing} focus-visible:ring-inset`}
                >
                  <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 font-heading text-sm font-semibold text-slate-700">
                    {(customer.name || customer.email).trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="block min-w-0">
                    <span className="block truncate font-semibold text-slate-900">{customer.name || "Unnamed customer"}</span>
                    <span className="block break-all text-sm text-slate-600 lg:truncate lg:break-normal">{customer.email}</span>
                  </span>
                  <span className="col-start-2 text-xs text-slate-500 lg:col-start-3 lg:text-right lg:text-sm lg:tabular-nums lg:text-slate-900">
                    {customer.orderCount} <span className="lg:hidden">{customer.orderCount === 1 ? "order" : "orders"} · last order {new Date(customer.lastOrderAt).toLocaleDateString()}</span>
                  </span>
                  <span className="hidden text-sm text-slate-600 lg:block">{new Date(customer.lastOrderAt).toLocaleDateString()}</span>
                  <span className="col-start-2 block text-sm text-slate-700 lg:col-start-5 lg:text-right">
                    {formatCustomerTotals(customer.totals).map((line) => (
                      <span key={line} className="block">{line}</span>
                    ))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 text-sm sm:px-6">
              <span className="text-slate-500">
                Page {page} of {pages} · {total} {total === 1 ? "customer" : "customers"}
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  Previous
                </Button>
                <Button variant="secondary" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {!loading && !loadError && unidentified > 0 && (
        <p className="text-xs text-slate-500">
          {unidentified} {unidentified === 1 ? "older order has" : "older orders have"} no valid email address and
          {unidentified === 1 ? " is" : " are"} not grouped into a customer. You can still find {unidentified === 1 ? "it" : "them"} under Orders.
        </p>
      )}
    </div>
  );
}
