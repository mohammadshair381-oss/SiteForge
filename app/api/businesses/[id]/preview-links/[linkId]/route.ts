import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { revokePreviewLink } from "@/lib/preview-links";

interface RouteContext {
  params: Promise<{ id: string; linkId: string }>;
}

/** `DELETE` — ends a preview link right away. Scoped to this business. */
export async function DELETE(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, linkId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await revokePreviewLink(id, linkId);
    return ok({ revoked: true });
  });
}
