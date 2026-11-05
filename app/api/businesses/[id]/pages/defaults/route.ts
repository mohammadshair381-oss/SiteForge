import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { generateDefaultPages, previewDefaultPages } from "@/lib/page-generation";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `GET` — the recommended pages for this business (from its type and real
 * store data), and which of them already exist. Owners and managers.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok({ plan: await previewDefaultPages(id) }, { headers: { "Cache-Control": "no-store" } });
  });
}

const bodySchema = z
  .object({
    /** Only these page kinds (from GET); omitted = every missing page. */
    keys: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
  })
  .strict();

/**
 * `POST { keys? }` — creates the missing recommended pages as DRAFTS (never
 * changes or publishes an existing page). Owners and managers, same-origin.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await enforceRateLimit({ key: `pages:defaults:${id}:${getClientIp(request) ?? "shared"}`, windowMs: 15 * 60 * 1000, limit: 10 });
    const { keys } = bodySchema.parse(await readJson(request));
    return ok({ result: await generateDefaultPages(id, { keys }) });
  });
}
