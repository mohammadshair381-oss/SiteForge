import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { assertObjectId } from "@/lib/ids";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import { notifyStoreStatus } from "@/lib/notification-events";
import { Business } from "@/models/Business";

export async function GET() {
  return handle(async () => {
    await requireSuperAdmin();
    await dbConnect();
    const businesses = await Business.find()
      .populate("owner", "name email")
      .sort({ createdAt: -1 })
      .lean();
    return ok({ businesses });
  });
}

/**
 * Explicit admin actions only. Setting `status` directly is no longer accepted
 * (unknown keys are rejected), so an admin can never publish a business and
 * skip the owner's validated publish flow (`POST /api/businesses/[id]/publish`:
 * entitlement check, navigation validation, published snapshots).
 */
const actionSchema = z
  .object({
    action: z.enum(["suspend", "reactivate"]),
    reason: z
      .string()
      .trim()
      .min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters`)
      .max(ADMIN_REASON_MAX),
  })
  .strict();

/**
 * `PATCH /api/admin/businesses?id=<businessId>` `{ action, reason }`
 *
 * - `suspend`: draft/published -> suspended. The public storefront, carts and
 *   new orders stop immediately (they require `status: "published"`). The
 *   owner keeps dashboard access to resolve the issue but cannot publish.
 * - `reactivate`: suspended -> draft (never straight to published). The owner
 *   then republishes through the normal validated flow.
 *
 * Each transition is a conditional update, and it is recorded in the admin
 * audit log in the same transaction.
 */
export async function PATCH(request: Request) {
  return handle(async () => {
    const admin = await requireSuperAdmin();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) throw new HttpError(400, "Business id is required", "bad_request");
    const businessId = assertObjectId(id, "business id");

    const { action, reason } = actionSchema.parse(await readJson(request));
    await dbConnect();

    const business = await runAuditedAdminAction(async (session) => {
      const filter =
        action === "suspend"
          ? { _id: businessId, status: { $ne: "suspended" } }
          : { _id: businessId, status: "suspended" };
      const update =
        action === "suspend"
          ? { $set: { status: "suspended", statusChangedAt: new Date() } }
          : { $set: { status: "draft", publishedAt: null, statusChangedAt: new Date() } };

      const previous = await Business.findOneAndUpdate(filter, update, {
        new: false,
        session,
      }).lean();

      if (!previous) {
        const exists = await Business.exists({ _id: businessId }).session(session);
        if (!exists) throw new HttpError(404, "Business not found", "not_found");
        throw new HttpError(
          409,
          action === "suspend"
            ? "This business is already suspended."
            : "Only a suspended business can be reactivated.",
          action === "suspend" ? "already_suspended" : "not_suspended",
        );
      }

      const nextStatus = action === "suspend" ? "suspended" : "draft";
      return {
        result: { ...previous, status: nextStatus },
        audit: {
          actorId: String(admin._id),
          action: action === "suspend" ? "business.suspend" : "business.reactivate",
          targetType: "business",
          targetId: String(businessId),
          targetLabel: previous.name,
          reason,
          before: { status: previous.status },
          after: { status: nextStatus },
        },
      };
    });

    notifyStoreStatus(String(businessId));

    return ok({
      business: {
        _id: String(business._id),
        name: business.name,
        subdomain: business.subdomain,
        status: business.status,
      },
    });
  });
}
