/**
 * Business-type homepage presets (pure; no I/O). A preset is only a STARTING
 * layout: an ordered list of homepage sections with headings that suit the
 * kind of business. It never contains products, prices, reviews, brands or
 * claims: every section is filled from the store's real data at render time
 * (lib/storefront-home.ts) and hidden while it has nothing real to show.
 *
 * The business type is `Business.category` (lib/constants.ts
 * BUSINESS_CATEGORIES), never a product category.
 */

// Append only: a store's config records the preset it started from.
export const PRESET_KEYS = ["general", "clothing", "shoes", "electronics", "grocery", "furniture", "cosmetics", "hardware", "services", "realestate", "fitness", "education", "creative"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

export const PRESET_LABELS: Record<PresetKey, string> = {
  general: "General retail",
  clothing: "Clothing",
  shoes: "Shoes",
  electronics: "Electronics",
  grocery: "Grocery",
  furniture: "Furniture",
  cosmetics: "Cosmetics",
  hardware: "Hardware",
  services: "Professional services",
  realestate: "Real estate",
  fitness: "Fitness and sports",
  education: "Education and training",
  creative: "Creative and events",
};

/** How a store speaks about what it offers: a law firm has services, not a shop. */
export interface StoreVocabulary {
  /** Header link to everything on offer. */
  shopAll: string;
  /** Hero button when the owner has not written one. */
  heroCta: string;
  /** Footer column heading. */
  shopHeading: string;
  /** The catalog page title and its footer link. */
  catalogTitle: string;
}

const VOCABULARY: Partial<Record<PresetKey, StoreVocabulary>> = {
  services: { shopAll: "All services", heroCta: "View services", shopHeading: "Services", catalogTitle: "All services" },
  realestate: { shopAll: "All listings", heroCta: "View listings", shopHeading: "Listings", catalogTitle: "All listings" },
  fitness: { shopAll: "All programs", heroCta: "See programs", shopHeading: "Programs", catalogTitle: "All programs" },
  education: { shopAll: "All courses", heroCta: "Browse courses", shopHeading: "Courses", catalogTitle: "All courses" },
  creative: { shopAll: "All packages", heroCta: "See packages", shopHeading: "Packages", catalogTitle: "All packages" },
};

const SHOP_VOCABULARY: StoreVocabulary = { shopAll: "Shop all", heroCta: "Shop now", shopHeading: "Shop", catalogTitle: "All products" };

export function storeVocabulary(businessType: string | null | undefined): StoreVocabulary {
  const type = (businessType ?? "").trim().toLowerCase();
  if (type === "food") return { shopAll: "Full menu", heroCta: "See the menu", shopHeading: "Menu", catalogTitle: "Our menu" };
  if (type === "beauty") return { shopAll: "All treatments", heroCta: "See treatments", shopHeading: "Treatments", catalogTitle: "All treatments" };
  return VOCABULARY[presetForBusinessType(type)] ?? SHOP_VOCABULARY;
}

/**
 * Business type -> preset. Dedicated types map to their preset; the broader
 * legacy types map to the closest fit ("food" sells groceries/food, "beauty"
 * sells cosmetics, "technology" sells devices); everything else is general.
 */
const TYPE_TO_PRESET: Record<string, PresetKey> = {
  retail: "general",
  clothing: "clothing",
  shoes: "shoes",
  electronics: "electronics",
  technology: "electronics",
  grocery: "grocery",
  food: "grocery",
  furniture: "furniture",
  cosmetics: "cosmetics",
  beauty: "cosmetics",
  hardware: "hardware",
  services: "services",
  realestate: "realestate",
  fitness: "fitness",
  education: "education",
  creative: "creative",
};

export function presetForBusinessType(businessType: string | null | undefined): PresetKey {
  return TYPE_TO_PRESET[(businessType ?? "").trim().toLowerCase()] ?? "general";
}

/** Raw (unparsed) section definition; validated by storefront-config. */
export interface PresetSection {
  id: string;
  type: "categories" | "featured" | "bestSellers" | "newArrivals" | "sale" | "promotions" | "benefits" | "story";
  title: string;
  subtitle?: string;
}

const S = {
  categories: (title = "Shop by category"): PresetSection => ({ id: "categories", type: "categories", title }),
  featured: (title: string): PresetSection => ({ id: "featured", type: "featured", title }),
  bestSellers: (title = "Best sellers"): PresetSection => ({ id: "best-sellers", type: "bestSellers", title, subtitle: "Most ordered" }),
  newArrivals: (title = "New arrivals"): PresetSection => ({ id: "new-arrivals", type: "newArrivals", title, subtitle: "Just added" }),
  sale: (title = "Best deals"): PresetSection => ({ id: "sale", type: "sale", title, subtitle: "Reduced prices" }),
  promotions: (): PresetSection => ({ id: "promotions", type: "promotions", title: "" }),
  benefits: (title = "Shopping information"): PresetSection => ({ id: "benefits", type: "benefits", title }),
  story: (title = ""): PresetSection => ({ id: "story", type: "story", title }),
};

/**
 * Section lists per preset (after the hero). The last two sections (about
 * the business, shopping information) are useful for new stores and stay
 * hidden until there is real text for them.
 */
export const PRESET_SECTIONS: Record<PresetKey, PresetSection[]> = {
  general: [S.categories(), S.featured("Featured products"), S.newArrivals(), S.bestSellers(), S.promotions(), S.story(), S.benefits()],
  clothing: [S.categories(), S.newArrivals(), S.featured("Featured collection"), S.bestSellers(), S.promotions(), S.story("About us"), S.benefits()],
  shoes: [S.categories("Shop by style"), S.featured("Featured shoes"), S.bestSellers(), S.newArrivals(), S.promotions(), S.story(), S.benefits()],
  electronics: [S.categories("Product categories"), S.featured("Featured electronics"), S.newArrivals("Latest products"), S.sale("Best deals"), S.benefits("Shopping information"), S.story()],
  grocery: [S.categories(), S.featured("Daily essentials"), S.bestSellers("Popular products"), S.sale("Best deals"), S.benefits("Delivery information"), S.story()],
  furniture: [S.categories("Shop by room"), S.featured("Featured furniture"), S.bestSellers(), S.promotions(), S.story("About us"), S.benefits()],
  // No "Featured brands": SiteForge has no brand data, and a brands section
  // is shown only from real data.
  cosmetics: [S.categories(), S.bestSellers(), S.newArrivals(), S.promotions(), S.story(), S.benefits()],
  // Service-led businesses lead with what they offer. The same rules apply:
  // every section shows real data and stays hidden until there is some.
  services: [S.featured("Our services"), S.categories("What we do"), S.story("About us"), S.promotions(), S.benefits("Good to know")],
  realestate: [S.featured("Featured listings"), S.categories("Browse by type"), S.newArrivals("New listings"), S.story("About us"), S.benefits("Good to know")],
  fitness: [S.featured("Programs and memberships"), S.categories("Find your program"), S.promotions(), S.story("About us"), S.benefits("Good to know")],
  education: [S.featured("Popular courses"), S.categories("Browse by subject"), S.newArrivals("New courses"), S.story("About us"), S.benefits("Good to know")],
  creative: [S.featured("Packages"), S.categories("What we do"), S.promotions(), S.story("About us"), S.benefits("Good to know")],
  hardware: [S.categories("Product categories"), S.featured("Featured products"), S.bestSellers("Popular tools"), S.promotions(), S.story("About us"), S.benefits()],
};
