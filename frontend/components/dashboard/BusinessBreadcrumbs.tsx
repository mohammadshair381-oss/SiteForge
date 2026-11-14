"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { businessSectionLabel } from "./BusinessTabs";

/**
 * Compact breadcrumb for a business workspace. The last item is the current
 * section and is not a link, so keyboard and screen-reader users get a clear
 * trail without duplicate navigation.
 */
export default function BusinessBreadcrumbs({
  businessId,
  businessName,
}: {
  businessId: string;
  businessName: string;
}) {
  const pathname = usePathname();
  const base = `/dashboard/businesses/${businessId}`;
  const segment =
    pathname === base
      ? ""
      : pathname.startsWith(`${base}/`)
        ? pathname.slice(base.length + 1).split("/")[0]
        : "";
  const current = businessSectionLabel(segment);

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
        <li className="hidden shrink-0 sm:block">
          <Link
            href="/dashboard"
            className="rounded font-medium transition hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Dashboard
          </Link>
        </li>
        <li aria-hidden="true" className="hidden text-slate-300 sm:block">
          /
        </li>
        <li className="min-w-0">
          {current ? (
            <Link
              href={base}
              className="block max-w-[9rem] truncate rounded font-medium transition hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 sm:max-w-xs"
              title={businessName}
            >
              {businessName}
            </Link>
          ) : (
            <span
              className="block max-w-[9rem] truncate font-semibold text-slate-900 sm:max-w-xs"
              title={businessName}
            >
              {businessName}
            </span>
          )}
        </li>
        {current ? (
          <>
            <li aria-hidden="true" className="text-slate-300">
              /
            </li>
            <li className="min-w-0">
              <span
                aria-current="page"
                className="block truncate font-semibold text-slate-900"
              >
                {current}
              </span>
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}
