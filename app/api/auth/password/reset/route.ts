import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { resetPasswordSchema } from "@/lib/validation";
import { hashPassword } from "@/lib/auth/password";
import { consumeActionToken } from "@/lib/auth/action-tokens";
import { User } from "@/models/User";
import { AuthToken } from "@/models/AuthToken";
import { recordSecurityEvent } from "@/lib/security-events";

// Password reset is public (the user is signed out when they follow the link).
// A generous per-IP cap stops token-probing spam without affecting real users.
const RESET_WINDOW_MS = 15 * 60 * 1000;
const RESET_MAX_PER_IP = 20;

// Every token failure mode returns this same response so a caller cannot tell
// an unknown token from an expired, reused or wrong-type one.
const INVALID_TOKEN_MESSAGE = "This reset link is invalid or has expired.";

/**
 * Completes a password reset.
 *
 * Safety model (no multi-document transaction is used, and none is claimed):
 *  - token consumption is a single atomic `findOneAndUpdate`, so exactly one
 *    concurrent request can proceed with a given token;
 *  - the password write + session revocation are a single atomic conditional
 *    `findOneAndUpdate` on the user document, pinned to the `tokenVersion`
 *    observed just before, so two racing resets cannot both succeed;
 *  - `active: true` is part of every filter, so an inactive account is never
 *    reset and never reactivated.
 */
export async function POST(request: Request) {
  return handle(async () => {
    await enforceRateLimit({
      key: `reset:ip:${getClientIp(request)}`,
      limit: RESET_MAX_PER_IP,
      windowMs: RESET_WINDOW_MS,
    });

    const { token, password } = resetPasswordSchema.parse(await readJson(request));
    await dbConnect();

    const consumed = await consumeActionToken(token, "password_reset");
    if (!consumed.ok) {
      // Never the token itself.
      await recordSecurityEvent({ type: "password_reset_failed", reason: "invalid_token", request });
      throw new HttpError(400, INVALID_TOKEN_MESSAGE, "invalid_token");
    }

    const current = await User.findById(consumed.token.user);
    if (!current || !current.active) {
      await recordSecurityEvent({ type: "password_reset_failed", reason: "invalid_token", userId: current?._id, request });
      throw new HttpError(400, INVALID_TOKEN_MESSAGE, "invalid_token");
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();

    // One atomic write sets the new hash and bumps tokenVersion exactly once.
    // findOneAndUpdate bypasses the passwordHash pre-save hook on purpose, so
    // there is no double increment; the explicit $inc is the single revocation.
    const updated = await User.findOneAndUpdate(
      { _id: current._id, active: true, tokenVersion: current.tokenVersion },
      // Using the emailed link proves the mailbox, so the address counts as confirmed.
      { $set: { passwordHash, ...(current.emailVerifiedAt === null ? { emailVerifiedAt: now } : {}) }, $inc: { tokenVersion: 1 } },
      { new: true },
    );
    if (!updated) {
      await recordSecurityEvent({ type: "password_reset_failed", reason: "reset_conflict", userId: current._id, request });
      // The account changed between the read and the write (e.g. a concurrent
      // reset already revoked sessions). Report a safe, non-internal error.
      throw new HttpError(
        409,
        "This reset request could not be completed. Please request a new link.",
        "reset_conflict",
      );
    }

    // Retire any other outstanding reset tokens for this user.
    await AuthToken.updateMany(
      { user: updated._id, type: "password_reset", usedAt: null },
      { $set: { usedAt: now } },
    );

    await recordSecurityEvent({ type: "password_reset_completed", userId: updated._id, request });
    return ok({ success: true });
  });
}
