import type { ReactNode } from "react";

/** Shared surfaces: cards, status pills, notices, stat tiles, empty states and skeletons (docs/design-system.md). */

export const cardClass = "rounded-2xl border border-slate-200 bg-white shadow-sm";

export function Card({ className = "", children, as: Tag = "div", ...props }: { className?: string; children: ReactNode; as?: "div" | "section" | "article" | "li" } & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={`${cardClass} ${className}`} {...props}>
      {children}
    </Tag>
  );
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "ember";

const PILL: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700",
  success: "bg-emerald-50 text-emerald-800",
  warning: "bg-amber-50 text-amber-900",
  danger: "bg-red-50 text-red-800",
  info: "bg-sky-50 text-sky-800",
  ember: "bg-brand-50 text-[#b23a12]",
};

export function Pill({ tone = "neutral", dot = false, className = "", children }: { tone?: Tone; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${PILL[tone]} ${className}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

const NOTICE: Record<Exclude<Tone, "neutral" | "ember">, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  danger: "border-red-200 bg-red-50 text-red-900",
  info: "border-sky-200 bg-sky-50 text-sky-950",
};

/** An inline message. Pass `role="alert"` or `role="status"` when it appears as a result of an action. */
export function Notice({ tone = "info", title, children, action, role, className = "" }: { tone?: keyof typeof NOTICE; title?: string; children?: ReactNode; action?: ReactNode; role?: "alert" | "status"; className?: string }) {
  return (
    <div role={role} className={`flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${NOTICE[tone]} ${className}`}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function StatTile({ label, value, hint, icon, className = "" }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={`${cardClass} min-w-0 p-4 sm:p-5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-slate-500">{label}</p>
        {icon && <span className="shrink-0 text-slate-400">{icon}</span>}
      </div>
      <p className="mt-2 truncate font-heading text-2xl font-semibold tracking-tight text-slate-900 sm:text-[1.7rem]">{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action, className = "" }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`ui-dots-ink rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center ${className}`}>
      {icon && <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white">{icon}</span>}
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      {children && <div className="mx-auto mt-1.5 max-w-md text-sm leading-6 text-slate-600">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`ui-skeleton ${className}`} aria-hidden="true" />;
}

/** A small uppercase label above a heading. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs font-semibold uppercase tracking-[0.14em] text-ember-deep ${className}`}>{children}</p>;
}
