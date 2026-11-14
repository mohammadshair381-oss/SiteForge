import { HttpError } from "@/lib/api";
import { readShippingSettings } from "@/lib/checkout-pricing";
import { getThemeMeta } from "@/lib/themes";
import { PRESET_LABELS, presetForBusinessType } from "@/lib/storefront-presets";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import { knownContactOf } from "./sanitize";
import type { ThemeId } from "@/lib/constants";

/**
 * What the AI Builder routes need to know about one store. Callers authorize
 * first (`guardAiRequest`). Two kinds of data, kept apart on purpose:
 * - `prompt`: goes through the allowlist builders (lib/ai-builder/sanitize.ts)
 *   into the provider request: business name/type/description, theme, product
 *   titles and categories, page titles.
 * - `facts`/`contact`/`known`: stay on the SERVER. `facts` is what generated
 *   text may restate (the claims check); `contact` fills contact sections
 *   without the AI seeing it; `known` tells the AI only WHETHER details exist.
 */
export async function loadAiStoreContext(businessId: string) {
  const data = await loadStorefrontPreviewData(businessId);
  if (!data) throw new HttpError(404, "Business not found", "not_found");
  const { business, products, pages, settings, extras, linkOptions, categoryNames, entitlements } = data;
  const shipping = readShippingSettings((business as { shippingSettings?: unknown }).shippingSettings);
  const policies = settings.draft.policies;

  const facts = [
    JSON.stringify({ name: business.name, description: business.description ?? "" }),
    ...products.slice(0, 200).map((p) => `${p.name} ${p.category ?? ""} ${p.price} ${p.compareAtPrice ?? ""} ${(p.description ?? "").slice(0, 400)} ${JSON.stringify(p.options ?? [])}`),
    ...pages.map((p) => `${p.title} ${JSON.stringify(p.sections ?? [])}`.slice(0, 8000)),
    policies.shipping ?? "",
    policies.returns ?? "",
    business.address ?? "",
    ...(shipping.enabled ? [shipping.deliveryInfo] : []),
    ...(shipping.enabled && shipping.freeOver !== null ? [`free delivery free shipping on orders over ${shipping.freeOver}`] : []),
    ...(shipping.enabled && shipping.flatRate === 0 ? ["free delivery free shipping"] : []),
  ];

  return {
    limit: entitlements.aiRequestsPerMonth,
    category: business.category,
    pages,
    products,
    prompt: {
      business: { name: business.name, type: PRESET_LABELS[presetForBusinessType(business.category)], description: business.description ?? "" },
      theme: { id: business.themeId, name: getThemeMeta(business.themeId as ThemeId).name },
      categories: categoryNames,
      products: products.map((p) => ({ name: p.name, category: p.category ?? "" })),
      pages: pages.map((p) => ({ title: p.title, slug: p.slug, status: p.status })),
      links: linkOptions.map((o) => o.href),
      known: {
        contactDetails: Boolean(business.contactEmail || business.phone || business.address),
        deliverySettings: shipping.enabled,
        returnsPolicy: Boolean((policies.returns ?? "").trim()),
        cashOnDelivery: extras.codAvailable === true,
        onlinePayments: extras.onlinePayments === true,
      },
    },
    contact: { email: business.contactEmail ?? "", phone: business.phone ?? "", address: business.address ?? "" },
    /** Every prompt builder removes these from what it sends. */
    knownContact: knownContactOf(business),
    /** What generated text may restate, plus the owner's request. */
    factsWith: (instruction: string) => [...facts, instruction].join("\n"),
  };
}
