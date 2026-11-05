import { handle, ok } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { assertNotInMaintenance } from "@/lib/platform-settings";
import { PUBLISH_ROLES } from "@/lib/publish-gates";
import { publishStorefrontSettings } from "@/lib/storefront-settings";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `POST` — publishes the saved storefront homepage draft to the public store.
 * Same gates as publishing the store: verified email, owner or manager,
 * a plan that allows publishing, not suspended.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireVerifiedEmail();
    await assertNotInMaintenance();
    await requireBusinessRole(id, PUBLISH_ROLES);
    const published = await publishStorefrontSettings(id);
    return ok({ published }, { headers: { "Cache-Control": "no-store" } });
  });
}
