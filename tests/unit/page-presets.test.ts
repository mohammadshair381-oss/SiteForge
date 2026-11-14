import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { findPlaceholders, pageFamilyFor, planDefaultPages, type PagePlanInput } from "../../backend/lib/page-presets";
import { sectionsArraySchema } from "../../backend/lib/sections";
import { pageCreateSchema } from "../../backend/lib/validation";

function input(over: Partial<Omit<PagePlanInput, "business">> & { business?: Partial<PagePlanInput["business"]> } = {}): PagePlanInput {
  const { business, ...rest } = over;
  return {
    business: { name: "Demo Store", category: "retail", description: "", contactEmail: "", phone: "", address: "", currency: "INR", codEnabled: false, ...business },
    policies: { shipping: "", returns: "" },
    shipping: null,
    categories: [],
    productCount: 0,
    saleCount: 0,
    onlinePayments: false,
    accountsEnabled: false,
    ...rest,
  };
}

const keys = (plan: ReturnType<typeof planDefaultPages>) => plan.pages.map((p) => p.key);
const text = (value: unknown) => JSON.stringify(value);

test("business type -> page family (unknown types fall back to general)", () => {
  assert.equal(pageFamilyFor("clothing"), "fashion");
  assert.equal(pageFamilyFor("shoes"), "fashion");
  assert.equal(pageFamilyFor("electronics"), "tech");
  assert.equal(pageFamilyFor("technology"), "tech");
  assert.equal(pageFamilyFor("grocery"), "grocery");
  assert.equal(pageFamilyFor("furniture"), "home");
  assert.equal(pageFamilyFor("food"), "restaurant");
  assert.equal(pageFamilyFor("retail"), "general");
  assert.equal(pageFamilyFor("services"), "services");
  assert.equal(pageFamilyFor("realestate"), "realestate");
  assert.equal(pageFamilyFor("fitness"), "fitness");
  assert.equal(pageFamilyFor("education"), "education");
  assert.equal(pageFamilyFor("creative"), "creative");
  assert.equal(pageFamilyFor("beauty"), "wellness");
  assert.equal(pageFamilyFor("cosmetics"), "beauty");
  assert.equal(pageFamilyFor("other"), "general");
  assert.equal(pageFamilyFor("does-not-exist"), "general");
  assert.equal(pageFamilyFor(null), "general");
});

test("every family yields valid, unique, draft-ready pages", () => {
  const rich = input({
    business: { description: "We sell good things.", contactEmail: "hello@example.com", phone: "+91 98765 43210", address: "1 Main Road", codEnabled: true },
    policies: { shipping: "We ship nationwide.", returns: "Returns within 7 days." },
    shipping: { enabled: true, flatRate: 50, freeOver: 999, deliveryInfo: "" },
    categories: [{ name: "Men", count: 3 }, { name: "Women", count: 2 }, { name: "Living room", count: 2 }, { name: "Bedroom", count: 1 }, { name: "Fresh", count: 4 }],
    productCount: 12,
    saleCount: 2,
    onlinePayments: true,
    accountsEnabled: true,
  });
  for (const category of ["retail", "clothing", "electronics", "grocery", "furniture", "food", "cosmetics", "beauty", "services", "realestate", "fitness", "education", "creative"]) {
    const plan = planDefaultPages({ ...rich, business: { ...rich.business, category } });
    const slugs = plan.pages.map((p) => p.slug);
    assert.equal(new Set(slugs).size, slugs.length, `${category}: unique slugs`);
    assert.equal(new Set(keys(plan)).size, plan.pages.length, `${category}: unique keys`);
    assert.ok(!slugs.includes("home") && !slugs.includes(""), "the home page is never generated");
    assert.ok(!slugs.includes("products") && !slugs.includes("shop"), "the catalog stays the built-in /products");
    for (const page of plan.pages) {
      assert.doesNotThrow(() => sectionsArraySchema.parse(page.sections), `${category}/${page.key} sections`);
      const created = pageCreateSchema.safeParse({ title: page.title, slug: page.slug, description: page.description, seoTitle: page.seoTitle, seoDescription: page.seoDescription, sections: page.sections });
      assert.ok(created.success, `${category}/${page.key} passes page validation: ${created.success ? "" : created.error.message}`);
      assert.ok(page.reason.length > 0);
      if (page.kind === "policy") assert.equal(page.needsReview, true, `${page.key} needs review`);
    }
    for (const required of ["about", "contact", "faq", "privacy-policy", "terms"]) {
      assert.ok(keys(plan).some((k) => k === required), `${category}: ${required}`);
    }
  }
});

test("category-specific pages exist only for real product categories", () => {
  const none = planDefaultPages(input({ business: { category: "clothing" } }));
  assert.ok(!keys(none).includes("category-men"));
  assert.ok(none.skipped.some((s) => s.key === "category-men"));
  assert.ok(!keys(none).includes("collections"));

  const fashion = planDefaultPages(input({ business: { category: "clothing" }, categories: [{ name: "Mens", count: 3 }, { name: "Kids", count: 1 }], productCount: 4 }));
  const men = fashion.pages.find((p) => p.key === "category-men");
  assert.ok(men);
  assert.equal(men.title, "Mens");
  assert.equal(men.slug, "mens");
  assert.equal(text(men.sections).includes('"category":"Mens"'), true);
  assert.ok(!keys(fashion).includes("category-women"));
  assert.ok(keys(fashion).includes("collections"));
  assert.ok(keys(fashion).includes("new-arrivals"));
  assert.equal(fashion.pages.find((p) => p.key === "about")?.slug, "about-the-brand");

  const home = planDefaultPages(input({ business: { category: "furniture" }, categories: [{ name: "Living Room", count: 2 }, { name: "Home decor", count: 2 }], productCount: 4 }));
  assert.ok(keys(home).includes("category-living-room"));
  assert.ok(keys(home).includes("category-home-decor"));
  assert.ok(!keys(home).includes("category-bedroom"));
  assert.ok(keys(home).includes("delivery-and-returns"));
  assert.ok(!keys(home).includes("shipping-policy"));

  const grocery = planDefaultPages(input({ business: { category: "grocery" }, categories: [{ name: "Fruits", count: 5 }], productCount: 5 }));
  assert.ok(keys(grocery).includes("category-fresh"));
  assert.ok(keys(grocery).includes("delivery-information"));
});

test("offers and new arrivals need real data", () => {
  const empty = planDefaultPages(input({ business: { category: "grocery" } }));
  assert.ok(!keys(empty).includes("offers"));
  assert.ok(!keys(empty).includes("new-arrivals"));
  const withSale = planDefaultPages(input({ business: { category: "grocery" }, productCount: 3, saleCount: 1 }));
  assert.ok(keys(withSale).includes("offers"));
  assert.ok(text(withSale.pages.find((p) => p.key === "offers")?.sections).includes('"collection":"sale"'));
  assert.ok(keys(withSale).includes("new-arrivals"));
});

test("restaurant pages: menu only with products, reservations without a booking system", () => {
  const empty = planDefaultPages(input({ business: { category: "food" } }));
  assert.ok(!keys(empty).includes("menu"));
  assert.ok(empty.skipped.some((s) => s.key === "menu"));
  assert.ok(!keys(empty).includes("returns-policy"));
  assert.ok(!keys(empty).includes("shipping-policy"));
  const menu = planDefaultPages(input({ business: { category: "food" }, productCount: 2 }));
  assert.ok(keys(menu).includes("menu"));
  assert.ok(keys(menu).includes("reservations"));
  assert.ok(findPlaceholders(menu.pages.find((p) => p.key === "reservations")?.sections).length > 0);
});

test("no invented facts: unknown details are placeholders, known details are the owner's own", () => {
  const plan = planDefaultPages(input({ business: { category: "electronics" } }));
  const all = text(plan.pages);
  // No contact details, numbers or durations the owner did not provide.
  assert.ok(!/@[a-z0-9-]+\./i.test(all), "no invented email");
  assert.ok(!/\b\d+\s*(day|days|year|years|month|months)\b/i.test(all), "no invented durations");
  assert.ok(!/(₹|\$|€)\s?\d/.test(all), "no invented prices");
  const about = plan.pages.find((p) => p.key === "about");
  assert.ok(findPlaceholders(about?.sections).length > 0, "missing description becomes a placeholder");
  const contact = plan.pages.find((p) => p.key === "contact");
  assert.ok(!text(contact?.sections).includes('"type":"contact"'), "no contact block without details");
  const warranty = plan.pages.find((p) => p.key === "warranty");
  assert.ok(warranty?.needsReview);
  assert.ok(findPlaceholders(warranty?.sections).length > 0);

  const known = planDefaultPages(input({
    business: { category: "electronics", description: "Repairs and parts since we opened.", contactEmail: "owner@example.com", phone: "+1 555 0100" },
    shipping: { enabled: true, flatRate: 40, freeOver: 500, deliveryInfo: "Dispatched in 2 working days." },
  }));
  const aboutKnown = known.pages.find((p) => p.key === "about");
  assert.ok(text(aboutKnown?.sections).includes("Repairs and parts since we opened."));
  assert.ok(text(known.pages.find((p) => p.key === "contact")?.sections).includes("owner@example.com"));
  const faq = text(known.pages.find((p) => p.key === "faq")?.sections);
  assert.ok(faq.includes("₹40") || faq.includes("40"), "delivery cost from settings");
  assert.ok(faq.includes("Dispatched in 2 working days."));
  assert.ok(!faq.includes("cash on delivery"), "COD answer only when COD is on");
  assert.ok(!faq.includes("pay securely online"), "online payment answer only when connected");
});

test("policy and legal pages are templates that cannot be published unreviewed", () => {
  const plan = planDefaultPages(input({ policies: { shipping: "Ships in 3 days.", returns: "" } }));
  for (const key of ["shipping-policy", "returns-policy", "privacy-policy", "terms"]) {
    const page = plan.pages.find((p) => p.key === key);
    assert.ok(page, key);
    assert.equal(page.needsReview, true);
    assert.equal(page.kind, "policy");
    assert.ok(findPlaceholders(page.sections).some((p) => p.includes("not legal advice")), `${key} carries the review line`);
  }
  assert.ok(text(plan.pages.find((p) => p.key === "shipping-policy")?.sections).includes("Ships in 3 days."));
});

test("planning is deterministic", () => {
  const a = planDefaultPages(input({ business: { category: "clothing" }, categories: [{ name: "Women", count: 2 }], productCount: 2 }));
  const b = planDefaultPages(input({ business: { category: "clothing" }, categories: [{ name: "Women", count: 2 }], productCount: 2 }));
  assert.deepEqual(a, b);
});

test("findPlaceholders finds nested text placeholders only", () => {
  assert.deepEqual(findPlaceholders([{ settings: { items: [{ answer: "x [[Add this]] y" }] } }]), ["[[Add this]]"]);
  assert.deepEqual(findPlaceholders([{ settings: { body: "No [placeholders] here" } }]), []);
  assert.deepEqual(findPlaceholders(null), []);
});

test("category pages are not added to the header (it already links every category)", () => {
  const plan = planDefaultPages(input({ business: { category: "clothing" }, categories: [{ name: "Men", count: 2 }, { name: "Women", count: 2 }], productCount: 4 }));
  for (const key of ["category-men", "category-women"]) assert.equal(plan.pages.find((p) => p.key === key)?.nav, null, key);
  assert.ok(plan.pages.filter((p) => p.nav === "header").length <= 5);
});

test("service businesses get pages for how they work, not for shipping goods", () => {
  for (const [category, listKey, infoKey] of [
    ["services", "services", "how-we-work"],
    ["realestate", "listings", "book-a-viewing"],
    ["fitness", "programs", "timetable"],
    ["education", "courses", "admissions"],
    ["creative", "packages", "our-work"],
    ["beauty", "treatments", "book-an-appointment"],
  ] as const) {
    const empty = keys(planDefaultPages(input({ business: { category } })));
    assert.ok(!empty.includes(listKey), `${category}: no list page without anything to list`);
    assert.ok(empty.includes(infoKey), `${category}: its own information page`);
    assert.ok(empty.includes("cancellation-policy"), `${category}: cancellation policy`);
    for (const shopPage of ["new-arrivals", "shipping-policy", "returns-policy"]) assert.ok(!empty.includes(shopPage), `${category}: no ${shopPage}`);
    const stocked = keys(planDefaultPages(input({ business: { category }, productCount: 3 })));
    assert.ok(stocked.includes(listKey), `${category}: list page with real data`);
    assert.ok(!stocked.includes("new-arrivals"), `${category}: still no new arrivals`);
  }
  // A service business that does deliver still explains it.
  assert.ok(keys(planDefaultPages(input({ business: { category: "services" }, shipping: { enabled: true, flatRate: 10, freeOver: null, deliveryInfo: "" } }))).includes("shipping-policy"));
});

test("service pages invent nothing: unknown details are placeholders", () => {
  const plan = planDefaultPages(input({ business: { category: "fitness" } }));
  const timetable = plan.pages.find((page) => page.key === "timetable")!;
  assert.ok(findPlaceholders(timetable.sections).length > 0);
  const text = JSON.stringify(plan.pages.map((page) => page.sections));
  for (const invented of ["since 19", "award", "certified", "guarantee", "24/7"]) assert.ok(!text.toLowerCase().includes(invented), invented);
});

test("cosmetics stores keep shop pages and add ingredients", () => {
  const plan = keys(planDefaultPages(input({ business: { category: "cosmetics" }, productCount: 3 })));
  for (const key of ["ingredients", "new-arrivals", "returns-policy"]) assert.ok(plan.includes(key), key);
});
