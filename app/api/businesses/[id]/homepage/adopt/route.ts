import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { adoptLegacyHomepage } from "@/lib/legacy-homepage";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `POST` — moves an older homepage into a Home page record. Visitors see no change. */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    return ok(await adoptLegacyHomepage(id, user._id), { headers: { "Cache-Control": "no-store" } });
  });
}
