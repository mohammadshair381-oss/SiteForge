import { handle, ok } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { isValidObjectId } from "@/lib/ids";
import { destroySession, getSession } from "@/lib/auth/session";
import { User } from "@/models/User";

/**
 * Ends the current session.
 *
 * Clearing the cookie alone is not enough: the session is a stateless JWT, so a
 * captured copy would keep working until it expired. When the caller presents a
 * validly signed session we therefore bump the user's `tokenVersion`
 * server-side — the same revocation mechanism `requireUser` already checks and
 * the password route already uses — and only then clear the cookie with the
 * existing cookie configuration. Because there is no per-device session record,
 * this invalidates every session for that user (see the phase report for this
 * deliberate limitation).
 *
 * Logout stays idempotent and predictable: an absent, invalid or expired
 * session, or a session whose user no longer exists, still clears the cookie and
 * reports success because there is nothing left to revoke. If revocation is
 * required but the database write fails, the error propagates (500) *before* the
 * cookie is cleared, so a failed revoke is never reported as a successful
 * logout.
 */
export async function POST() {
  return handle(async () => {
    const session = await getSession();

    if (session && isValidObjectId(session.userId)) {
      await dbConnect();
      // Atomic $inc: concurrent logouts/password changes cannot lose an
      // increment, and a missing user simply matches nothing (nothing to
      // revoke). Using updateOne avoids re-running the password pre-save hook.
      await User.updateOne(
        { _id: session.userId },
        { $inc: { tokenVersion: 1 } },
      );
    }

    await destroySession();
    return ok({ success: true });
  });
}
