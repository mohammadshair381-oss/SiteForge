import { handle, ok, created, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { createCoupon, listCoupons } from "@/lib/coupons";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — this business's coupons. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok({ coupons: await listCoupons(id) }, { headers: { "Cache-Control": "no-store" } });
  });
}

/** `POST <coupon>` — creates a coupon (code unique per business). */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return created({ coupon: await createCoupon(id, await readJson(request)) });
  });
}
