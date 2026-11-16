import { Icon } from "@/components/ui/Icon";
import LogoutButton from "@/components/dashboard/LogoutButton";

/**
 * Dashboard notice for explicitly unconfirmed users. Server component: it is only rendered when
 * `emailVerifiedAt === null` (see app/dashboard/layout.tsx). Addresses are no longer confirmed by
 * email; logging in clears the old unconfirmed marker, so this only shows for a session from before.
 */
export default function VerificationBanner() {
  return (
    <div role="status" className="relative z-30 mb-5 flex flex-wrap items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5">
      <Icon name="mail" size={20} className="mt-0.5 text-amber-700" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-amber-950">Finish setting up your account</h2>
        <p className="mt-1 text-sm text-amber-900">Log out and log in again with your email and password. Then you can create businesses, publish sites and invite your team.</p>
        <div className="mt-3">
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
