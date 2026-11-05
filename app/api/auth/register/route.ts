import { handle, ok, readJson } from "@/lib/api";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { processRegistration } from "@/lib/auth/platform-registration";
import { registerSchema } from "@/lib/validation";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { runAfterResponse } from "@/lib/after-response";
import { assertRegistrationOpen } from "@/lib/platform-settings";

const REGISTER_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_MAX_PER_IP = 5;

/**
 * Starts a registration. The answer, and how long it takes, are the same whether
 * or not the address already has an account: everything that depends on that runs
 * after the response, and nobody is signed in here. The account is usable once its
 * owner has confirmed the address with the emailed link.
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
    runAfterResponse(() => processRegistration(body), {
      operation: "register",
      onError: () => console.error("[register] could not finish a registration"),
    });
    return ok({ accepted: true }, { status: 202 });
  });
}
