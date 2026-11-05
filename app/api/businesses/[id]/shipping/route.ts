import { handle, ok, HttpError, readJson } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { readShippingSettings, shippingSettingsSchema } from "@/lib/checkout-pricing";
import { Business } from "@/models/Business";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — shipping settings. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();
    const business = await Business.findById(id).select("shippingSettings currency").lean();
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    return ok({ settings: readShippingSettings(business.shippingSettings), currency: business.currency }, { headers: { "Cache-Control": "no-store" } });
  });
}

/** `PUT <settings>` — validated, written with `$set` (nothing else changes). */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const settings = shippingSettingsSchema.parse(await readJson(request));
    await dbConnect();
    const result = await Business.updateOne({ _id: id }, { $set: { shippingSettings: settings } });
    if (result.matchedCount === 0) throw new HttpError(404, "Business not found", "not_found");
    return ok({ settings });
  });
}
