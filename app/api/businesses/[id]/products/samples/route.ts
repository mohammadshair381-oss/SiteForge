import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertBusinessNotSuspended } from "@/lib/publish-gates";
import { addSampleProducts, archiveSampleProducts, countSampleProducts } from "@/lib/sample-products";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({ action: z.enum(["add", "remove"]) });

/**
 * `POST { action: "add" | "remove" }`: adds this store's starter samples (hidden drafts,
 * within the plan's product limit), or archives every sample still unchanged.
 * Owners and managers, like the rest of store setup (lib/sample-products.ts).
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const { action } = bodySchema.parse(await readJson(request));
    if (action === "remove") {
      await assertBusinessNotSuspended(id);
      const removed = await archiveSampleProducts(id);
      return ok({ removed, remaining: await countSampleProducts(id) });
    }
    const added = await addSampleProducts(id);
    return ok({ added, remaining: await countSampleProducts(id) });
  });
}
