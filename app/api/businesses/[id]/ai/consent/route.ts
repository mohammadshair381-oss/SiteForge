import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { defaultAiModel } from "@/lib/ai-providers/registry";
import { getEntitlements } from "@/lib/billing";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import {
  AI_CONSENT_CHANGES,
  AI_CONSENT_DISCLOSURE,
  AI_CONSENT_VERSION,
  AI_PROVIDER_NAME,
  aiReadiness,
  grantAiConsent,
  listAiConsentEvents,
  revokeAiConsent,
} from "@/lib/ai-builder/consent";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `GET` — AI availability, the current disclosure, this business's consent and
 * this month's usage (counters only) for owners and managers; the consent
 * history is shown to owners.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { membership } = await requireBusinessRole(id, ["owner", "manager"]);
    const isOwner = membership.role === "owner";
    const readiness = await aiReadiness(id);
    const { status } = readiness;
    return ok(
      {
        provider: { name: AI_PROVIDER_NAME, model: status.available ? defaultAiModel() : null, ...status },
        disclosure: { version: AI_CONSENT_VERSION, points: AI_CONSENT_DISCLOSURE, changes: AI_CONSENT_CHANGES },
        availability: { ready: readiness.ready, reason: readiness.reason, message: readiness.message },
        consent: readiness.consent,
        canManage: isOwner,
        history: isOwner ? await listAiConsentEvents(id) : [],
        usage: await getAiUsageSummary(id, (await getEntitlements(id)).aiRequestsPerMonth),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

const grantSchema = z.object({ version: z.string().trim().min(1).max(40) }).strict();

/** `POST { version }` — the OWNER consents to the disclosure version they were shown. */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner"]);
    await requireVerifiedEmail();
    const { version } = grantSchema.parse(await readJson(request));
    return ok({ consent: await grantAiConsent({ businessId: id, actorId: String(user._id), version }) });
  });
}

/** `DELETE` — the OWNER revokes consent; the next AI request for this business is refused. */
export async function DELETE(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner"]);
    return ok({ consent: await revokeAiConsent({ businessId: id, actorId: String(user._id) }) });
  });
}
