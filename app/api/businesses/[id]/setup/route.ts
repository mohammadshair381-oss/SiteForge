import { z } from "zod";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { dbConnect } from "@/lib/db";
import { SETUP_STEPS, readSetupProgress } from "@/lib/store-setup";
import { Business } from "@/models/Business";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    /** The step the owner is on now (resume point). */
    step: z.enum(SETUP_STEPS).optional(),
    /** A step the owner confirmed. */
    done: z.enum(SETUP_STEPS).optional(),
    /** A step the owner chose to do later. */
    skipped: z.enum(SETUP_STEPS).optional(),
    /** The owner finished the wizard. */
    finished: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => b.step || b.done || b.skipped || b.finished, "Nothing to update")
  .refine((b) => !(b.done && b.skipped), "Send either a confirmed or a skipped step");

/**
 * Store setup progress (lib/store-setup.ts). It only remembers where the
 * owner or manager is in the wizard and which steps they confirmed or
 * skipped; it never changes store data (every step saves through its own
 * existing route, with that route's checks).
 */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const body = bodySchema.parse(await readJson(request));
    await dbConnect();

    const update: Record<string, Record<string, unknown>> = {};
    const set = (key: string, value: unknown) => ((update.$set ??= {})[key] = value);
    if (body.step) set("setup.step", body.step);
    if (body.finished) set("setup.completedAt", new Date());
    if (body.done) {
      update.$addToSet = { "setup.done": body.done };
      update.$pull = { "setup.skipped": body.done };
    }
    if (body.skipped) {
      update.$addToSet = { "setup.skipped": body.skipped };
      update.$pull = { "setup.done": body.skipped };
    }

    const business = await Business.findOneAndUpdate({ _id: id }, update, { new: true, projection: { setup: 1 } }).lean();
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    return ok({ setup: readSetupProgress(business.setup) });
  });
}
