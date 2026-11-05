import { handle, ok, readJson } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { forgotPasswordSchema } from "@/lib/validation";
import { issuePasswordReset } from "@/lib/auth/password-reset";
import { runAfterResponse } from "@/lib/after-response";
import { User } from "@/models/User";
import { recordSecurityEvent } from "@/lib/security-events";

// A reset request is cheap for us but must not become a way to spam a mailbox.
// Two buckets: per client address, and per (HMAC-hashed) email. The email is
// never stored in the clear — see lib/rate-limit.ts.
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_PER_IP = 10;
const FORGOT_MAX_PER_EMAIL = 3;

/**
 * Starts a password reset. The response is deliberately identical for an
 * existing active account, an unknown address and an inactive account, so the
 * endpoint cannot be used to enumerate users. Only an active matching account
 * actually receives an email, sent after the response so that its timing does
 * not reveal the account either.
 */
export async function POST(request: Request) {
  return handle(async () => {
    await enforceRateLimit({
      key: `forgot:ip:${getClientIp(request)}`,
      limit: FORGOT_MAX_PER_IP,
      windowMs: FORGOT_WINDOW_MS,
    });

    const { email } = forgotPasswordSchema.parse(await readJson(request));

    await enforceRateLimit({
      key: `forgot:email:${email}`,
      limit: FORGOT_MAX_PER_EMAIL,
      windowMs: FORGOT_WINDOW_MS,
    });

    await dbConnect();
    const user = await User.findOne({ email });
    await recordSecurityEvent({
      type: "password_reset_requested",
      userId: user && user.active ? user._id : undefined,
      email,
      request,
    });

    if (user && user.active) {
      // A provider failure must not turn this into an account-existence oracle,
      // and no provider detail may reach the client. The issued token was retired
      // by issuePasswordReset. Log a PII-free line only.
      runAfterResponse(
        async () => {
          await issuePasswordReset({ userId: user._id, to: user.email, name: user.name });
        },
        { operation: "password_reset", onError: () => console.error("[forgot-password] reset email could not be sent") },
      );
    }

    return ok({ success: true });
  });
}
