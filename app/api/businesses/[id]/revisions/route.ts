import { z } from "zod";
import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { listRevisions } from "@/lib/website-revisions";
import { REVISION_REASONS, REVISION_TARGETS } from "@/models/WebsiteRevision";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const querySchema = z.object({
  target: z.enum(REVISION_TARGETS).optional(),
  targetId: z.string().trim().max(64).optional(),
  reason: z.enum(REVISION_REASONS).optional(),
});

/** `GET ?target&targetId&reason` — the saved versions, without their content. */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const filter = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return ok({ revisions: await listRevisions(id, filter) }, { headers: { "Cache-Control": "no-store" } });
  });
}
