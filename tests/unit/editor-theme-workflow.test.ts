import assert from "node:assert/strict";
import test from "node:test";
import {
  EditorSaveError,
  savePageBackedEditorChanges,
} from "../../backend/lib/editor-save";
import { resolveEditorNavigation } from "../../backend/lib/editor-preview";

test("page-backed save persists sections before only the changed business theme settings", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    const response =
      url === "/api/businesses/business-1/pages/page-1"
        ? { page: { version: 8 } }
        : { business: { themeId: "market" } };
    return new Response(JSON.stringify(response), { status: 200 });
  };

  const result = await savePageBackedEditorChanges({
    businessId: "business-1",
    pageId: "page-1",
    pagePayload: { sections: [{ id: "hero" }], expectedVersion: 7 },
    themeId: "market",
    savedThemeId: "aurora",
    font: "serif",
    savedFont: "sans",
    fetcher,
  });

  assert.equal(result.page?.version, 8);
  assert.deepEqual(calls, [
    {
      url: "/api/businesses/business-1/pages/page-1",
      body: { sections: [{ id: "hero" }], expectedVersion: 7 },
    },
    {
      url: "/api/businesses/business-1",
      body: { themeId: "market", themeSettings: { font: "serif" } },
    },
  ]);
});

test("page-backed save does not repeat theme persistence when it is unchanged", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ page: { version: 2 } }), {
      status: 200,
    });
  };

  await savePageBackedEditorChanges({
    businessId: "business-1",
    pageId: "page-1",
    pagePayload: { sections: [], expectedVersion: 1 },
    themeId: "aurora",
    savedThemeId: "aurora",
    font: "sans",
    savedFont: "sans",
    fetcher,
  });

  assert.deepEqual(calls, ["/api/businesses/business-1/pages/page-1"]);
});

test("theme persistence failure reports the page save as a partial success", async () => {
  let callCount = 0;
  const fetcher: typeof fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({ page: { version: 12 } }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: "Business update unavailable" }), {
      status: 503,
    });
  };

  await assert.rejects(
    () =>
      savePageBackedEditorChanges({
        businessId: "business-1",
        pageId: "page-1",
        pagePayload: { sections: [], expectedVersion: 11 },
        themeId: "launch",
        savedThemeId: "aurora",
        font: "sans",
        savedFont: "sans",
        fetcher,
      }),
    (error: unknown) => {
      assert.ok(error instanceof EditorSaveError);
      assert.equal(error.stage, "theme");
      assert.equal(error.pageSaved, true);
      assert.equal(error.status, 503);
      assert.equal(error.response?.page?.version, 12);
      return true;
    },
  );
});

test("editor preview resolves draft navigation to draft pages in configured order", () => {
  const navigation = resolveEditorNavigation(
    {
      header: [
        { pageId: "draft-page", label: "", order: 1 },
        { pageId: "published-page", label: "About", order: 0 },
        { pageId: "missing-page", label: "Missing", order: 2 },
      ],
      footer: [],
    },
    [
      { _id: "draft-page", title: "Draft", slug: "draft", status: "draft" },
      { _id: "published-page", title: "About", slug: "about", status: "published" },
    ],
  );

  assert.deepEqual(navigation?.header, [
    { pageId: "published-page", label: "About", slug: "about", href: "/about" },
    { pageId: "draft-page", label: "Draft", slug: "draft", href: "/draft" },
  ]);
  assert.deepEqual(navigation?.footer, []);
});
