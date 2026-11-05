import Link from "next/link";
import ResendVerificationButton from "@/components/auth/ResendVerificationButton";
import { Icon } from "@/components/ui/Icon";

/**
 * Dashboard notice for explicitly unverified users. Server component: it is
 * only rendered when `emailVerifiedAt === null` (see app/dashboard/layout.tsx).
 */
export default function VerificationBanner() {
  return (
    <div role="status" className="relative z-30 mb-5 flex flex-wrap items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5">
      <Icon name="mail" size={20} className="mt-0.5 text-amber-700" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-amber-950">Verify your email address</h2>
        <p className="mt-1 text-sm text-amber-900">We emailed you a verification link. Confirm your address to create businesses, publish sites and invite your team.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ResendVerificationButton />
          <Link href="/verify-email" className="rounded text-sm font-semibold text-amber-950 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
            Open verification page
          </Link>
        </div>
      </div>
    </div>
  );
}
