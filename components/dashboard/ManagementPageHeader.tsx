import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Shared page header for dashboard management screens.
 *
 * `action` renders a single navigational link (the original API). `actions`
 * renders arbitrary controls, such as buttons that call a client-side handler,
 * in the same slot so screens do not have to re-implement the header layout.
 * When both are supplied, `actions` takes precedence.
 */
export default function ManagementPageHeader({
  title,
  description,
  action,
  actions,
}: {
  title: string;
  description: string;
  action?: { href: string; label: string; primary?: boolean };
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-1 flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[1.75rem] sm:leading-9 [text-wrap:balance]">
          {title}
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-600">
          {description}
        </p>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : action ? (
        <Link
          href={action.href}
          className={`inline-flex min-h-10 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
            action.primary
              ? "bg-brand-600 text-white hover:bg-brand-700"
              : "border border-slate-300 bg-white text-slate-700 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-800"
          }`}
        >
          {action.label}
        </Link>
      ) : null}
    </header>
  );
}
