import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { revertStorefrontDraft } from "@/lib/storefront-settings";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `POST` — the draft homepage becomes what visitors see now. The draft is kept in the history. */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    const draft = await revertStorefrontDraft(id, { createdBy: user._id });
    return ok({ draft }, { headers: { "Cache-Control": "no-store" } });
  });
}
