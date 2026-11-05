import { ButtonLink } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";

const day = (value: Date) => value.toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/**
 * Shown across a store's dashboard when its plan needs attention. Only the owner can act on
 * billing, so others are told who to ask and get no link. Describes the state only: every
 * restriction is enforced on the server (lib/billing.ts, lib/usage-limits.ts).
 */
export default function PlanStatusBanner({
  suspended = false,
  businessId,
  isOwner,
  planName,
  active,
  expired,
  status,
  graceUntil,
  endsOn,
}: {
  /** Suspension is said first: a plan cannot fix it. */
  suspended?: boolean;
  businessId: string;
  isOwner: boolean;
  planName: string;
  active: boolean;
  expired: boolean;
  status: string;
  graceUntil?: Date | null;
  /** Set when the subscription will end at this date. */
  endsOn?: Date | null;
}) {
  const action = isOwner ? <ButtonLink href={`/dashboard/businesses/${businessId}/billing`} variant="secondary">{active ? "Review billing" : "Choose a plan"}</ButtonLink> : undefined;
  const ask = isOwner ? "" : " Ask the store owner to review the plan.";

  if (suspended) {
    return (
      <Notice tone="danger" role="alert" className="mb-5" title="This store has been suspended">
        A platform administrator suspended it, so it is offline to shoppers and cannot be published. Nothing has been deleted.
        <SupportContact label="To resolve this:" className="mt-1" />
      </Notice>
    );
  }

  if (!active) {
    return (
      <Notice tone="danger" role="alert" className="mb-5" title={expired ? `Your ${planName} plan has expired` : status === "past_due" ? "A subscription payment has failed" : "This store has no active plan"} action={action}>
        The store is offline to shoppers, and new orders, publishing and adding products are paused. Nothing has been deleted, and everything comes back once a plan is active.{ask}
      </Notice>
    );
  }
  if (graceUntil) {
    return (
      <Notice tone="warning" className="mb-5" title="A subscription payment has failed" action={action}>
        The store keeps working until {day(graceUntil)}. After that it goes offline until a payment succeeds.{ask}
      </Notice>
    );
  }
  if (endsOn) {
    return (
      <Notice tone="warning" className="mb-5" title="This subscription is ending" action={action}>
        It ends on {day(endsOn)}. After that the store goes offline unless a plan is active.{ask}
      </Notice>
    );
  }
  return null;
}
