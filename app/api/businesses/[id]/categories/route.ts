import { handle, ok, created, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { createCategory, importCategories, listCategories } from "@/lib/categories";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — managed categories (with product counts) and unmanaged category texts. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok(await listCategories(id), { headers: { "Cache-Control": "no-store" } });
  });
}

/**
 * `POST <category>` creates one; `POST { action: "import" }` manages every
 * existing product category text (explicit owner action, no auto-migration).
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const body = (await readJson(request)) as Record<string, unknown>;
    if (body?.action === "import") {
      return ok({ imported: await importCategories(id), ...(await listCategories(id)) });
    }
    return created({ category: await createCategory(id, body) });
  });
}
