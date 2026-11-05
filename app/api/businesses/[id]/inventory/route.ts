import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { ADJUSTMENT_REASONS, adjustStock } from "@/lib/inventory";
import { listInventory } from "@/lib/inventory-overview";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — stock per product/variant with low-stock state. Owners, managers, staff. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    return ok({ items: await listInventory(id) }, { headers: { "Cache-Control": "no-store" } });
  });
}

const adjustSchema = z
  .object({
    productId: z.string().regex(/^[a-f0-9]{24}$/i),
    variantId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(),
    delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    set: z.number().int().min(0).max(1_000_000).optional(),
    expected: z.number().int().min(0).max(1_000_000).optional(),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: z.string().trim().max(200).prefault(""),
  })
  .refine((v) => (v.delta !== undefined) !== (v.set !== undefined), "Send either delta or set");

/**
 * `POST` — one stock adjustment (delta, or absolute set with the value the
 * user saw). Atomic and recorded in the stock history.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const body = adjustSchema.parse(await readJson(request));
    const result = await adjustStock({ businessId: id, ...body, actorId: String(user._id) });
    return ok(result, { headers: { "Cache-Control": "no-store" } });
  });
}
