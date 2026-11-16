import { handle, ok, readJson } from "@/lib/api";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { registerPlatformAccount } from "@/lib/auth/platform-registration";
import { createSession } from "@/lib/auth/session";
import { registerSchema } from "@/lib/validation";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { assertRegistrationOpen } from "@/lib/platform-settings";

const REGISTER_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_MAX_PER_IP = 5;

/**
 * Signup with name, email and password. Creates the account and signs in at once (no emailed code,
 * an owner decision). An address that already has an account answers `409 email_taken`.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    await assertRegistrationOpen();
    await enforceRateLimit({
      key: `register:ip:${getClientIp(request)}`,
      limit: REGISTER_MAX_PER_IP,
      windowMs: REGISTER_WINDOW_MS,
    });

    const body = registerSchema.parse(await readJson(request));
    const user = await registerPlatformAccount(body);
    await createSession({
      userId: user._id.toString(),
      platformRole: user.platformRole,
      tokenVersion: user.tokenVersion,
    });
    return ok({ user: user.toJSON() }, { status: 201 });
  });
}
