import { handle, HttpError } from "@/lib/api";

/**
 * Retired. Plans used to be written straight to draft pages here, which skipped the
 * review, the claims check and the `generated` marker that keeps unknown facts from
 * being published. A plan now becomes a change proposal
 * (`POST /api/businesses/[id]/proposals/from-plan`), which an owner or manager
 * previews, approves and applies to drafts; publishing stays a separate step.
 */
export async function POST() {
  return handle(async () => {
    throw new HttpError(410, "Save this plan as a change proposal, then review and apply it from Change proposals.", "use_proposal_workflow");
  });
}
