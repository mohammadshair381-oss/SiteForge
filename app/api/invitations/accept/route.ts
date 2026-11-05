import { handle, ok, readJson } from "@/lib/api";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireVerifiedEmail } from "@/lib/auth/guards";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { acceptInvitation } from "@/lib/team-invitations";

/** `POST { token }` — joins the team. Needs a signed-in, confirmed account with the invited address. */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    await enforceRateLimit({ key: `invitation-accept:ip:${getClientIp(request)}`, limit: 20, windowMs: 15 * 60 * 1000 });
    const user = await requireVerifiedEmail();
    const body = (await readJson(request)) as { token?: unknown };
    return ok(await acceptInvitation({ rawToken: body?.token, user }));
  });
}
