import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { formatPrice } from "@/lib/format";
import { buttonClass as uiButtonClass, focusRing } from "@/components/ui/Button";
import { Pill, cardClass, type Tone } from "@/components/ui/Surface";

/** Building blocks for the Super Admin control center: a dense operations console (docs/design-system.md). */

/**
 * The few glyphs this file needs, drawn like the platform set. Deliberately not
 * ui/Icon: that module builds JSX when it loads, and tests/integration/ai-builder-tools
 * statically imports an admin page (so this file) before it defines the global
 * React that the test runner's classic JSX needs.
 */
function Glyph({ d, size, className = "" }: { d: string; size: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d={d} />
    </svg>
  );
}
const GLYPH_ALERT = "M10.3 4 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0ZM12 10v4M12 17h0";
const GLYPH_CHEVRON = "m9 6 6 6-6 6";
const GLYPH_SEARCH = "M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0ZM20 20l-4.200-4.200";

export const inputClass =
  "mt-1 block min-h-10 w-full rounded-lg border px-3 py-2 text-sm font-normal text-slate-900 outline-none placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-500";
export const buttonClass = uiButtonClass();
export const secondaryButtonClass = uiButtonClass({ variant: "secondary" });
export const linkClass = `rounded font-medium text-brand-600 underline-offset-2 hover:text-brand-700 hover:underline ${focusRing}`;
export const monoClass = "break-all font-mono text-xs text-slate-600";

/** Compact table and card actions: 40px on touch screens, tighter with a mouse. */
const smallBase =
  "inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none [@media(pointer:fine)]:min-h-8";
export const smallButtonClass = `${smallBase} border-slate-300 text-slate-800 hover:border-slate-400 hover:bg-slate-50`;
export const dangerSmallButtonClass = `${smallBase} border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50`;

/** Segmented control: a period, a preset or a record type. */
export const segmentedClass = "flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-0.5";
export function segmentClass(active: boolean): string {
  return `inline-flex min-h-10 items-center whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 motion-reduce:transition-none [@media(pointer:fine)]:min-h-8 ${
    active ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
  }`;
}

export function PageTitle({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-slate-200 pb-4">
      <div className="min-w-0 max-w-full flex-1 basis-80">
        <h1 className="break-words text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[13px] leading-5 text-slate-600">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** A panel with a quiet title row. `flush` removes the padding, for tables and hairline grids. */
export function Card({
  title,
  action,
  flush = false,
  children,
  className = "",
}: {
  title?: string;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${cardClass} min-w-0 ${flush ? "overflow-hidden" : ""} ${className}`}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {action}
        </div>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

/** A band of KPI tiles divided by hairlines. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 shadow-sm sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function StatTile({
  label,
  value,
  detail,
  href,
  attention = false,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  href?: string;
  /** Marks a measured value that needs a look, with an icon and a label rather than colour alone. */
  attention?: boolean;
}) {
  const body = (
    <>
      <p className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
        <span className="min-w-0">{label}</span>
        {attention && (
          <span className="shrink-0 text-red-700">
            <Glyph d={GLYPH_ALERT} size={15} />
            <span className="sr-only">Needs attention</span>
          </span>
        )}
        {href && !attention && <Glyph d={GLYPH_CHEVRON} size={14} className="text-slate-400" />}
      </p>
      <p className="mt-1.5 break-words font-heading text-2xl font-semibold tracking-tight text-slate-900 [font-variant-numeric:tabular-nums]">{value}</p>
      {detail && <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>}
    </>
  );
  return href ? (
    <Link
      href={href}
      className="block min-w-0 bg-white p-4 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 motion-reduce:transition-none"
    >
      {body}
    </Link>
  ) : (
    <div className="min-w-0 bg-white p-4">{body}</div>
  );
}

const BADGE: Record<string, Tone> = {
  published: "success",
  active: "success",
  succeeded: "success",
  paid: "success",
  applied: "success",
  verified: "success",
  live: "success",
  trialing: "info",
  refunded: "info",
  pending: "warning",
  created: "warning",
  incomplete: "warning",
  past_due: "warning",
  unverified: "warning",
  test: "warning",
  invited: "warning",
  suspended: "danger",
  failed: "danger",
  needs_review: "danger",
  inactive: "danger",
  disabled: "danger",
  super_admin: "ember",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  const tone = BADGE[value] ?? "neutral";
  return (
    <Pill tone={tone} dot={tone !== "neutral" && tone !== "ember"}>
      {label ?? value.replace(/_/g, " ")}
    </Pill>
  );
}

export function formatDate(value: Date | string | null | undefined, withTime = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return withTime
    ? date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
    : date.toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
}

export function Money({ rows, empty = "None" }: { rows: Array<{ currency: string; amount: number; count: number }>; empty?: string }) {
  if (rows.length === 0) return <span className="text-slate-500">{empty}</span>;
  return (
    <ul className="space-y-0.5">
      {rows.map((r) => (
        <li key={r.currency} className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-base font-semibold text-slate-900 [font-variant-numeric:tabular-nums]">{r.currency === "—" ? r.amount.toFixed(2) : formatPrice(r.amount, r.currency)}</span>
          <span className="text-xs text-slate-500">({r.count} {r.count === 1 ? "record" : "records"})</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** The filter band of a list page. Pass the grid columns through `className`. */
export function FilterBar({ className = "", children, ...props }: { className?: string; children: ReactNode } & Omit<ComponentProps<"form">, "className" | "children" | "method">) {
  return (
    <form method="get" {...props} className={`${cardClass} grid items-end gap-3 p-3 sm:p-4 ${className}`}>
      {children}
    </form>
  );
}

export function FilterField({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block min-w-0 text-xs font-medium text-slate-600 ${className}`}>
      {label}
      {children}
    </label>
  );
}

export function SearchField({
  label,
  name,
  defaultValue,
  placeholder,
  maxLength,
  className = "",
}: {
  label: string;
  name: string;
  defaultValue: string;
  placeholder: string;
  maxLength: number;
  className?: string;
}) {
  return (
    <FilterField label={label} className={className}>
      <span className="relative mt-1 block">
        <Glyph d={GLYPH_SEARCH} size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          name={name}
          defaultValue={defaultValue}
          maxLength={maxLength}
          placeholder={placeholder}
          className="block min-h-10 w-full rounded-lg border py-2 pl-9 pr-3 text-sm font-normal text-slate-900 outline-none placeholder:text-slate-400"
        />
      </span>
    </FilterField>
  );
}

export function FilterActions({ resetHref, label = "Apply filters", className = "" }: { resetHref?: string; label?: string; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <button type="submit" className={buttonClass}>{label}</button>
      {resetHref && <Link href={resetHref} className={secondaryButtonClass}>Reset</Link>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * A dense table that scrolls inside its own card, never the page. `minWidth` is
 * a literal Tailwind class. `flush` drops the card, for a table inside a `Card`.
 */
export function TableCard({
  label,
  minWidth = "min-w-[720px]",
  head,
  flush = false,
  children,
}: {
  label: string;
  minWidth?: string;
  head: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  const table = (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
    >
      <table className={`w-full text-left text-[13px] text-slate-700 ${minWidth}`}>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
  return flush ? table : <div className={`${cardClass} min-w-0 overflow-hidden`}>{table}</div>;
}

export function Th({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500 first:pl-4 last:pr-4 ${right ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <td className={`px-3 py-2 align-top first:pl-4 last:pr-4 ${right ? "text-right" : ""} ${className}`}>{children}</td>;
}

export function RowHeader({ children }: { children: ReactNode }) {
  return <th scope="row" className="px-3 py-2 text-left align-top font-medium text-slate-900 first:pl-4">{children}</th>;
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="transition-colors hover:bg-slate-50 motion-reduce:transition-none">{children}</tr>;
}

export function EmptyRow({ colSpan, title, children }: { colSpan: number; title: string; children?: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center">
        <p className="text-sm font-medium text-slate-800">{title}</p>
        {children && <p className="mt-1 text-xs text-slate-500">{children}</p>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Lists and details
// ---------------------------------------------------------------------------

export const listClass = "-my-2 divide-y divide-slate-100 text-[13px] text-slate-700";

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-slate-500">{children}</p>;
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-slate-900">{children}</dd>
    </div>
  );
}

export const detailListClass = "-my-1.5 divide-y divide-slate-100 text-[13px]";

/** Build a link that keeps the current filters and changes some of them. */
export function hrefWith(path: string, current: Record<string, string | undefined>, changes: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...current, ...changes })) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** `total` can be null when a search stopped early: `hasMore` then says if there is a next page. */
export function Pagination({ path, params, page, pageSize, total, hasMore }: { path: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number | null; hasMore?: boolean }) {
  const next = total === null ? Boolean(hasMore) : page < Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-slate-600">
      <span className="[font-variant-numeric:tabular-nums]">
        {total === null ? `${(page - 1) * pageSize + 1}–${page * pageSize}${hasMore ? " of many" : ""}` : total === 0 ? "No results" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      </span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link className={smallButtonClass} href={hrefWith(path, params, { page: String(page - 1) })}>
            Previous
          </Link>
        ) : null}
        {next ? (
          <Link className={smallButtonClass} href={hrefWith(path, params, { page: String(page + 1) })}>
            Next
          </Link>
        ) : null}
      </span>
    </nav>
  );
}

export { default as DailyBarChart } from "@/components/charts/DailyBarChart";
