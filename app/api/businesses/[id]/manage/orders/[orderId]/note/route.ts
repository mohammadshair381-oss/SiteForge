import { z } from "zod";
import { handle, HttpError, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { dbConnect } from "@/lib/db";
import { isValidObjectId } from "@/lib/ids";
import { Order } from "@/models/Order";

interface RouteContext {
  params: Promise<{ id: string; orderId: string }>;
}

const bodySchema = z.object({ note: z.string().trim().max(1000) });

/** `PUT { note }` — the team's own note on an order. Never shown to the shopper. */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, orderId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const { note } = bodySchema.parse(await readJson(request));
    if (!isValidObjectId(orderId)) throw new HttpError(404, "Order not found", "not_found");
    await dbConnect();
    const result = await Order.updateOne({ _id: orderId, business: id }, { $set: { internalNote: note } });
    if (result.matchedCount === 0) throw new HttpError(404, "Order not found", "not_found");
    return ok({ note });
  });
}
