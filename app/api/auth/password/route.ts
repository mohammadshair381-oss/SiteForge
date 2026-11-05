import { recordSecurityEvent } from "@/lib/security-events";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { requireUser } from "@/lib/auth/guards";
import { retireActionTokens } from "@/lib/auth/action-tokens";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/rate-limit";
import { changePasswordSchema } from "@/lib/validation";
import { User } from "@/models/User";

// Password changes are infrequent, so a tight per-account window is acceptable:
// it caps brute-forcing of the current password through a stolen session while
// leaving honest users room for a few retries. The bucket is keyed by the
// authenticated user's stable id, so it does not reveal whether any account
// exists (unauthenticated callers are rejected before this point).
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_MAX_PER_USER = 5;

export async function POST(request: Request) {
  return handle(async () => {
    const current = await requireUser();

    await enforceRateLimit({
      key: `password:user:${current._id.toString()}`,
      limit: PASSWORD_MAX_PER_USER,
      windowMs: PASSWORD_WINDOW_MS,
    });

    const body = changePasswordSchema.parse(await readJson(request));

    await dbConnect();
    const user = await User.findById(current._id).select("+passwordHash");
    if (!user) {
      throw new HttpError(401, "Account is not available", "unauthenticated");
    }

    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) {
      await recordSecurityEvent({ type: "password_change_failed", reason: "wrong_password", userId: user._id, request });
      throw new HttpError(400, "Current password is incorrect", "invalid_password");
    }

    // Saving a changed passwordHash bumps tokenVersion, revoking every existing
    // session for this user. We then re-issue a session for the current client so
    // the device making the change stays signed in.
    user.passwordHash = await hashPassword(body.newPassword);
    await user.save();
    // A reset link requested before this change must not undo it.
    await retireActionTokens(user._id, "password_reset");

    await createSession({
      userId: user._id.toString(),
      platformRole: user.platformRole,
      tokenVersion: user.tokenVersion,
    });

    return ok({ success: true });
  });
}
