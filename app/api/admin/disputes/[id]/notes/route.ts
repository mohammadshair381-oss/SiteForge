import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { addDisputeNote } from "@/lib/payments/disputes";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const noteSchema = z.object({ note: z.string().max(1000) }).strict();

/**
 * `POST /api/admin/disputes/[id]/notes` `{ note }` (super admin only).
 * Appends an internal note to the dispute history and the admin audit log.
 * Notes never change the dispute status, the order or the payment.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    const { id } = await context.params;
    const { note } = noteSchema.parse(await readJson(request));
    await dbConnect();
    return ok(await addDisputeNote({ actorId: String(admin._id), disputeId: id, note }));
  });
}
