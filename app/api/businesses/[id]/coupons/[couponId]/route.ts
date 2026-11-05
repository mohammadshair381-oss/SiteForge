import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { isValidObjectId } from "@/lib/ids";
import { updateCoupon } from "@/lib/coupons";

interface RouteContext {
  params: Promise<{ id: string; couponId: string }>;
}

/**
 * `PUT <coupon>` — edits a coupon of this business. Coupons are deactivated,
 * not deleted (orders keep their snapshot; redemptions reference them).
 */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, couponId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    if (!isValidObjectId(couponId)) throw new HttpError(404, "Coupon not found", "not_found");
    return ok({ coupon: await updateCoupon(id, couponId, await readJson(request)) });
  });
}
