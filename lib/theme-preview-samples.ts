import type { ThemeId } from "./constants";
import type { StorefrontProduct } from "./storefront";

/**
 * Sample products for THEME PREVIEWS ONLY (marketing pages, theme marketplace),
 * so a theme can be judged with real-looking content. They exist only in the
 * browser preview: never saved, never sent to the server, never shown on a
 * public store, and every preview says they are samples. Photos live in
 * public/samples (docs/sample-media-credits.md). No ratings, no discounts.
 */
const SAMPLES: Record<string, Array<[name: string, category: string, price: number, image: string]>> = {
  lifestyle: [["Scented Candle", "Home", 34, "scented-candle"], ["Leather Backpack", "Carry", 189, "leather-backpack"], ["Classic Headphones", "Audio", 149, "classic-headphones"], ["Round Sunglasses", "Accessories", 95, "round-sunglasses"], ["Insulated Bottle", "Carry", 38, "insulated-bottle"], ["White Mug", "Home", 22, "white-mug"]],
  general: [["White Mug", "Kitchen", 12, "white-mug"], ["Canvas Tote", "Bags", 24, "canvas-tote"], ["Scented Candle", "Home", 18, "scented-candle"], ["Ruled Notebook", "Stationery", 15, "ruled-notebook"], ["Insulated Bottle", "Kitchen", 22, "insulated-bottle"], ["Studio Headphones", "Audio", 79, "studio-headphones"], ["Desk Set", "Stationery", 45, "desk-set"]],
  objects: [["Stoneware Cups", "Tableware", 48, "stoneware-cups"], ["Pendant Lamp", "Lighting", 180, "pendant-lamp"], ["Floor Lamp", "Lighting", 240, "floor-lamp"], ["Ruled Notebook", "Paper", 18, "ruled-notebook"], ["White Mug", "Tableware", 24, "white-mug"], ["Insulated Bottle", "Daily", 36, "insulated-bottle"]],
  fashion: [["Patterned Overshirt", "Shirts", 148, "patterned-overshirt"], ["Camel Wrap Coat", "Outerwear", 420, "camel-wrap-coat"], ["Striped Linen Top", "Shirts", 118, "striped-linen-top"], ["Pleated Midi Skirt", "Skirts", 164, "pleated-midi-skirt"], ["Leather Belt", "Accessories", 79, "leather-belt"], ["White Cotton Tee", "Shirts", 58, "white-cotton-tee"]],
  street: [["Grey Hoodie", "Tops", 68, "grey-hoodie"], ["Crew Sweatshirt", "Tops", 58, "crew-sweatshirt"], ["Rust Bomber", "Outerwear", 129, "rust-bomber"], ["Washed Cap", "Accessories", 32, "washed-cap"], ["Round Sunglasses", "Accessories", 45, "round-sunglasses"], ["Everyday Backpack", "Bags", 74, "everyday-backpack"]],
  tech: [["Wireless Earbuds", "Audio", 89, "wireless-earbuds"], ["Smart Speaker", "Audio", 99, "smart-speaker"], ["Slim Keyboard", "Accessories", 69, "slim-keyboard"], ["Wireless Mouse", "Accessories", 39, "wireless-mouse"], ["65W USB-C Charger", "Power", 35, "usb-c-charger"], ["Studio Headphones", "Audio", 129, "studio-headphones"]],
  grocery: [["Organic Apples", "Fruit", 4, "organic-apples"], ["Sourdough Loaf", "Bakery", 6, "sourdough-loaf"], ["Free-range Eggs", "Dairy & eggs", 5, "free-range-eggs"], ["Fresh Milk", "Dairy & eggs", 3, "fresh-milk"], ["Baby Spinach", "Vegetables", 3, "baby-spinach"], ["Coffee Beans", "Pantry", 9, "coffee-beans"]],
  home: [["Velvet Sofa", "Living room", 1290, "velvet-sofa"], ["Oak Side Table", "Living room", 240, "oak-side-table"], ["Linen Bedding Set", "Bedroom", 160, "linen-bedding"], ["Floor Lamp", "Lighting", 210, "floor-lamp"], ["Pendant Lamp", "Lighting", 145, "pendant-lamp"], ["Stoneware Cups", "Table", 48, "stoneware-cups"]],
  food: [["House Blend Coffee", "Coffee", 14, "house-coffee"], ["Butter Croissant", "Bakery", 4, "butter-croissant"], ["Seasonal Soup", "Kitchen", 9, "seasonal-soup"], ["Caffe Latte", "Coffee", 5, "cafe-latte"], ["Rustic Loaf", "Bakery", 7, "rustic-loaf"], ["Meringue Tart", "Bakery", 6, "meringue-tart"]],
};

const FAMILY: Record<ThemeId, keyof typeof SAMPLES> = {
  aurora: "lifestyle",
  market: "general",
  bistro: "food",
  studio: "objects",
  launch: "street",
  atelier: "fashion",
  volt: "tech",
  harvest: "grocery",
  forma: "home",
};

/** A sample photo. These load on the platform host only, where previews run. */
export function sampleImage(name: string): string {
  return `/samples/${name}.webp`;
}

export function sampleProductsFor(themeId: ThemeId, currency: string): StorefrontProduct[] {
  const now = Date.now();
  return SAMPLES[FAMILY[themeId] ?? "general"].map(([name, category, price, image], index) => ({
    id: `sample${String(index).padStart(18, "0")}`,
    name,
    slug: `sample-${index}`,
    description: "",
    price,
    currency,
    imageUrl: sampleImage(image),
    imageAlt: name,
    category,
    compareAtPrice: null,
    availability: "in_stock" as const,
    createdAt: new Date(now - index * 86_400_000).toISOString(),
  }));
}
