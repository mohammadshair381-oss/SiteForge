import { z } from "zod";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { isValidObjectId } from "@/lib/ids";
import { moderateReview } from "@/lib/reviews";

interface RouteContext {
  params: Promise<{ id: string; reviewId: string }>;
}

const schema = z.object({ action: z.enum(["approve", "reject"]) });

/**
 * `PATCH { action: "approve" | "reject" }` — moderation. The text of a review
 * is never edited by the business; the product rating summary follows.
 */
export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, reviewId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    if (!isValidObjectId(reviewId)) throw new HttpError(404, "Review not found", "not_found");
    const { action } = schema.parse(await readJson(request));
    return ok({ review: await moderateReview({ businessId: id, reviewId, action, actorId: String(user._id) }) });
  });
}
