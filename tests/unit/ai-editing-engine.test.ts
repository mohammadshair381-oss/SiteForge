import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSection, sectionSchema, type Section } from "@/lib/sections";
import {
  editingActionsSchema,
  editingContextSchema,
  MAX_EDITING_ACTIONS,
  type EditingContext,
} from "@/lib/ai-planning/actions";
import {
  applyEditingActions,
  EditingEngineError,
} from "@/lib/ai-planning/editing-engine";

const MEDIA_URL = "https://cdn.example.test/siteforge/hero.webp";

function makeContext(overrides: Partial<EditingContext> = {}): EditingContext {
  return editingContextSchema.parse({
    pages: [
      {
        id: "0123456789abcdef01234567",
        title: "Home",
        slug: "home",
        status: "draft",
        version: 4,
        sections: [
          {
            ...createDefaultSection("hero", 0),
            id: "hero-main",
            settings: { headline: "Welcome", subheadline: "Original copy" },
          },
          {
            ...createDefaultSection("about", 1),
            id: "about-main",
            settings: { title: "About", body: "Original about section" },
          },
          {
            ...createDefaultSection("footer", 2),
            id: "footer-main",
            settings: { text: "Contact us" },
          },
        ],
      },
      {
        id: "1123456789abcdef01234567",
        title: "Contact",
        slug: "contact",
        status: "draft",
        version: 2,
        sections: [createDefaultSection("contact", 0)],
      },
    ],
    allowedMediaUrls: [],
    ...overrides,
  });
}

type HeroSection = Extract<Section, { type: "hero" }>;

function hero(overrides: Partial<HeroSection> = {}): HeroSection {
  return sectionSchema.parse({
    ...createDefaultSection("hero", 0),
    id: "hero-main",
    settings: { headline: "Welcome", subheadline: "Original copy" },
    ...overrides,
  }) as HeroSection;
}

const pageId = "0123456789abcdef01234567";

function updateAction(
  section: unknown = hero({
    settings: { headline: "A better welcome", subheadline: "New copy" },
  }),
  overrides: Record<string, unknown> = {},
) {
  return {
    actionId: "update-hero",
    kind: "update-section",
    pageId,
    expectedVersion: 4,
    section,
    ...overrides,
  };
}

test("editing actions: accepts every supported action shape", () => {
  const sections = [createDefaultSection("hero", 0)];
  const result = editingActionsSchema.safeParse([
    updateAction(),
    {
      actionId: "add-faq",
      kind: "add-section",
      pageId,
      expectedVersion: 4,
      index: 1,
      section: createDefaultSection("faq", 0),
    },
    {
      actionId: "remove-footer",
      kind: "remove-section",
      pageId,
      expectedVersion: 4,
      sectionId: "footer-main",
    },
    {
      actionId: "move-about",
      kind: "reorder-sections",
      pageId,
      expectedVersion: 4,
      sectionId: "about-main",
      toIndex: 0,
    },
    {
      actionId: "create-about",
      kind: "create-page",
      title: "About us",
      slug: "about-us",
      sections,
    },
  ]);
  assert.equal(result.success, true);
});

test("editing actions: rejects unknown action types, fields, and nested section fields", () => {
  assert.equal(
    editingActionsSchema.safeParse([
      { actionId: "future", kind: "publish-page", pageId, expectedVersion: 4 },
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse([
      { ...updateAction(), businessId: "another-tenant" },
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse([
      updateAction({
        ...hero(),
        settings: { headline: "Text", arbitraryHtml: "<script>alert(1)</script>" },
      } as unknown as Section),
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse([
      updateAction(
        hero({
          settings: {
            headline: "<script>alert(1)</script>",
            subheadline: "",
          },
        }),
      ),
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse([
      updateAction({ ...hero(), style: { arbitraryCss: "position: fixed" } as never }),
    ]).success,
    false,
  );
});

test("editing actions: requires versions and rejects duplicate action ids and excessive batches", () => {
  const missingVersion = {
    ...updateAction(),
    expectedVersion: undefined,
  };
  assert.equal(editingActionsSchema.safeParse([missingVersion]).success, false);
  assert.equal(
    editingActionsSchema.safeParse([
      updateAction(),
      { ...updateAction(), actionId: "update-hero" },
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse(
      Array.from({ length: MAX_EDITING_ACTIONS + 1 }, (_, index) => ({
        ...updateAction(),
        actionId: `action-${index}`,
      })),
    ).success,
    false,
  );
});

test("editing actions: rejects unsafe URLs, unvalidated product references, and empty new pages", () => {
  assert.equal(
    editingActionsSchema.safeParse([
      updateAction({
        ...hero(),
        settings: { headline: "Welcome", imageUrl: "javascript:alert(1)" },
      } as unknown as Section),
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse([
      {
        actionId: "update-products",
        kind: "update-section",
        pageId,
        expectedVersion: 4,
        section: {
          ...createDefaultSection("products", 0),
          id: "products-main",
          settings: { title: "Catalog", productIds: ["fabricated-id"] },
        },
      },
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse([
      { actionId: "empty-page", kind: "create-page", title: "Empty", slug: "empty", sections: [] },
    ]).success,
    false,
  );
  assert.equal(
    editingActionsSchema.safeParse([
      {
        actionId: "too-many-sections",
        kind: "create-page",
        title: "Large page",
        slug: "large-page",
        sections: Array.from({ length: 51 }, (_, index) =>
          createDefaultSection("footer", index),
        ),
      },
    ]).success,
    false,
  );
});

test("editing engine: updates only target section settings and preserves other content", () => {
  const context = makeContext();
  const untouchedAbout = structuredClone(context.pages[0].sections[1]);
  const untouchedOtherPage = structuredClone(context.pages[1]);
  const result = applyEditingActions(context, [updateAction()]);

  const updatedHero = result.draft.pages[0].sections[0];
  assert.equal(updatedHero.type, "hero");
  if (updatedHero.type === "hero") {
    assert.equal(updatedHero.settings.headline, "A better welcome");
  }
  assert.deepEqual(result.draft.pages[0].sections[1], untouchedAbout);
  assert.deepEqual(result.draft.pages[1], untouchedOtherPage);
  assert.deepEqual(result.summary, {
    actionsApplied: 1,
    pagesCreated: 0,
    sectionsAdded: 0,
    sectionsUpdated: 1,
    sectionsRemoved: 0,
    sectionsReordered: 0,
  });
});

test("editing engine: adds, removes, and reorders sections with normalized positions", () => {
  const context = makeContext();
  const added = createDefaultSection("faq", 0);
  added.id = "faq-new";

  const result = applyEditingActions(context, [
    {
      actionId: "add-faq",
      kind: "add-section",
      pageId,
      expectedVersion: 4,
      index: 1,
      section: added,
    },
    {
      actionId: "move-footer",
      kind: "reorder-sections",
      pageId,
      expectedVersion: 4,
      sectionId: "footer-main",
      toIndex: 0,
    },
    {
      actionId: "remove-about",
      kind: "remove-section",
      pageId,
      expectedVersion: 4,
      sectionId: "about-main",
    },
  ]);

  assert.deepEqual(
    result.draft.pages[0].sections.map((section) => [section.id, section.order]),
    [
      ["footer-main", 0],
      ["hero-main", 1],
      ["faq-new", 2],
    ],
  );
  assert.deepEqual(result.summary, {
    actionsApplied: 3,
    pagesCreated: 0,
    sectionsAdded: 1,
    sectionsUpdated: 0,
    sectionsRemoved: 1,
    sectionsReordered: 1,
  });
});

test("editing engine: rejects duplicate section IDs and out-of-range insertions", () => {
  const duplicate = createDefaultSection("faq", 0);
  duplicate.id = "about-main";
  assert.throws(
    () =>
      applyEditingActions(makeContext(), [
        {
          actionId: "duplicate-section",
          kind: "add-section",
          pageId,
          expectedVersion: 4,
          index: 0,
          section: duplicate,
        },
      ]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "duplicate_section_id",
  );
  assert.throws(
    () =>
      applyEditingActions(makeContext(), [
        {
          actionId: "insert-too-far",
          kind: "add-section",
          pageId,
          expectedVersion: 4,
          index: 4,
          section: createDefaultSection("faq", 0),
        },
      ]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "invalid_reorder",
  );
});

test("editing engine: creates a unique draft page and rejects duplicate ids or slugs", () => {
  const action = {
    actionId: "create-about",
    kind: "create-page",
    title: "About us",
    slug: "about-us",
    sections: [createDefaultSection("about", 0)],
  };
  const result = applyEditingActions(makeContext(), [action]);
  const created = result.draft.pages.find((page) => page.id === "proposal-create-about");
  assert.equal(created?.status, "draft");
  assert.equal(created?.version, 0);
  assert.equal(created?.slug, "about-us");
  assert.equal(result.summary.pagesCreated, 1);
  assert.throws(
    () => applyEditingActions(makeContext(), [{ ...action, slug: "home" }]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "duplicate_page_slug",
  );
});

test("editing engine: rejects missing targets, stale versions, published pages, and bad reorder positions", () => {
  assert.throws(
    () => applyEditingActions(makeContext(), [updateAction(hero(), { pageId: "missing" })]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "page_not_found",
  );
  assert.throws(
    () => applyEditingActions(makeContext(), [updateAction(hero(), { expectedVersion: 3 })]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "version_conflict",
  );

  const published = makeContext({
    pages: makeContext().pages.map((page, index) =>
      index === 0 ? { ...page, status: "published" as const } : page,
    ),
  });
  assert.throws(
    () => applyEditingActions(published, [updateAction()]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "page_not_draft",
  );
  assert.throws(
    () =>
      applyEditingActions(makeContext(), [
        {
          actionId: "move-beyond",
          kind: "reorder-sections",
          pageId,
          expectedVersion: 4,
          sectionId: "hero-main",
          toIndex: 49,
        },
      ]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "invalid_reorder",
  );
  assert.throws(
    () =>
      applyEditingActions(makeContext(), [
        {
          actionId: "move-to-self",
          kind: "reorder-sections",
          pageId,
          expectedVersion: 4,
          sectionId: "hero-main",
          toIndex: 0,
        },
      ]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "invalid_reorder",
  );
});

test("editing engine: enforces runtime context uniqueness and page/section limits", () => {
  const context = makeContext();
  assert.throws(
    () =>
      applyEditingActions(
        {
          ...context,
          pages: [context.pages[0], { ...context.pages[1], id: context.pages[0].id }],
        },
        [updateAction()],
      ),
    /Duplicate page id/,
  );
  assert.throws(
    () =>
      applyEditingActions(
        {
          ...context,
          pages: [context.pages[0], { ...context.pages[1], slug: "home" }],
        },
        [updateAction()],
      ),
    /Duplicate page slug/,
  );
  assert.throws(
    () =>
      applyEditingActions(
        {
          ...context,
          pages: [
            {
              ...context.pages[0],
              sections: [
                context.pages[0].sections[0],
                { ...context.pages[0].sections[1], id: context.pages[0].sections[0].id },
              ],
            },
          ],
        },
        [updateAction()],
      ),
    /Duplicate section id/,
  );
  assert.throws(
    () =>
      applyEditingActions(
        {
          ...context,
          pages: [
            {
              ...context.pages[0],
              sections: Array.from({ length: 51 }, (_, index) =>
                createDefaultSection("footer", index),
              ),
            },
          ],
        },
        [updateAction()],
      ),
    /Too many sections/,
  );

  const maxPages = makeContext({
    pages: Array.from({ length: 50 }, (_, index) => ({
      id: `page-${index}`,
      title: `Page ${index}`,
      slug: `page-${index}`,
      status: "draft" as const,
      version: 0,
      sections: [],
    })),
  });
  assert.throws(
    () =>
      applyEditingActions(maxPages, [
        {
          actionId: "one-too-many",
          kind: "create-page",
          title: "One too many",
          slug: "one-too-many",
          sections: [createDefaultSection("hero", 0)],
        },
      ]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "page_limit_exceeded",
  );
});

test("editing engine: rejects a later invalid action without returning a partial result", () => {
  const context = makeContext();
  const before = structuredClone(context);
  assert.throws(
    () =>
      applyEditingActions(context, [
        updateAction(),
        {
          actionId: "missing-section",
          kind: "remove-section",
          pageId,
          expectedVersion: 4,
          sectionId: "not-here",
        },
      ]),
    (error: unknown) =>
      error instanceof EditingEngineError && error.code === "section_not_found",
  );
  assert.deepEqual(context, before);
});

test("editing engine: output and diff are deterministic and inputs are never mutated", () => {
  const context = makeContext();
  const actions = [
    updateAction(),
    {
      actionId: "create-faq",
      kind: "create-page",
      title: "Frequently asked questions",
      slug: "faq",
      sections: [createDefaultSection("faq", 0)],
    },
  ];
  const contextBefore = structuredClone(context);
  const actionsBefore = structuredClone(actions);
  const first = applyEditingActions(context, actions);
  const second = applyEditingActions(context, actions);

  assert.deepEqual(first, second);
  assert.deepEqual(context, contextBefore);
  assert.deepEqual(actions, actionsBefore);
});

test("editing engine: requires approved media URLs and rejects markup and fabricated references", () => {
  const unapprovedImage = hero({
    settings: {
      headline: "Welcome",
      imageUrl: MEDIA_URL,
      imageAlt: "Shopfront",
    },
  });
  assert.throws(
    () => applyEditingActions(makeContext(), [updateAction(unapprovedImage)]),
    (error: unknown) =>
      error instanceof EditingEngineError &&
      error.code === "unapproved_media_reference",
  );

  const approvedContext = makeContext({ allowedMediaUrls: [MEDIA_URL] });
  const approvedResult = applyEditingActions(approvedContext, [
    updateAction(unapprovedImage),
  ]);
  const approvedHero = approvedResult.draft.pages[0].sections[0];
  assert.equal(approvedHero.type, "hero");
  if (approvedHero.type === "hero") {
    assert.equal(approvedHero.settings.imageUrl, MEDIA_URL);
  }

  assert.throws(
    () =>
      applyEditingActions(makeContext(), [
        updateAction(
          hero({
            settings: {
              headline: "<script>alert(1)</script>",
              subheadline: "",
            },
          }),
        ),
      ]),
  );
});

test("editing engine: preserves unapproved legacy media when the action does not reference it", () => {
  const context = makeContext();
  context.pages[0].sections[0] = hero({
    settings: {
      headline: "Welcome",
      subheadline: "Existing hosted image",
      imageUrl: "https://external.example.test/existing.webp",
      imageAlt: "Existing image",
    },
  });

  const result = applyEditingActions(context, [
    {
      actionId: "change-footer",
      kind: "update-section",
      pageId,
      expectedVersion: 4,
      section: {
        ...createDefaultSection("footer", 2),
        id: "footer-main",
        settings: { text: "Updated footer" },
      },
    },
  ]);

  const resultHero = result.draft.pages[0].sections[0];
  assert.equal(resultHero.type, "hero");
  if (resultHero.type === "hero") {
    assert.equal(resultHero.settings.imageUrl, "https://external.example.test/existing.webp");
  }
});
