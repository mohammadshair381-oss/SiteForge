import { handle, HttpError, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { readTaxSettings, taxSettingsSchema } from "@/lib/checkout-pricing";
import { dbConnect } from "@/lib/db";
import { Business } from "@/models/Business";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — the store's tax settings. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();
    const business = await Business.findById(id).select("taxSettings").lean<{ taxSettings?: unknown }>();
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    return ok({ settings: readTaxSettings(business.taxSettings) }, { headers: { "Cache-Control": "no-store" } });
  });
}

/** `PUT <settings>` — validated, and applied only to orders placed from now on. */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const settings = taxSettingsSchema.parse(await readJson(request));
    await dbConnect();
    const result = await Business.updateOne({ _id: id }, { $set: { taxSettings: settings } });
    if (result.matchedCount === 0) throw new HttpError(404, "Business not found", "not_found");
    return ok({ settings });
  });
}
