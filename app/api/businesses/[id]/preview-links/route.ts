import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { PREVIEW_LINK_DURATION_KEYS, previewLinkPath } from "@/lib/preview-link-options";
import { createPreviewLink, listPreviewLinks } from "@/lib/preview-links";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({
  scope: z.enum(["site", "page"]),
  pageId: z.string().trim().max(40).optional(),
  duration: z.enum(PREVIEW_LINK_DURATION_KEYS),
});

const noStore = { headers: { "Cache-Control": "no-store" } };

/** `GET` — open preview links, without their addresses. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok({ links: await listPreviewLinks(id) }, noStore);
  });
}

/**
 * `POST { scope, pageId?, duration }` — makes a link that shows saved drafts to
 * whoever has it. Sharing drafts outside the team needs a verified email, like
 * publishing. The address is in this response only and cannot be read again.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const user = await requireVerifiedEmail();
    await requireBusinessRole(id, ["owner", "manager"]);
    const ip = getClientIp(request);
    await enforceRateLimit({ key: `preview-links:create:${id}:${ip ?? "shared"}`, windowMs: 15 * 60 * 1000, limit: 20 });
    const body = bodySchema.parse(await readJson(request));
    const { token, link } = await createPreviewLink({ businessId: id, createdBy: user._id, ...body });
    return ok({ link, path: previewLinkPath(token) }, { status: 201, ...noStore });
  });
}
