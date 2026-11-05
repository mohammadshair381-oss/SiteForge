import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { assertNotInMaintenance } from "@/lib/platform-settings";
import { PUBLISH_ROLES } from "@/lib/publish-gates";
import { publishWebsiteItems } from "@/lib/website-publish";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({ items: z.array(z.string().trim().min(1).max(80)).min(1).max(100) });

/**
 * `POST { items }` — publishes the chosen drafts (see lib/website-publish.ts).
 * Same gates as every publish: verified email, owner or manager, a plan that
 * allows publishing, not suspended. Each item succeeds or fails on its own.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const user = await requireVerifiedEmail();
    await assertNotInMaintenance();
    await requireBusinessRole(id, PUBLISH_ROLES);
    const { items } = bodySchema.parse(await readJson(request));
    return ok(await publishWebsiteItems(id, [...new Set(items)], user._id), { headers: { "Cache-Control": "no-store" } });
  });
}
