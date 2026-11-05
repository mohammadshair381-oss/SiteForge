import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPublicStorefront } from "@/lib/tenant";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { readStorefrontConfig } from "@/lib/storefront-config";
import StoreFrame from "@/components/storefront/commerce/StoreFrame";
import { skinFor } from "@/components/storefront/commerce/skins";
import StorefrontPage from "../[[...slug]]/page";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const result = await getPublicStorefront(headerList.get("host"));
  if (!result) return { title: { absolute: "Shipping & returns" }, robots: { index: false } };
  return { title: { absolute: `Shipping & returns | ${result.business.name}` } };
}

/**
 * Shipping and returns text the owner published in the storefront settings.
 * A published page that already uses the "policies" slug keeps the path.
 */
export default async function StorefrontPolicies() {
  const headerList = await headers();
  const result = await getPublicStorefront(headerList.get("host"));
  if (!result) notFound();
  const { view, commerce } = await loadStorefrontFrame(result, headerList.get("cookie"));
  if (!commerce.hasPolicies) {
    // Either a page owns this path, or there is nothing to show (404).
    return StorefrontPage({ params: Promise.resolve({ slug: ["policies"] }) });
  }
  const settings = (result.business.themeSettings ?? {}) as unknown as Record<string, unknown>;
  const { policies } = readStorefrontConfig(settings.publishedStorefront);
  const skin = skinFor(view.themeId);

  return (
    <StoreFrame view={view} commerce={commerce}>
      <div className={`${skin.container} max-w-3xl py-10 sm:py-16`}>
        <h1 className={`text-3xl sm:text-4xl ${skin.heroHeading}`}>Shipping &amp; returns</h1>
        {policies.shipping && (
          <section aria-labelledby="policy-shipping" className="mt-10">
            <h2 id="policy-shipping" className={skin.heading}>Shipping</h2>
            <p className={`mt-4 whitespace-pre-line leading-7 ${skin.muted}`}>{policies.shipping}</p>
          </section>
        )}
        {policies.returns && (
          <section aria-labelledby="policy-returns" className="mt-10">
            <h2 id="policy-returns" className={skin.heading}>Returns</h2>
            <p className={`mt-4 whitespace-pre-line leading-7 ${skin.muted}`}>{policies.returns}</p>
          </section>
        )}
      </div>
    </StoreFrame>
  );
}
