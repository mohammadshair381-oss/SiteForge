import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { expectedDraftVersion } from "@/lib/draft-version";
import { getStorefrontSettings, saveStorefrontDraft } from "@/lib/storefront-settings";
import { recordCheckpointIfDue } from "@/lib/website-revisions";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — draft and published storefront homepage settings. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok(await getStorefrontSettings(id), { headers: { "Cache-Control": "no-store" } });
  });
}

/** `PUT <config>` — saves the DRAFT (shown in the preview, not on the public store). */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    const input = await readJson(request);
    const { draft: before } = await getStorefrontSettings(id);
    const draft = await saveStorefrontDraft(id, input, { expectedVersion: expectedDraftVersion(request) });
    await recordCheckpointIfDue({ businessId: id, target: "home", label: "Homepage", snapshot: before, createdBy: user._id });
    const { draftVersion } = await getStorefrontSettings(id);
    return ok({ draft, version: draftVersion }, { headers: { "Cache-Control": "no-store" } });
  });
}
