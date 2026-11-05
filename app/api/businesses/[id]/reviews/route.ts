import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { listReviewsForBusiness } from "@/lib/reviews";
import { REVIEW_STATUSES, type ReviewStatus } from "@/models/ProductReview";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET ?status=pending|approved|rejected` — reviews of this business. Owners and managers. */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const raw = new URL(request.url).searchParams.get("status");
    const status = (REVIEW_STATUSES as readonly string[]).includes(raw ?? "") ? (raw as ReviewStatus) : null;
    return ok({ reviews: await listReviewsForBusiness(id, status) }, { headers: { "Cache-Control": "no-store" } });
  });
}
