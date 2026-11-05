import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { isValidObjectId } from "@/lib/ids";
import { updateCategory } from "@/lib/categories";

interface RouteContext {
  params: Promise<{ id: string; categoryId: string }>;
}

/** `PUT <category>` — edit, rename (products follow), reorder or (de)activate. */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, categoryId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    if (!isValidObjectId(categoryId)) throw new HttpError(404, "Category not found", "not_found");
    return ok({ category: await updateCategory(id, categoryId, await readJson(request)) });
  });
}
