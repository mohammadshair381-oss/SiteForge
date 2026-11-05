import { handle, ok, readJson } from "@/lib/api";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { getOptionalUser } from "@/lib/auth/guards";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { inspectInvitation } from "@/lib/team-invitations";

/** `POST { token }` — what the link's holder is being invited to. */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    await enforceRateLimit({ key: `invitation-inspect:ip:${getClientIp(request)}`, limit: 30, windowMs: 15 * 60 * 1000 });
    const body = (await readJson(request)) as { token?: unknown };
    const user = await getOptionalUser();
    return ok(await inspectInvitation(body?.token, user?.email ?? null), { headers: { "Cache-Control": "no-store" } });
  });
}
