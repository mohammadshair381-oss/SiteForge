import { loadEnv } from "./load-env";

loadEnv();

const PLANS = [
  {
    key: "free",
    name: "Free",
    description: "Everything you need to get a small business online.",
    price: 0,
    interval: "month" as const,
    sort: 1,
    // Themes: the Free tier (lib/theme-tiers.ts); editable in the Super Admin plan manager.
    features: { productLimit: 5, staffLimit: 1, customDomain: false, removeBranding: false, themes: ["bistro", "market", "studio"] },
  },
  {
    key: "starter",
    name: "Starter",
    description: "For growing businesses that need more products and staff.",
    price: 19,
    interval: "month" as const,
    sort: 2,
    features: { productLimit: 25, staffLimit: 3, customDomain: false, removeBranding: true, themes: ["bistro", "market", "studio", "aurora", "launch", "harvest"] },
  },
  {
    key: "pro",
    name: "Pro",
    description: "Full power: unlimited-feeling limits and a custom domain.",
    price: 49,
    interval: "month" as const,
    sort: 3,
    // The top tier ("Max" themes): all nine.
    features: {
      productLimit: 500,
      staffLimit: 10,
      customDomain: true,
      removeBranding: true,
      themes: ["aurora", "market", "bistro", "studio", "launch", "atelier", "volt", "harvest", "forma"],
    },
  },
];

async function main() {
  const [{ dbConnect }, { Category }, { Plan }, { BUSINESS_CATEGORIES }] =
    await Promise.all([
      import("../lib/db"),
      import("../models/Category"),
      import("../models/Plan"),
      import("../lib/constants"),
    ]);

  await dbConnect();
  console.log("Connected to MongoDB.");

  for (const [index, category] of BUSINESS_CATEGORIES.entries()) {
    await Category.updateOne(
      { key: category.key },
      {
        $set: { name: category.name, active: true, sort: index },
        $setOnInsert: { description: "", icon: "" },
      },
      { upsert: true },
    );
  }
  console.log(`Seeded ${BUSINESS_CATEGORIES.length} business categories.`);

  for (const plan of PLANS) {
    await Plan.updateOne(
      { key: plan.key },
      { $set: { ...plan, currency: "USD", active: true } },
      { upsert: true },
    );
  }
  console.log(`Seeded ${PLANS.length} subscription plans.`);

  console.log("Seed complete.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
