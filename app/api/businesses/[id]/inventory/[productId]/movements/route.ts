import { handle, ok, HttpError } from "@/lib/api";
import { assertObjectId } from "@/lib/ids";
import { requireBusinessRole } from "@/lib/auth/guards";
import { listMovements } from "@/lib/inventory-overview";
import { Product } from "@/models/Product";

interface RouteContext {
  params: Promise<{ id: string; productId: string }>;
}

/** `GET` — stock history of one product of this business (newest 100). */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, productId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const pid = assertObjectId(productId, "product id");
    if (!(await Product.exists({ _id: pid, business: id }))) throw new HttpError(404, "Product not found", "not_found");
    return ok({ movements: await listMovements(id, String(pid)) }, { headers: { "Cache-Control": "no-store" } });
  });
}
