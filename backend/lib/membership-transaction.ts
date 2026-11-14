import mongoose, { type ClientSession, type Types } from "mongoose";
import { HttpError } from "./api";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";

/**
 * True when an error from a transaction reflects a retryable conflict that
 * `withTransaction` already retried until its time budget was exhausted.
 * Our own HttpError and genuine internal failures do NOT match and propagate
 * unchanged, so they keep their real status / become a 500.
 */
function isTransactionalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) {
    return true;
  }
  return (error as { code?: unknown }).code === 112; // WriteConflict
}

/**
 * The conflict-creating write shared by every serialized membership mutation.
 *
 * It must actually modify the document: MongoDB only raises a
 * `WriteConflict`/`TransientTransactionError` between transactions that change
 * the same document. A previous "touch" that computed the existing value
 * (`[{ $set: { name: "$name" } }]`) changed nothing, so it produced no write and
 * no conflict, leaving the race open. Writing a fresh `updatedAt` (with
 * `timestamps: false`, so Mongoose does not also write it) is a genuine,
 * conflict-creating write that touches no business data.
 */
export async function touchBusinessForSerialization(
  businessId: Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  await Business.updateOne(
    { _id: businessId },
    { $set: { updatedAt: new Date() } },
    { session, timestamps: false },
  );
}

/**
 * Runs a role-affecting membership mutation inside a transaction that also
 * writes the owning business document. Two concurrent mutations for the same
 * business therefore conflict on that write and one is retried by
 * `withTransaction`, so the "at least one active owner" rule cannot be bypassed
 * by write skew (e.g. two owners each demoting the other at the same time).
 *
 * The acting user's membership is re-read with the transaction session on every
 * attempt, so a role revoked by a concurrent request cannot be used to finish
 * an in-flight mutation, and retries always re-evaluate that authorization.
 */
export async function runSerializedMembershipMutation<T>(
  businessId: Types.ObjectId,
  actorMembershipId: Types.ObjectId,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.connection.startSession();
  try {
    let result!: T;
    try {
      await session.withTransaction(async () => {
        await touchBusinessForSerialization(businessId, session);

        const actorMembership = await Membership.findOne({
          _id: actorMembershipId,
          business: businessId,
        }).session(session);
        if (
          !actorMembership ||
          actorMembership.role !== "owner" ||
          actorMembership.status !== "active"
        ) {
          throw new HttpError(
            403,
            "You no longer have permission to manage members",
            "forbidden",
          );
        }

        result = await work(session);
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (isTransactionalConflict(error)) {
        throw new HttpError(
          409,
          "The change conflicted with another update. Please retry.",
          "conflict",
        );
      }
      throw error;
    }
    return result;
  } finally {
    await session.endSession();
  }
}
