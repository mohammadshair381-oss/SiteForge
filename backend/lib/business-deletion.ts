import mongoose, { type ClientSession, type Types } from "mongoose";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Order } from "@/models/Order";
import { OrderRefund } from "@/models/OrderRefund";
import { PreviewLink } from "@/models/PreviewLink";
import { Subscription } from "@/models/Subscription";
import { TeamInvitation } from "@/models/TeamInvitation";
import { User } from "@/models/User";

/**
 * Deleting a business, by its owner (server-only).
 *
 * A SOFT delete: the business becomes `status: "deleted"` and nothing is erased. Orders, payments,
 * refunds, customers and media stay in the database for the records a shop must keep and for
 * support; nothing removes them. What changes at once, in one transaction:
 *
 * - the storefront goes offline (it serves only `published` stores) and its address stays reserved;
 * - every membership is disabled, so nobody (owner, managers, staff) can open the business again,
 *   and it disappears from every dashboard;
 * - pending team invitations and draft preview links stop working.
 *
 * Only the business's primary owner may delete it, after confirming with its exact name and their
 * own password. It is refused while something still needs the business: an unpaid or unfulfilled
 * order, a pending refund, a paid plan billed by Razorpay (cancel it in Billing first, or it would
 * keep charging), or a suspension by a platform administrator. There is no undo in the product.
 */

const BLOCKING_SUBSCRIPTION_STATUSES = ["incomplete", "trialing", "active", "past_due"] as const;

export interface DeletionBlocker {
  code: "open_orders" | "unfulfilled_orders" | "pending_refunds" | "paid_plan";
  message: string;
}

/** Reasons the business cannot be deleted right now (read-only). Also re-checked inside the delete. */
export async function businessDeletionBlockers(businessId: Types.ObjectId, session?: ClientSession): Promise<DeletionBlocker[]> {
  const [pending, unfulfilled, refunds, paidPlan] = await Promise.all([
    Order.countDocuments({ business: businessId, status: "pending" }).session(session ?? null),
    Order.countDocuments({ business: businessId, status: "paid", fulfillmentStatus: { $ne: "delivered" } }).session(session ?? null),
    OrderRefund.countDocuments({ business: businessId, status: "pending" }).session(session ?? null),
    Subscription.exists({ business: businessId, provider: "razorpay", status: { $in: BLOCKING_SUBSCRIPTION_STATUSES } }).session(session ?? null),
  ]);
  const blockers: DeletionBlocker[] = [];
  if (pending > 0) blockers.push({ code: "open_orders", message: `${pending} order${pending === 1 ? " is" : "s are"} still waiting for payment or cash on delivery. Cancel or complete ${pending === 1 ? "it" : "them"} first.` });
  if (unfulfilled > 0) blockers.push({ code: "unfulfilled_orders", message: `${unfulfilled} paid order${unfulfilled === 1 ? " has" : "s have"} not been delivered yet. Mark ${unfulfilled === 1 ? "it" : "them"} delivered, or refund ${unfulfilled === 1 ? "it" : "them"}, first.` });
  if (refunds > 0) blockers.push({ code: "pending_refunds", message: `${refunds} refund${refunds === 1 ? " is" : "s are"} still in progress. Wait for ${refunds === 1 ? "it" : "them"} to finish first.` });
  if (paidPlan) blockers.push({ code: "paid_plan", message: "This business has a paid plan billed by Razorpay. Cancel it in Billing first, so it stops charging." });
  return blockers;
}

function refused(blockers: DeletionBlocker[]): HttpError {
  return new HttpError(409, blockers.map((b) => b.message).join(" "), "deletion_blocked");
}

/**
 * Deletes (soft) a business after the owner confirmed it. Throws:
 * - 403 `forbidden`: not the primary owner; `suspended`: suspended by a platform administrator;
 * - 422 `confirmation_mismatch` (the name, beside its field) or 401 `invalid_password` (beside its field);
 * - 409 `deletion_blocked` with every reason; 404 `not_found` when already deleted.
 */
export async function deleteBusiness(input: {
  businessId: string;
  userId: Types.ObjectId;
  confirmName: string;
  password: string;
  now?: Date;
}): Promise<void> {
  await dbConnect();
  const now = input.now ?? new Date();
  const businessId = new mongoose.Types.ObjectId(input.businessId);
  const business = await Business.findById(businessId).select("name owner status").lean<{ _id: Types.ObjectId; name: string; owner: Types.ObjectId; status: string }>();
  if (!business || business.status === "deleted") throw new HttpError(404, "Business not found", "not_found");
  if (String(business.owner) !== String(input.userId)) {
    throw new HttpError(403, "Only the owner who created this business can delete it.", "forbidden");
  }
  if (business.status === "suspended") {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  if (input.confirmName.trim() !== business.name.trim()) {
    const message = "Type the business name exactly as it is shown.";
    throw new HttpError(422, message, "confirmation_mismatch", undefined, { confirmName: message });
  }
  const user = await User.findById(input.userId).select("+passwordHash");
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    const message = "That password is not right.";
    throw new HttpError(401, message, "invalid_password", undefined, { password: message });
  }

  const blockers = await businessDeletionBlockers(businessId);
  if (blockers.length > 0) throw refused(blockers);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Checked again inside the transaction, so an order placed meanwhile still blocks.
      const again = await businessDeletionBlockers(businessId, session);
      if (again.length > 0) throw refused(again);
      const updated = await Business.updateOne(
        { _id: businessId, owner: input.userId, status: { $in: ["draft", "published"] } },
        { $set: { status: "deleted", publishedAt: null, statusChangedAt: now, deletedAt: now, deletedBy: input.userId } },
        { session },
      );
      if (updated.modifiedCount !== 1) throw new HttpError(409, "This business changed meanwhile. Reload the page and try again.", "conflict");
      await Membership.updateMany({ business: businessId }, { $set: { status: "disabled" } }, { session });
      await TeamInvitation.updateMany({ business: businessId, status: "pending" }, { $set: { status: "revoked", revokedAt: now } }, { session });
      await PreviewLink.updateMany({ business: businessId, revokedAt: null }, { $set: { revokedAt: now } }, { session });
    });
  } finally {
    await session.endSession();
  }
}
