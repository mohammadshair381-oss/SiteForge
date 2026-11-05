import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { env, isProduction } from "@/lib/env";
import { storeLinkRoot } from "@/lib/host";
import { BUSINESS_CATEGORIES, type ThemeId } from "@/lib/constants";
import { readShippingSettings, readTaxSettings } from "@/lib/checkout-pricing";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import { loadSetupFacts } from "@/lib/store-setup-data";
import { PRESET_LABELS, presetForBusinessType } from "@/lib/storefront-presets";
import { brandPresetFor } from "@/lib/brand-presets";
import { getThemeAccess } from "@/lib/billing";
import { SETUP_STEPS, resumeStep, stepStates, storeReadiness, type SetupStep } from "@/lib/store-setup";
import { Category } from "@/models/Category";
import { Product } from "@/models/Product";
import { ProductCategory } from "@/models/ProductCategory";
import SetupWizard, { SetupFooter } from "@/components/dashboard/setup/SetupWizard";
import BusinessStep from "@/components/dashboard/setup/BusinessStep";
import BrandStep from "@/components/dashboard/setup/BrandStep";
import StructureStep from "@/components/dashboard/setup/StructureStep";
import RecommendedPages from "@/components/dashboard/RecommendedPages";
import LaunchStep from "@/components/dashboard/setup/LaunchStep";
import ProductsManager from "@/components/dashboard/ProductsManager";
import { aiReadiness, aiStateOf } from "@/lib/ai-builder/consent";
import ShippingSettingsForm from "@/components/dashboard/ShippingSettingsForm";
import PaymentSettings from "@/components/dashboard/PaymentSettings";
import OnlinePaymentAccount from "@/components/dashboard/OnlinePaymentAccount";
import StorefrontSettings from "@/components/dashboard/StorefrontSettings";

export const dynamic = "force-dynamic";

/**
 * Guided store setup. Owners and managers only (the same people who can
 * edit the website). Every step saves through the store's existing routes
 * and components; this page gathers the store's real state so steps show
 * what is actually done, and resumes where the owner left off.
 */
export default async function StoreSetup({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const { id } = await params;
  const { step: requested } = await searchParams;
  const { user, membership } = await requireBusinessRole(id, ["owner", "manager"]);
  await dbConnect();

  const loaded = await loadSetupFacts(id, user);
  if (!loaded) notFound();
  const { business, facts, progress, settings, entitlements } = loaded;
  const { activeProducts, activeProductsWithoutImage: withoutImage, accountsEnabled } = facts;
  const states = stepStates(facts, progress);
  const step: SetupStep = (SETUP_STEPS as readonly string[]).includes(requested ?? "") ? (requested as SetupStep) : resumeStep(facts, progress);
  const presetKey = presetForBusinessType(business.category);
  const typeLabel = PRESET_LABELS[presetKey];

  const wizard = (content: React.ReactNode) => (
    <SetupWizard businessId={id} businessName={business.name} step={step} states={states}>
      {content}
    </SetupWizard>
  );

  if (step === "business") {
    // Same list as business creation: platform types, minus any deactivated in the admin.
    const stored = await Category.find({}).select("key name active").lean();
    const byKey = new Map(stored.map((c) => [c.key, c]));
    const types = BUSINESS_CATEGORIES.filter((c) => byKey.get(c.key)?.active !== false || c.key === business.category).map((c) => ({ key: c.key, name: byKey.get(c.key)?.name ?? c.name }));
    return wizard(
      <BusinessStep
        businessTypes={types}
        presetLabel={typeLabel}
        initial={{
          name: business.name,
          category: business.category,
          description: business.description ?? "",
          address: business.address ?? "",
          serviceArea: business.serviceArea ?? "",
          contactEmail: business.contactEmail ?? "",
          phone: business.phone ?? "",
          logoUrl: business.logoUrl ?? "",
        }}
      />,
    );
  }

  if (step === "products") {
    const [products, categoryOptions] = await Promise.all([
      Product.find({ business: id, status: { $ne: "archived" } }).sort({ createdAt: -1 }).lean(),
      ProductCategory.find({ business: id, active: true }).sort({ sort: 1, name: 1 }).select("name").lean(),
    ]);
    return wizard(
      <div>
        <ul className="mb-5 grid gap-2 text-sm text-slate-700 sm:grid-cols-3">
          <li className="rounded-xl bg-slate-50 px-3 py-2">
            <span className="block font-heading text-lg font-semibold text-slate-900">{activeProducts}</span>active product{activeProducts === 1 ? "" : "s"}
          </li>
          <li className="rounded-xl bg-slate-50 px-3 py-2">
            <span className="block font-heading text-lg font-semibold text-slate-900">{withoutImage}</span>without a photo
          </li>
          <li className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5">
            Give each product a photo, a price and a category. Add sizes or colours with <strong>Variants</strong>, and track stock under <strong>Inventory</strong>.
          </li>
        </ul>
        <ProductsManager
          businessId={id}
          initialProducts={products.map((product) => ({
            _id: String(product._id),
            name: product.name,
            description: product.description,
            price: product.price,
            compareAtPrice: typeof product.compareAtPrice === "number" ? product.compareAtPrice : null,
            currency: product.currency,
            imageUrl: product.imageUrl,
            category: product.category,
            seoTitle: product.seoTitle ?? "",
            seoDescription: product.seoDescription ?? "",
            imageAlt: product.imageAlt ?? "",
            status: product.status,
            stock: product.stock ?? 0,
            variantCount: (product.options ?? []).length > 0 ? (product.variants ?? []).filter((v) => !v.archived).length : 0,
          }))}
          currency={business.currency ?? "USD"}
          canArchive
          canViewBilling={membership.role === "owner"}
          categoryOptions={categoryOptions.map((c) => c.name)}
          entitlements={{ planName: entitlements.planName, productLimit: entitlements.productLimit, active: entitlements.active }}
          aiState={aiStateOf(await aiReadiness(id, "product"))}
        />
        <SetupFooter continueLabel="Continue" canContinue />
      </div>,
    );
  }

  if (step === "settings") {
    const host = (await headers()).get("host");
    const platformOrigin = env().APP_URL.trim().replace(/\/+$/, "") || (host ? `${isProduction() ? "https" : "http"}://${host}` : "");
    const preview = await loadStorefrontPreviewData(id);
    const heading = (title: string, detail: string) => (
      <div className="mb-3">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-600">{detail}</p>
      </div>
    );
    return wizard(
      <div className="space-y-8">
        <section aria-label="Delivery">
          {heading("Delivery", "Delivery charges and whether checkout asks for an address.")}
          <ShippingSettingsForm businessId={id} currency={(business.currency || "USD").toUpperCase()} initial={readShippingSettings(business.shippingSettings)} initialTax={readTaxSettings(business.taxSettings)} />
        </section>
        <section aria-label="Payments" className="space-y-4">
          {heading(
            "Payments",
            membership.role === "owner"
              ? "How customers pay. Online payments are only shown as connected after you add your own payment account keys below."
              : "Payment settings are managed by the store owner.",
          )}
          <PaymentSettings businessId={id} canManage={membership.role === "owner"} initialCodEnabled={business.codEnabled === true} initialGuestCodEnabled={business.guestCodEnabled === true} accountsEnabled={accountsEnabled} />
          {membership.role === "owner" && <OnlinePaymentAccount businessId={id} webhookUrl={`${platformOrigin}/api/webhooks/razorpay/${id}`} />}
        </section>
        <section aria-label="Customer accounts">
          {heading("Customer accounts", "Whether shoppers can create an account, sign in and see their orders.")}
          <p className={`rounded-xl border px-3 py-2 text-sm ${accountsEnabled ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
            {accountsEnabled
              ? "Customer accounts are available: shoppers can sign in from your store header."
              : "Customer accounts are not available on this platform yet. Shoppers check out as guests, and cash on delivery (which needs a signed-in customer) is not offered."}
          </p>
        </section>
        <section aria-label="Contact details">
          {heading("Contact details", "Shown in your store footer and on your policies page.")}
          <p className="text-sm text-slate-700">
            {[business.contactEmail, business.phone, business.address, business.serviceArea].filter(Boolean).join(" · ") || "No contact details yet."}{" "}
            <span className="text-slate-500">(Edit them in Business details.)</span>
          </p>
        </section>
        <section aria-label="Policies and footer">
          {heading("Policies, announcement and footer", "Your shipping and returns policies, an optional announcement bar, and footer text.")}
          {preview && (
            <StorefrontSettings
              businessId={id}
              storeLive={business.status === "published"}
              initialDraft={settings.draft}
              hasPublished={settings.published !== null}
              initialHasUnpublishedChanges={settings.hasUnpublishedChanges}
              linkOptions={preview.linkOptions}
            />
          )}
        </section>
        <SetupFooter continueLabel="Continue" />
      </div>,
    );
  }

  // Brand, homepage and launch show the store itself: the same draft preview as the editor.
  const preview = await loadStorefrontPreviewData(id);
  if (!preview) notFound();

  if (step === "brand") {
    const brand = brandPresetFor(business.category);
    const themeSettings = (business.themeSettings ?? {}) as unknown as Record<string, unknown>;
    return wizard(
      <BrandStep
        view={preview.view}
        config={settings.draft}
        extras={preview.extras}
        recommendedTheme={brand.theme}
        palettes={brand.palettes}
        typeLabel={typeLabel}
        storeLive={business.status === "published"}
        themeAccess={await getThemeAccess(id)}
        initial={{
          themeId: business.themeId as ThemeId,
          primaryColor: preview.view.theme.primaryColor,
          accentColor: preview.view.theme.accentColor,
          font: (["sans", "serif", "mono"].includes(String(themeSettings.font)) ? themeSettings.font : "sans") as "sans" | "serif" | "mono",
          logoUrl: business.logoUrl ?? "",
        }}
      />,
    );
  }

  if (step === "structure") {
    return wizard(
      <div className="space-y-8">
        <StructureStep view={preview.view} draft={settings.draft} extras={preview.extras} presetKey={presetKey} presetLabel={typeLabel} />
        {/* The rest of the website: About, Contact, FAQ and policy pages for this store type (drafts). */}
        <RecommendedPages businessId={id} canManage compact />
      </div>,
    );
  }

  const rootDomain = storeLinkRoot((await headers()).get("host"));
  return wizard(
    <LaunchStep
      view={preview.view}
      draft={settings.draft}
      extras={preview.extras}
      readiness={storeReadiness(facts)}
      published={business.status === "published"}
      hasUnpublishedChanges={settings.hasUnpublishedChanges}
      storeUrl={business.subdomain ? `${isProduction() ? "https" : "http"}://${business.subdomain}.${rootDomain}` : null}
    />,
  );
}
