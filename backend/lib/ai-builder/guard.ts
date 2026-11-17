import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { Business } from "@/models/Business";
import { assertAiAvailable, assertAiTaskAvailable } from "./provider";
import { assertAiConsent } from "./consent";
import type { AiTask } from "./usage";

const MINUTE = 60 * 1000;

/**
 * Guards for every AI builder request, in this order (docs/ai-website-
 * builder-plan.md, M0):
 * 1. same-origin JSON (no cross-site form or script can trigger a paid call);
 * 2. owner or manager of THIS business, with a verified email; the business
 *    must not be suspended;
 * 3. the AI kill switch, a configured provider and a usable route for this
 *    task, before any rate-limit budget is spent or any store data is read;
 * 4. the owner's consent to the current AI disclosure (lib/ai-builder/consent.ts);
 * 5. burst limit per business and address, hourly limit per member, daily cap
 *    per business.
 * The plan's monthly allowance is reserved by the route right before the
 * provider call (lib/ai-builder/usage.ts), after the request is validated.
 */
export async function guardAiRequest(request: Request, businessId: string, task: AiTask, options: { /** For a job of many short steps, such as generating a website. */ burstLimit?: number } = {}) {
  assertSameOriginJsonRequest(request);
  const { user } = await requireBusinessRole(businessId, ["owner", "manager"]);
  await requireVerifiedEmail();
  await assertAiAvailable();
  await assertAiTaskAvailable(task);

  await dbConnect();
  const business = await Business.findById(businessId).select("status").lean<{ status: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  if (business.status === "suspended") {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  await assertAiConsent(businessId);

  const ip = getClientIp(request);
  await enforceRateLimit({ key: `ai:${task}:${businessId}:${ip}`, windowMs: 15 * MINUTE, limit: options.burstLimit ?? 10 });
  await enforceRateLimit({ key: `ai:user:${String(user._id)}`, windowMs: 60 * MINUTE, limit: 20 });
  await enforceRateLimit({ key: `ai:business:${businessId}`, windowMs: 24 * 60 * MINUTE, limit: 60 });
  return { user };
}
