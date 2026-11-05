import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getMembershipsForUser, requireUser } from "@/lib/auth/guards";
import { getPlatformSettings } from "@/lib/platform-settings";
import DashboardShell, { CommandTrigger } from "@/components/dashboard/DashboardShell";
import MobileNav from "@/components/dashboard/MobileNav";
import VerificationBanner from "@/components/dashboard/VerificationBanner";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";
import { Logo } from "@/components/ui/Logo";
import { Notice } from "@/components/ui/Surface";
import type { BusinessMembershipRole } from "@/components/dashboard/BusinessTabs";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const user = await requireUser();
  const memberships = await getMembershipsForUser(user._id.toString());

  const businesses = memberships
    .map((membership) => {
      const business = membership.business as unknown as {
        _id: string;
        name: string;
      } | null;
      return business
        ? {
            id: String(business._id),
            name: business.name,
            role: membership.role as BusinessMembershipRole,
          }
        : null;
    })
    .filter(
      (
        b,
      ): b is { id: string; name: string; role: BusinessMembershipRole } =>
        b !== null,
    );

  const isSuperAdmin = user.platformRole === "super_admin";
  const platform = await getPlatformSettings();

  return (
    <ToastProvider>
      <ConfirmHost />
      <div className="app-surface min-h-screen bg-slate-50">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-brand-700 focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          Skip to content
        </a>

        <DashboardShell
          businesses={businesses}
          isSuperAdmin={isSuperAdmin}
          user={{ name: user.name, email: user.email }}
          mobileHeader={
            <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:hidden">
              <Link
                href="/dashboard"
                aria-label="SiteForge, all businesses"
                className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                <Logo size="sm" />
              </Link>
              <div className="flex items-center gap-1">
                <CommandTrigger />
                <MobileNav
                  businesses={businesses}
                  isSuperAdmin={isSuperAdmin}
                  userName={user.name}
                  userEmail={user.email}
                />
              </div>
            </header>
          }
        >
          <main
            id="main-content"
            className="mx-auto w-full max-w-screen-2xl px-4 py-5 sm:px-6 sm:py-6"
          >
            {user.emailVerifiedAt === null && <VerificationBanner />}
            {platform.maintenanceEnabled && (
              <Notice tone="warning" role="status" className="mb-5" title="SiteForge is undergoing maintenance">
                {platform.maintenanceMessage || "Creating stores and publishing are paused for now. Live stores, checkout and your existing work are not affected."}
              </Notice>
            )}
            {children}
          </main>
        </DashboardShell>
      </div>
    </ToastProvider>
  );
}
