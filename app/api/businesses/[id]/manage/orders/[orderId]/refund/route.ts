import { z } from "zod";
import { handle, HttpError, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { dbConnect } from "@/lib/db";
import { isValidObjectId } from "@/lib/ids";
import { loadManagedOrderDetail } from "@/lib/orders/management-detail";
import { createOrderRefund, refreshOrderRefund } from "@/lib/payments/order-refunds";
import { enforceRateLimit } from "@/lib/rate-limit";

interface RouteContext {
  params: Promise<{ id: string; orderId: string }>;
}

const bodySchema = z.object({
  method: z.enum(["razorpay", "manual"]),
  /** Absent = everything not yet refunded. The server checks it against what was paid. */
  amount: z.number().positive().max(100_000_000).optional(),
  reason: z.string().trim().max(200).refine((v) => !/[<>]/.test(v), "Use plain text").optional(),
  restock: z.boolean().optional(),
});
const refreshSchema = z.object({ refundId: z.string().trim().min(1).max(40) });

/**
 * `POST { method, amount?, reason?, restock? }` — refunds a paid order.
 *
 * `razorpay` sends money back through the business's own account, so it is for
 * owners with a verified email. `manual` records money returned another way, for
 * owners and managers, and moves nothing.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, orderId } = await context.params;
    const raw = (await readJson(request)) as Record<string, unknown>;
    const body = bodySchema.parse(raw);
    const { user } = await requireBusinessRole(id, body.method === "razorpay" ? ["owner"] : ["owner", "manager"]);
    if (body.method === "razorpay") await requireVerifiedEmail();
    if (!isValidObjectId(orderId)) throw new HttpError(404, "Order not found", "not_found");
    await enforceRateLimit({ key: `orders:refund:${id}`, windowMs: 60 * 60 * 1000, limit: 30 });
    await dbConnect();
    await createOrderRefund({ businessId: id, orderId, ...body, actorId: user._id });
    return ok(await loadManagedOrderDetail(id, orderId));
  });
}

/** `PATCH { refundId }` — asks Razorpay about a refund still in progress. Owners. */
export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, orderId } = await context.params;
    await requireBusinessRole(id, ["owner"]);
    const { refundId } = refreshSchema.parse(await readJson(request));
    if (!isValidObjectId(orderId)) throw new HttpError(404, "Order not found", "not_found");
    await enforceRateLimit({ key: `orders:refund-check:${id}`, windowMs: 60 * 60 * 1000, limit: 60 });
    await refreshOrderRefund({ businessId: id, refundId });
    return ok(await loadManagedOrderDetail(id, orderId));
  });
}
