import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { dbConnect } from "@/lib/db";
import { validateDomain } from "@/lib/domain";
import { checkDomainActivation } from "@/lib/domains/activation";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 20;
const MAX_PER_BUSINESS = 10;

/**
 * `POST /api/businesses/[id]/domains/activation` with `{ domain }`: checks that the
 * store's chosen domain points at SiteForge and has a valid certificate, and makes it
 * active only if both are true. Owner only. Safe to repeat. It claims no domain, so it
 * does not wait for the indexes a new claim needs, and a store already on a domain can
 * always check it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner"]);
    await dbConnect();
    await enforceRateLimit({ key: `domain-activation:ip:${getClientIp(request)}`, limit: MAX_PER_IP, windowMs: WINDOW_MS });
    await enforceRateLimit({ key: `domain-activation:business:${id}`, limit: MAX_PER_BUSINESS, windowMs: WINDOW_MS });

    const body = await readJson(request);
    let domain: string;
    try {
      domain = validateDomain((body as { domain?: unknown }).domain as string | null | undefined);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid domain", "invalid_domain");
    }
    return ok(await checkDomainActivation({ businessId: id, domain }));
  });
}
