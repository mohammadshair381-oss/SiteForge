import type { ThemeId } from "@/lib/constants";
import { getThemeMeta } from "@/lib/themes";
import type { StorefrontView } from "@/lib/storefront";
import { buildCommerceData, type CommerceData } from "@/lib/storefront-home";
import { sampleImage, sampleProductsFor } from "@/lib/theme-preview-samples";

/**
 * Sample stores for the public theme previews: the real renderer with fictional
 * businesses, so a theme can be seen as a finished website. Pages using them say
 * that they are samples. No ratings, discounts or sales figures
 * (lib/theme-preview-samples.ts).
 */
interface SampleStore {
  name: string;
  /** Business type: decides the words the store uses. */
  category: string;
  about: string;
  announcement: string;
  eyebrow: string;
  headline: string;
  description: string;
  hero: string;
  align?: "left" | "center";
  overlay: number;
  featured: string;
  promotions: Array<{ eyebrow: string; title: string; text: string; cta: string; image: string }>;
  shipping: string;
  returns: string;
}

const STORES: Record<ThemeId, SampleStore> = {
  aurora: {
    name: "Lumen & Co",
    category: "retail",
    about: "Lumen & Co makes a small collection of well-made things for everyday life, chosen to last and designed to be lived with.",
    announcement: "New season pieces are in",
    eyebrow: "The everyday edit",
    headline: "Quiet luxury for ordinary days",
    description: "A considered collection of objects made to be used, carried and kept.",
    hero: "hero-aurora",
    overlay: 25,
    featured: "The collection",
    promotions: [
      { eyebrow: "At home", title: "Slow evenings", text: "Soft light and warm scent for the end of the day.", cta: "Shop home", image: "promo-candle" },
      { eyebrow: "The space", title: "Rooms that breathe", text: "Pieces chosen to sit quietly together.", cta: "Explore", image: "promo-living-room" },
    ],
    shipping: "Delivered in 2 to 4 days",
    returns: "30 days to change your mind",
  },
  market: {
    name: "Everyday Market",
    category: "retail",
    about: "Everyday Market is your neighbourhood shop for useful things at fair prices, from the kitchen to the desk.",
    announcement: "Free delivery on orders over $50",
    eyebrow: "Everything for every day",
    headline: "Useful things, fair prices",
    description: "Thousands of everyday essentials, ready to ship today.",
    hero: "hero-market",
    overlay: 45,
    featured: "Popular right now",
    promotions: [
      { eyebrow: "Back to work", title: "Desk essentials", text: "Notebooks, pens and more.", cta: "Shop", image: "promo-stationery" },
      { eyebrow: "Visit us", title: "Open seven days", text: "Pick up in store, free.", cta: "See more", image: "promo-open-shop" },
    ],
    shipping: "Same-day dispatch before 3 pm",
    returns: "Easy 30-day returns",
  },
  bistro: {
    name: "Hearth & Crumb",
    category: "food",
    about: "Hearth & Crumb is a neighbourhood bakery and coffee bar. We mill our own flour, roast our own beans and bake every morning.",
    announcement: "Open daily from 7 am",
    eyebrow: "Bakery and coffee bar",
    headline: "Baked fresh every morning",
    description: "Slow-proved bread, warm pastries and coffee roasted a few streets away.",
    hero: "hero-bistro",
    overlay: 20,
    featured: "Today's menu",
    promotions: [
      { eyebrow: "Evenings", title: "Supper at the long table", text: "Seasonal plates, every Friday and Saturday.", cta: "See the menu", image: "promo-dining" },
      { eyebrow: "Mornings", title: "Your usual, ready to go", text: "Order ahead and skip the queue.", cta: "Order ahead", image: "promo-latte" },
    ],
    shipping: "Local delivery until 6 pm",
    returns: "Made fresh to order",
  },
  studio: {
    name: "Studio Nord",
    category: "retail",
    about: "Studio Nord is a small design studio. We make useful objects in small runs, working with independent makers across northern Europe.",
    announcement: "Edition 04 is now available",
    eyebrow: "Objects for daily use",
    headline: "Less, made carefully",
    description: "A short list of objects, drawn in the studio and made in small runs.",
    hero: "hero-studio",
    overlay: 0,
    featured: "Edition 04",
    promotions: [
      { eyebrow: "Notes", title: "Material study", text: "How we choose what each object is made from, and why so few things make the list.", cta: "Read more", image: "promo-pampas" },
      { eyebrow: "In use", title: "At home with Edition 04", text: "The new objects, photographed where they belong.", cta: "See the set", image: "promo-interior" },
    ],
    shipping: "Ships worldwide",
    returns: "Returns within 14 days",
  },
  launch: {
    name: "Drop Nine",
    category: "clothing",
    about: "DROP NINE MAKES LIMITED RUNS OF EVERYDAY STREETWEAR. WHEN IT IS GONE, IT IS GONE.",
    announcement: "Drop 09 is live now",
    eyebrow: "Drop 09",
    headline: "Made loud. Gone fast.",
    description: "Heavyweight basics in small runs. Once a drop sells out, it does not come back.",
    hero: "hero-launch",
    overlay: 0,
    featured: "The drop",
    promotions: [
      { eyebrow: "Visit", title: "Pop-up this weekend", text: "Try the whole drop in person.", cta: "Get details", image: "promo-shop-floor" },
      { eyebrow: "Archive", title: "Last chance", text: "Final pieces from past drops.", cta: "Shop archive", image: "promo-rails" },
    ],
    shipping: "Ships in 48 hours",
    returns: "Free exchanges",
  },
  atelier: {
    name: "Maison Vale",
    category: "clothing",
    about: "Maison Vale makes a small seasonal wardrobe in natural fibres, cut and finished in a family-run workshop.",
    announcement: "The autumn collection",
    eyebrow: "Autumn collection",
    headline: "The art of restraint",
    description: "Natural fibres, considered cuts and a quiet palette for the new season.",
    hero: "hero-atelier",
    align: "center",
    overlay: 25,
    featured: "New this season",
    promotions: [
      { eyebrow: "The edit", title: "Everyday tailoring", text: "Soft structure in washed wool and linen.", cta: "Discover", image: "promo-rack" },
    ],
    shipping: "Complimentary delivery",
    returns: "Returns within 30 days",
  },
  volt: {
    name: "Voltline",
    category: "electronics",
    about: "Voltline sells carefully tested audio and desk gear. We only stock what we would use ourselves, with honest specifications.",
    announcement: "New audio gear just landed",
    eyebrow: "Tested gear for work and play",
    headline: "Better gear for your whole setup",
    description: "Audio, input and power, tested by people who use it all day.",
    hero: "hero-volt",
    overlay: 15,
    featured: "Top picks",
    promotions: [
      { eyebrow: "Setup guide", title: "Build a quieter desk", text: "Wireless input and tidy power, in one set.", cta: "View setup", image: "promo-desk" },
      { eyebrow: "Work from anywhere", title: "Your whole kit, one bag", text: "Compact gear that travels well.", cta: "Shop travel", image: "promo-workspace" },
    ],
    shipping: "Next-day dispatch",
    returns: "2-year warranty",
  },
  harvest: {
    name: "Greenbasket",
    category: "grocery",
    about: "Greenbasket brings fresh food from local farms and bakers to your door, picked and packed the same day.",
    announcement: "Free delivery on your first order",
    eyebrow: "Fresh from local farms",
    headline: "Your weekly shop, delivered fresh",
    description: "Seasonal fruit and vegetables, fresh bread and pantry staples at your door.",
    hero: "hero-harvest",
    overlay: 0,
    featured: "Fresh this week",
    promotions: [
      { eyebrow: "In season", title: "Market favourites", text: "Picked this morning.", cta: "Shop fresh", image: "promo-produce" },
      { eyebrow: "Quick meals", title: "Ready to cook", text: "Prepared and ready in minutes.", cta: "See ideas", image: "promo-bowls" },
    ],
    shipping: "Delivered within 2 hours",
    returns: "Freshness guaranteed",
  },
  forma: {
    name: "Oak & Ash",
    category: "furniture",
    about: "Oak & Ash designs furniture for real rooms: solid materials, honest joinery and shapes that stay quiet for decades.",
    announcement: "The living room collection",
    eyebrow: "Furniture for real rooms",
    headline: "Spaces made to stay",
    description: "Solid materials and calm shapes, made to be lived with for decades.",
    hero: "hero-forma",
    overlay: 0,
    featured: "The collection",
    promotions: [
      { eyebrow: "Colour", title: "A warmer living room", text: "Our softest sofa, now in burnt orange.", cta: "View the sofa", image: "promo-sofa" },
      { eyebrow: "Room ideas", title: "Layered, not crowded", text: "How to bring a room together slowly.", cta: "See the room", image: "promo-interior" },
    ],
    shipping: "White-glove delivery",
    returns: "100-night trial",
  },
};

export function sampleStoreView(themeId: ThemeId): StorefrontView {
  const meta = getThemeMeta(themeId);
  const store = STORES[themeId];
  return {
    id: `sample-${themeId}`,
    name: store.name,
    subdomain: "your-store",
    category: store.category,
    about: store.about,
    logoUrl: "",
    contactEmail: "hello@example.com",
    phone: "",
    address: "",
    currency: "USD",
    removeBranding: true,
    themeId,
    theme: {
      primaryColor: meta.palette[1],
      accentColor: meta.palette[2],
      font: "sans",
      heroHeadline: store.headline,
      heroSubheadline: store.description,
      about: "",
      showProducts: true,
    },
    products: sampleProductsFor(themeId, "USD"),
  };
}

/**
 * The homepage data of a sample store. The photos are added after the config is
 * read, because owner configs only accept images from the media library and that
 * rule stays strict: sample photos are never part of a saved config.
 */
export function sampleCommerceData(themeId: ThemeId): CommerceData {
  const store = STORES[themeId];
  const view = sampleStoreView(themeId);
  const commerce = buildCommerceData(
    view,
    {
      announcement: { enabled: true, text: store.announcement },
      hero: {
        eyebrow: store.eyebrow,
        headline: store.headline,
        description: store.description,
        align: store.align ?? "left",
        overlay: store.overlay,
        primaryCta: { label: "Shop now", href: "/products" },
      },
      sections: [
        { id: "categories", type: "categories", title: "Shop by category" },
        { id: "featured", type: "featured", title: store.featured },
        {
          id: "promotions",
          type: "promotions",
          items: store.promotions.map((promo) => ({ eyebrow: promo.eyebrow, title: promo.title, text: promo.text, cta: { label: promo.cta, href: "/products" } })),
        },
        { id: "benefits", type: "benefits", shipping: store.shipping, returns: store.returns },
        { id: "story", type: "story" },
      ],
    },
    {},
  );

  const hero = sampleImage(store.hero);
  const withPhotos = (promotions: CommerceData["promotions"]) =>
    promotions.map((promo, index) => ({ ...promo, imageUrl: sampleImage(store.promotions[index]?.image ?? store.hero), imageAlt: promo.title }));
  return {
    ...commerce,
    hero: commerce.hero && {
      ...commerce.hero,
      imageUrl: hero,
      mobileImageUrl: hero,
      imageAlt: store.headline,
      // Some compositions set a second photo beside the first.
      collage: view.products.slice(0, 3).map((product) => ({ src: product.imageUrl, alt: product.name })),
    },
    promotions: withPhotos(commerce.promotions),
    sections: commerce.sections.map((section) => (section.type === "promotions" ? { ...section, promotions: withPhotos(section.promotions) } : section)),
  };
}
