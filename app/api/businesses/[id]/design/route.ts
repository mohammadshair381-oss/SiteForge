import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { discardDesignDraft, getDesignState, saveDesignDraft, updateDesignDraft } from "@/lib/design-service";
import { expectedDraftVersion } from "@/lib/draft-version";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — draft and live design. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok(await getDesignState(id), { headers: { "Cache-Control": "no-store" } });
  });
}

/** `PUT <design>` — saves the DRAFT. A theme outside the plan is refused. */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await saveDesignDraft(id, await readJson(request), { expectedVersion: expectedDraftVersion(request) });
    return ok(await getDesignState(id), { headers: { "Cache-Control": "no-store" } });
  });
}

/** `PATCH <some fields>` — changes only these fields of the DRAFT, such as choosing a theme. */
export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await updateDesignDraft(id, await readJson(request));
    return ok(await getDesignState(id), { headers: { "Cache-Control": "no-store" } });
  });
}

/** `DELETE` — forgets the draft; the live design stays as it is. */
export async function DELETE(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await discardDesignDraft(id);
    return ok(await getDesignState(id), { headers: { "Cache-Control": "no-store" } });
  });
}
