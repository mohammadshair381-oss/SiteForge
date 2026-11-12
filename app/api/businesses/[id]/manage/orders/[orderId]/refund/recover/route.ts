import { z } from "zod";
import { handle, HttpError, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { isValidObjectId } from "@/lib/ids";
import { loadManagedOrderDetail } from "@/lib/orders/management-detail";
import { REFUND_RECOVERY_REASON_MAX, REFUND_RECOVERY_REASON_MIN, recoverStuckRefund } from "@/lib/payments/order-refunds";
import { enforceRateLimit } from "@/lib/rate-limit";

interface RouteContext {
  params: Promise<{ id: string; orderId: string }>;
}

const bodySchema = z
  .object({
    refundId: z.string().trim().min(1).max(40),
    reason: z
      .string()
      .trim()
      .min(REFUND_RECOVERY_REASON_MIN, "Say why you are releasing this hold, in a few words.")
      .max(REFUND_RECOVERY_REASON_MAX, `Keep the reason under ${REFUND_RECOVERY_REASON_MAX} characters.`)
      .refine((value) => !/[<>]/.test(value), "Use plain text for the reason."),
    // The owner's explicit statement, checked here and not only in the browser.
    confirmedNotRefunded: z.literal(true, { error: "Confirm that Razorpay's dashboard shows no refund for this payment." }),
  })
  .strict();

/**
 * `POST { refundId, reason, confirmedNotRefunded: true }`: the owner releases the hold of a stuck Razorpay
 * refund after checking Razorpay's own dashboard (lib/payments/order-refunds.ts `recoverStuckRefund`).
 * Owners with a verified email, like a Razorpay refund itself. Nothing is sent to Razorpay.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, orderId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner"]);
    await requireVerifiedEmail();
    if (!isValidObjectId(orderId)) throw new HttpError(404, "Order not found", "not_found");
    await enforceRateLimit({ key: `orders:refund-recover:${id}`, windowMs: 60 * 60 * 1000, limit: 20 });
    const body = bodySchema.parse(await readJson(request));
    await recoverStuckRefund({ businessId: id, orderId, refundId: body.refundId, actorId: user._id, reason: body.reason });
    return ok(await loadManagedOrderDetail(id, orderId));
  });
}
