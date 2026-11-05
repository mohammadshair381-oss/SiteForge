import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { websiteStatus } from "@/lib/website-publish";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — what differs between the drafts and the live website. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok(await websiteStatus(id), { headers: { "Cache-Control": "no-store" } });
  });
}
