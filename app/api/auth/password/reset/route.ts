import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { resetPasswordSchema } from "@/lib/validation";
import { hashPassword } from "@/lib/auth/password";
import { cancelAllPendingCodes, clearLoginChallengeCookie } from "@/lib/auth/login-challenge";
import { verifySubmittedCode } from "@/lib/auth/code-verification";
import { User } from "@/models/User";
import { recordSecurityEvent } from "@/lib/security-events";

// Public (the person is signed out). A generous per-IP cap on top of the per-code and per-account limits.
const RESET_WINDOW_MS = 15 * 60 * 1000;
const RESET_MAX_PER_IP = 20;

/**
 * Completes a password reset: the emailed six-digit code (from this browser's pending reset, see
 * ../forgot/route.ts) and the new password.
 *
 * - The code is checked by `verifySubmittedCode` (5 guesses per code, its own daily budget per
 *   account, single use, 5-minute expiry; a decoy answers exactly like a wrong code).
 * - The password write + session revocation are one atomic conditional `findOneAndUpdate`, pinned to
 *   the `tokenVersion` seen, so two racing resets cannot both succeed; `active: true` is part of the
 *   filter, so an inactive account is never reset and never reactivated.
 * - It raises `tokenVersion` (every session ends) and `deviceTrustVersion`, and cancels every other
 *   pending code of the account. Entering the emailed code proves the mailbox, so the address counts
 *   as confirmed. It never signs in: the person logs in with the new password (and a login code).
 */
export async function POST(request: Request) {
  return handle(async () => {
    await enforceRateLimit({
      key: `reset:ip:${getClientIp(request)}`,
      limit: RESET_MAX_PER_IP,
      windowMs: RESET_WINDOW_MS,
    });

    const { code, password } = resetPasswordSchema.parse(await readJson(request));
    await dbConnect();

    const { user: current } = await verifySubmittedCode(request, code, { cookie: "reset", purposes: ["reset"] });

    const passwordHash = await hashPassword(password);
    const now = new Date();
    // One atomic write sets the new hash and bumps tokenVersion exactly once.
    // findOneAndUpdate bypasses the passwordHash pre-save hook on purpose, so
    // there is no double increment; the explicit $inc is the single revocation.
    const updated = await User.findOneAndUpdate(
      { _id: current._id, active: true, tokenVersion: current.tokenVersion },
      {
        $set: { passwordHash, ...(current.emailVerifiedAt === null ? { emailVerifiedAt: now } : {}) },
        $inc: { tokenVersion: 1, deviceTrustVersion: 1 },
      },
      { new: true },
    );
    if (!updated) {
      await recordSecurityEvent({ type: "password_reset_failed", reason: "reset_conflict", userId: current._id, request });
      throw new HttpError(409, "This reset could not be completed. Please ask for a new code.", "reset_conflict");
    }

    await cancelAllPendingCodes(updated._id, now);
    await recordSecurityEvent({ type: "password_reset_completed", userId: updated._id, request });
    return clearLoginChallengeCookie(ok({ success: true }), "reset");
  });
}
