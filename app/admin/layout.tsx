import Link from "next/link";
import type { ReactNode } from "react";
import { requireSuperAdminPage } from "@/lib/admin/page-access";
import { AdminMobileMenu } from "@/components/admin/AdminNav";
import AdminShell from "@/components/admin/AdminShell";
import { focusRing } from "@/components/ui/Button";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Logo } from "@/components/ui/Logo";

export const dynamic = "force-dynamic";

/**
 * Super Admin control center shell. Every page under /admin ALSO performs its
 * own access check (layouts are not re-run on every client navigation), and
 * every admin API calls `requireSuperAdmin()`.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireSuperAdminPage();

  return (
    <div className="app-surface min-h-screen bg-slate-50">
      <ConfirmHost />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-900 focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        Skip to content
      </a>

      <AdminShell>
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 bg-ink px-4 lg:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <Link href="/admin" aria-label="SiteForge Admin, overview" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft">
              <Logo tone="light" size="sm" />
            </Link>
            <span className="rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/70">Admin</span>
          </span>
          <AdminMobileMenu />
        </header>

        <div className="sticky top-0 z-30 hidden h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 lg:flex xl:px-8">
          <p className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Icon name="shield" size={15} className="text-slate-400" />
            Platform administration
          </p>
          <Link href="/dashboard" className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-700 hover:text-slate-900 ${focusRing}`}>
            <Icon name="arrow-left" size={15} className="text-slate-400" />
            Back to dashboard
          </Link>
        </div>

        <main id="main-content" className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 xl:px-8">
          {children}
        </main>
      </AdminShell>
    </div>
  );
}
