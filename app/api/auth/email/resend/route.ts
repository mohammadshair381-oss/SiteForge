import { handle, ok, HttpError } from "@/lib/api";
import { requireUser, isEmailVerified } from "@/lib/auth/guards";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { issueEmailVerification } from "@/lib/auth/email-verification";

// Tight per-account limit, plus a per-IP cap so one address cannot email-spam
// many accounts. Buckets are keyed by the authenticated user id / client IP and
// are HMAC-hashed before storage (see lib/rate-limit.ts).
const RESEND_WINDOW_MS = 15 * 60 * 1000;
const RESEND_MAX_PER_USER = 3;
const RESEND_MAX_PER_IP = 10;

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();

    await enforceRateLimit({
      key: `verify-resend:user:${user._id.toString()}`,
      limit: RESEND_MAX_PER_USER,
      windowMs: RESEND_WINDOW_MS,
    });
    await enforceRateLimit({
      key: `verify-resend:ip:${getClientIp(request)}`,
      limit: RESEND_MAX_PER_IP,
      windowMs: RESEND_WINDOW_MS,
    });

    // Already verified, or a grandfathered legacy account: respond generically
    // without creating a token or sending another email.
    if (isEmailVerified(user)) {
      return ok({ sent: true });
    }

    try {
      await issueEmailVerification({
        userId: user._id,
        to: user.email,
        name: user.name,
      });
    } catch {
      // Never claim delivery, and never expose provider details.
      throw new HttpError(
        502,
        "We could not send the verification email. Please try again shortly.",
        "email_send_failed",
      );
    }

    return ok({ sent: true });
  });
}
