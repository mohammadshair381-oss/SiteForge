import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSection } from "@/lib/sections";
import {
  MAX_WEBSITE_PLAN_PAGES,
  websitePlanSchema,
  type WebsitePlan,
} from "@/lib/ai-planning/plan";
import {
  PlanningProviderUnavailableError,
  requestValidatedWebsitePlan,
  type WebsitePlanningProvider,
} from "@/lib/ai-planning/provider";

function validPlan(): WebsitePlan {
  return websitePlanSchema.parse({
    businessSummary: "An independent repair studio.",
    targetAudience: "Local residents who need bicycle repairs.",
    recommendedTheme: "studio",
    requestedPageCount: 1,
    designPreferences: { notes: "Clear and practical." },
    productIds: [],
    pages: [
      {
        title: "Home",
        slug: "home",
        purpose: "Introduce the studio.",
        proposedContent: "Opening hours and services.",
        isHome: true,
        sections: [createDefaultSection("hero", 0)],
      },
    ],
    navigation: [{ pageSlug: "home", label: "Home" }],
    summary: "A one-page manual planning draft.",
  });
}

test("website plan: valid CMS-compatible plan applies defaults", () => {
  const plan = validPlan();
  assert.equal(plan.pages.length, 1);
  assert.deepEqual(plan.assumptions, []);
  assert.deepEqual(plan.unansweredQuestions, []);
  assert.equal(plan.pages[0].sections[0].type, "hero");
});

test("website plan: existing-page replacement requires its expected version", () => {
  const base = validPlan();
  const selectedPage = {
    ...base.pages[0],
    existingPageId: "0123456789abcdef01234567",
  };
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      pages: [selectedPage],
    }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      pages: [{ ...selectedPage, expectedVersion: 3 }],
    }).success,
    true,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      pages: [{ ...base.pages[0], expectedVersion: 3 }],
    }).success,
    false,
  );
});

test("website plan: rejects unsupported themes, invalid and duplicate slugs", () => {
  const base = validPlan();
  assert.equal(
    websitePlanSchema.safeParse({ ...base, recommendedTheme: "unknown" }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      pages: [{ ...base.pages[0], slug: "Bad Slug" }],
    }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      requestedPageCount: 2,
      pages: [
        base.pages[0],
        { ...base.pages[0], title: "Another home", isHome: false },
      ],
    }).success,
    false,
  );
});

test("website plan: rejects invalid section data and excessive counts", () => {
  const base = validPlan();
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      pages: [
        { ...base.pages[0], sections: [{ id: "bad", type: "unknown", settings: {} }] },
      ],
    }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      pages: [
        {
          ...base.pages[0],
          sections: [
            {
              ...createDefaultSection("cta", 0),
              settings: { buttonHref: "javascript:alert(1)" },
            },
          ],
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      requestedPageCount: MAX_WEBSITE_PLAN_PAGES + 1,
    }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      pages: [
        {
          ...base.pages[0],
          sections: Array.from({ length: 51 }, (_, index) =>
            createDefaultSection("footer", index),
          ),
        },
      ],
    }).success,
    false,
  );
});

test("website plan: rejects duplicate slugs, unknown navigation, and repeated products", () => {
  const base = validPlan();
  const secondPage = {
    ...base.pages[0],
    title: "About",
    isHome: false,
  };
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      requestedPageCount: 2,
      pages: [base.pages[0], secondPage],
    }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      navigation: [{ pageSlug: "missing", label: "Missing" }],
    }).success,
    false,
  );
  assert.equal(
    websitePlanSchema.safeParse({
      ...base,
      productIds: ["0123456789abcdef01234567", "0123456789abcdef01234567"],
    }).success,
    false,
  );
});

test("planning provider: unavailable state is explicit and does not generate", async () => {
  await assert.rejects(
    requestValidatedWebsitePlan(null, {
      businessSummary: "Summary",
      targetAudience: "Audience",
      requestedPageCount: 1,
      pages: [{ title: "Home", purpose: "Intro", requiredContent: "" }],
      preferredTheme: "aurora",
      designPreferences: { notes: "" },
      productIds: [],
      specialRequirements: "",
    }),
    PlanningProviderUnavailableError,
  );
});

test("planning provider: validates untrusted output and surfaces provider failures", async () => {
  const request = {
    businessSummary: "Summary",
    targetAudience: "Audience",
    requestedPageCount: 1,
    pages: [{ title: "Home", purpose: "Intro", requiredContent: "" }],
    preferredTheme: "aurora" as const,
    designPreferences: { notes: "" },
    productIds: [],
    specialRequirements: "",
  };
  const invalidProvider: WebsitePlanningProvider = {
    async generatePlan() {
      return { ...validPlan(), recommendedTheme: "unsupported" };
    },
  };
  await assert.rejects(requestValidatedWebsitePlan(invalidProvider, request));

  const providerError = new Error("provider request failed");
  const failingProvider: WebsitePlanningProvider = {
    async generatePlan() {
      throw providerError;
    },
  };
  await assert.rejects(requestValidatedWebsitePlan(failingProvider, request), providerError);
});
