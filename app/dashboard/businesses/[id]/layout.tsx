import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getEntitlements } from "@/lib/billing";
import { storeLinkRoot } from "@/lib/host";
import { Business } from "@/models/Business";
import { Subscription } from "@/models/Subscription";
import BusinessBreadcrumbs from "@/components/dashboard/BusinessBreadcrumbs";
import NotificationBell from "@/components/dashboard/NotificationBell";
import PlanStatusBanner from "@/components/dashboard/PlanStatusBanner";
import WebsiteNav from "@/components/dashboard/WebsiteNav";
import type { BusinessMembershipRole } from "@/components/dashboard/BusinessTabs";
import { Pill, type Tone } from "@/components/ui/Surface";
import { Icon } from "@/components/ui/Icon";
import { focusRing } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  published: { label: "Live", tone: "success" },
  suspended: { label: "Suspended", tone: "danger" },
  draft: { label: "Draft", tone: "neutral" },
};

export default async function BusinessLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  await dbConnect();
  const business = await Business.findById(id).select("name category subdomain status").lean();
  if (!business) notFound();
  const [entitlements, subscription] = await Promise.all([
    getEntitlements(id),
    Subscription.findOne({ business: id }).sort({ createdAt: -1 }).select("cancelAtPeriodEnd currentPeriodEnd").lean<{ cancelAtPeriodEnd?: boolean; currentPeriodEnd?: Date | null }>(),
  ]);

  const rootDomain = storeLinkRoot((await headers()).get("host"));
  const storefrontUrl = `http://${business.subdomain}.${rootDomain}`;
  const status = STATUS[business.status] ?? STATUS.draft;
  // Billing is owner-only. Other members are still told when a store has no active plan, not why.
  const isOwner = membership.role === "owner";
  // For them, only the day a working plan may stop: the earlier of the two dates the owner's banner already
  // shows (the end of a failed payment's grace period, or the end of a subscription set to end). It is worked
  // out here, on the server, and the banner shows the day alone: no reason, status or time of day goes with it.
  const endingOn = subscription?.cancelAtPeriodEnd && subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const memberDates = [entitlements.graceUntil ? new Date(entitlements.graceUntil) : null, endingOn].filter((date): date is Date => date !== null);
  const memberWarningFrom = !isOwner && entitlements.active && memberDates.length > 0 ? new Date(Math.min(...memberDates.map((date) => date.getTime()))) : undefined;

  return (
    <div>
      {/* Flush with the page edges: the bar reads as part of the window, not as a card. */}
      <div className="sticky top-14 z-20 -mx-4 -mt-5 mb-5 border-b border-slate-200 bg-white/90 backdrop-blur sm:-mx-6 sm:-mt-6 sm:mb-6 lg:top-0">
        <div className="flex min-h-12 items-center justify-between gap-x-3 px-4 py-2 sm:flex-wrap sm:gap-x-4 sm:gap-y-1 sm:px-6">
          <BusinessBreadcrumbs businessId={id} businessName={business.name} />
          <div className="flex shrink-0 items-center gap-3">
            <NotificationBell businessId={id} />
            <Pill tone={status.tone} dot>
              {status.label}
            </Pill>
            {business.status === "published" && (
              <a href={storefrontUrl} target="_blank" rel="noreferrer" title={storefrontUrl} className={`inline-flex items-center gap-1 rounded text-xs font-semibold text-slate-700 transition-colors hover:text-slate-950 ${focusRing}`}>
                <span className="sr-only sm:not-sr-only">View site</span> <Icon name="external" size={15} />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
          </div>
        </div>
        <WebsiteNav businessId={id} role={membership.role as BusinessMembershipRole} />
      </div>

      <PlanStatusBanner
        suspended={business.status === "suspended"}
        businessId={id}
        isOwner={isOwner}
        planName={entitlements.planName}
        active={entitlements.active}
        expired={isOwner && entitlements.expired}
        status={isOwner ? entitlements.status : ""}
        graceUntil={isOwner ? entitlements.graceUntil : null}
        endsOn={isOwner && subscription?.cancelAtPeriodEnd ? subscription.currentPeriodEnd : null}
        memberWarningFrom={memberWarningFrom}
      />
      {children}
    </div>
  );
}
