import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { readShippingSettings, readTaxSettings } from "@/lib/checkout-pricing";
import { Business } from "@/models/Business";
import ShippingSettingsForm from "@/components/dashboard/ShippingSettingsForm";

export const dynamic = "force-dynamic";

export default async function BusinessShipping({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);
  await dbConnect();
  const business = await Business.findById(id).select("shippingSettings taxSettings currency").lean();
  if (!business) notFound();
  return (
    <ShippingSettingsForm
      businessId={id}
      currency={(business.currency || "USD").toUpperCase()}
      initial={readShippingSettings(business.shippingSettings)}
      initialTax={readTaxSettings(business.taxSettings)}
    />
  );
}
