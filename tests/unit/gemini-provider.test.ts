import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { websitePlanSchema } from "@/lib/ai-planning/plan";
import {
  requestValidatedWebsitePlan,
  PlanningProviderUnavailableError,
  type WebsitePlanningProvider,
} from "@/lib/ai-planning/provider";

// Mock fetch global to simulate Gemini API responses
const originalFetch = global.fetch;

function mockFetch(response: { status: number; body: unknown }) {
  global.fetch = async () => {
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

// These tests exercise the provider with a mocked fetch, so they opt in to the
// AI kill switch explicitly (it is off by default; see lib/env.ts).
beforeEach(() => {
  process.env.AI_PROVIDER_ENABLED = "true";
});
afterEach(() => {
  delete process.env.AI_PROVIDER_ENABLED;
});

test("gemini provider: an API key alone never enables the provider (kill switch off by default)", async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  try {
    const { getWebsitePlanningProvider } = await import("@/lib/ai-planning/provider");
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true1", " true", "true ", "true" + String.fromCharCode(10)]) {
      if (value === undefined) delete process.env.AI_PROVIDER_ENABLED;
      else process.env.AI_PROVIDER_ENABLED = value;
      assert.equal(getWebsitePlanningProvider(), null, `AI_PROVIDER_ENABLED=${String(value)}`);
    }
    process.env.AI_PROVIDER_ENABLED = "true";
    assert.notEqual(getWebsitePlanningProvider(), null, "only the exact value true enables it");
    assert.equal(calls, 0, "selecting a provider never makes a request");
  } finally {
    restoreFetch();
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  }
});

test("gemini provider: missing API key returns null provider", async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const { getWebsitePlanningProvider } = await import("@/lib/ai-planning/provider");
  const provider = getWebsitePlanningProvider();
  assert.equal(provider, null);

  if (savedKey) {
    process.env.GEMINI_API_KEY = savedKey;
  }
});

test("gemini provider: successful response is validated by websitePlanSchema", async () => {
  const validPlan = {
    businessSummary: "A test business.",
    targetAudience: "Test audience.",
    recommendedTheme: "studio",
    requestedPageCount: 1,
    designPreferences: { notes: "Test notes." },
    specialRequirements: "",
    productIds: [],
    pages: [
      {
        title: "Home",
        slug: "home",
        purpose: "Home page.",
        proposedContent: "Welcome.",
        isHome: true,
        sections: [],
      },
    ],
    navigation: [{ pageSlug: "home", label: "Home" }],
    assumptions: [],
    unansweredQuestions: [],
    summary: "A test plan.",
  };

  mockFetch({
    status: 200,
    body: {
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(validPlan) }],
          },
        },
      ],
    },
  });

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import("@/lib/ai-planning/provider");
    const provider = getWebsitePlanningProvider();
    assert.ok(provider !== null);

    const request = {
      businessSummary: "A test business.",
      targetAudience: "Test audience.",
      requestedPageCount: 1,
      pages: [{ title: "Home", purpose: "Home page.", requiredContent: "Welcome." }],
      preferredTheme: "studio" as const,
      designPreferences: { notes: "Test notes." },
      productIds: [],
      specialRequirements: "",
    };

    const plan = await requestValidatedWebsitePlan(provider, request);
    assert.equal(plan.businessSummary, "A test business.");
    assert.equal(plan.pages.length, 1);
  } finally {
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }
});

test("gemini provider: HTTP 429 rate limit is mapped to error", async () => {
  mockFetch({
    status: 429,
    body: { error: { message: "Rate limit exceeded", code: 429, status: "RESOURCE_EXHAUSTED" } },
  });

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import("@/lib/ai-planning/provider");
    const provider = getWebsitePlanningProvider();
    assert.ok(provider !== null);

    const request = {
      businessSummary: "A test business.",
      targetAudience: "Test audience.",
      requestedPageCount: 1,
      pages: [{ title: "Home", purpose: "Home page.", requiredContent: "Welcome." }],
      preferredTheme: "studio" as const,
      designPreferences: { notes: "" },
      productIds: [],
      specialRequirements: "",
    };

    await assert.rejects(requestValidatedWebsitePlan(provider, request));
  } finally {
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }
});

test("gemini provider: HTTP 503 upstream error is mapped to 503 HttpError", async () => {
  mockFetch({
    status: 503,
    body: { error: { message: "Model overloaded", code: 503, status: "UNAVAILABLE" } },
  });

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import("@/lib/ai-planning/provider");
    const provider = getWebsitePlanningProvider();
    assert.ok(provider !== null);

    const request = {
      businessSummary: "A test business.",
      targetAudience: "Test audience.",
      requestedPageCount: 1,
      pages: [{ title: "Home", purpose: "Home page.", requiredContent: "Welcome." }],
      preferredTheme: "studio" as const,
      designPreferences: { notes: "" },
      productIds: [],
      specialRequirements: "",
    };

    try {
      await requestValidatedWebsitePlan(provider, request);
      assert.fail("Expected requestValidatedWebsitePlan to throw");
    } catch (error) {
      assert.ok(error instanceof Error);
      const httpError = error as { status?: number; code?: string };
      assert.equal(httpError.status, 503);
      assert.equal(httpError.code, "provider_unavailable");
    }
  } finally {
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }
});

test("gemini provider: markdown-fenced JSON response is parsed correctly", async () => {
  const validPlan = {
    businessSummary: "A test business.",
    targetAudience: "Test audience.",
    recommendedTheme: "studio",
    requestedPageCount: 1,
    designPreferences: { notes: "Test notes." },
    specialRequirements: "",
    productIds: [],
    pages: [
      {
        title: "Home",
        slug: "home",
        purpose: "Home page.",
        proposedContent: "Welcome.",
        isHome: true,
        sections: [],
      },
    ],
    navigation: [{ pageSlug: "home", label: "Home" }],
    assumptions: [],
    unansweredQuestions: [],
    summary: "A test plan.",
  };

  mockFetch({
    status: 200,
    body: {
      candidates: [
        {
          content: {
            parts: [{ text: "```json\n" + JSON.stringify(validPlan) + "\n```" }],
          },
        },
      ],
    },
  });

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import("@/lib/ai-planning/provider");
    const provider = getWebsitePlanningProvider();
    assert.ok(provider !== null);

    const request = {
      businessSummary: "A test business.",
      targetAudience: "Test audience.",
      requestedPageCount: 1,
      pages: [{ title: "Home", purpose: "Home page.", requiredContent: "Welcome." }],
      preferredTheme: "studio" as const,
      designPreferences: { notes: "Test notes." },
      productIds: [],
      specialRequirements: "",
    };

    const plan = await requestValidatedWebsitePlan(provider, request);
    assert.equal(plan.businessSummary, "A test business.");
    assert.equal(plan.pages.length, 1);
  } finally {
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }
});

test("gemini provider: timeout (AbortError) is mapped to 504 HttpError", async () => {
  global.fetch = async () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    throw err;
  };

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import("@/lib/ai-planning/provider");
    const provider = getWebsitePlanningProvider();
    assert.ok(provider !== null);

    const request = {
      businessSummary: "A test business.",
      targetAudience: "Test audience.",
      requestedPageCount: 1,
      pages: [{ title: "Home", purpose: "Home page.", requiredContent: "Welcome." }],
      preferredTheme: "studio" as const,
      designPreferences: { notes: "" },
      productIds: [],
      specialRequirements: "",
    };

    try {
      await requestValidatedWebsitePlan(provider, request);
      assert.fail("Expected requestValidatedWebsitePlan to throw");
    } catch (error) {
      assert.ok(error instanceof Error);
      const httpError = error as { status?: number; code?: string };
      assert.equal(httpError.status, 504);
      assert.equal(httpError.code, "timeout");
    }
  } finally {
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }
});

test("gemini provider: malformed response is rejected by schema validation", async () => {
  mockFetch({
    status: 200,
    body: {
      candidates: [
        {
          content: {
            parts: [{ text: "not valid json" }],
          },
        },
      ],
    },
  });

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import("@/lib/ai-planning/provider");
    const provider = getWebsitePlanningProvider();
    assert.ok(provider !== null);

    const request = {
      businessSummary: "A test business.",
      targetAudience: "Test audience.",
      requestedPageCount: 1,
      pages: [{ title: "Home", purpose: "Home page.", requiredContent: "Welcome." }],
      preferredTheme: "studio" as const,
      designPreferences: { notes: "" },
      productIds: [],
      specialRequirements: "",
    };

    await assert.rejects(requestValidatedWebsitePlan(provider, request));
  } finally {
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }
});

// ---------------------------------------------------------------------------
// Upstream diagnostics
// ---------------------------------------------------------------------------
// A failed Gemini response must leave one safe breadcrumb: the real HTTP status,
// the numeric code the mapping acts on, and Google's enum status. The API key,
// the URL, the prompt and Google's free-form message must never be recorded.

const DIAGNOSTIC_REQUEST = {
  businessSummary: "SUMMARY_DO_NOT_LOG",
  targetAudience: "AUDIENCE_DO_NOT_LOG",
  requestedPageCount: 1,
  pages: [
    {
      title: "PROMPT_TITLE_DO_NOT_LOG",
      purpose: "PROMPT_PURPOSE_DO_NOT_LOG",
      requiredContent: "",
    },
  ],
  preferredTheme: "studio" as const,
  designPreferences: { notes: "" },
  productIds: [],
  specialRequirements: "",
};

interface CapturedFailure {
  status?: number;
  code?: string;
  message?: string;
}

/** Runs one provider call against a mocked upstream body, capturing diagnostics. */
async function captureProviderResponse(
  status: number,
  body: unknown,
): Promise<{ logs: string; failure: CapturedFailure | undefined; value: unknown }> {
  mockFetch({ status, body });

  const logs: string[] = [];
  const originalConsoleError = console.error;
  console.error = ((...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  }) as typeof console.error;

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  let failure: CapturedFailure | undefined;
  let value: unknown;
  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import(
      "@/lib/ai-planning/provider"
    );
    const provider = getWebsitePlanningProvider();
    if (provider) {
      try {
        value = await requestValidatedWebsitePlan(provider, DIAGNOSTIC_REQUEST);
      } catch (error) {
        failure = error as CapturedFailure;
      }
    }
  } finally {
    console.error = originalConsoleError;
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }

  return { logs: logs.join("\n"), failure, value };
}

test("gemini provider: upstream 503 logs safe scalar diagnostics and keeps the public error", async () => {
  const { logs, failure } = await captureProviderResponse(503, {
    error: { message: "Model overloaded", code: 503, status: "UNAVAILABLE" },
  });

  assert.match(logs, /\[ai-planning\] upstream failure http=503 code=503 status=UNAVAILABLE/);

  // Public contract is unchanged.
  assert.equal(failure?.status, 503);
  assert.equal(failure?.code, "provider_unavailable");
  assert.equal(
    failure?.message,
    "AI planning is temporarily unavailable. Please try manual planning.",
  );
});

test("gemini provider: diagnostics keep the HTTP status separate from the body code", async () => {
  const { logs, failure } = await captureProviderResponse(500, {
    error: { message: "Backend Error", code: 503, status: "UNAVAILABLE" },
  });

  // Diagnostics record both numbers; neither replaces the other.
  assert.match(logs, /http=500/);
  assert.match(logs, /code=503/);

  // Existing mapping is preserved: the body code still drives the public status.
  assert.equal(failure?.status, 503);
  assert.equal(failure?.code, "provider_unavailable");
});

test("gemini provider: missing or malformed diagnostic fields degrade to placeholders", async () => {
  const cases: { body: unknown; expected: RegExp }[] = [
    { body: { error: { code: 503 } }, expected: /http=503 code=503 status=unknown/ },
    { body: { error: { code: 503, status: 42 } }, expected: /http=503 code=503 status=unknown/ },
    {
      body: { error: { code: 503, status: { message: "nested" } } },
      expected: /http=503 code=503 status=unknown/,
    },
    {
      body: { error: { code: 503, status: "not an enum" } },
      expected: /http=503 code=503 status=unknown/,
    },
    {
      body: { error: { code: "boom", status: "UNAVAILABLE" } },
      expected: /http=503 code=unknown status=UNAVAILABLE/,
    },
  ];

  for (const { body, expected } of cases) {
    const { logs } = await captureProviderResponse(503, body);
    assert.match(logs, expected);
  }
});

test("gemini provider: diagnostics never include the key, URL, prompt or upstream message", async () => {
  const { logs } = await captureProviderResponse(503, {
    error: { message: "Model overloaded", code: 503, status: "UNAVAILABLE" },
  });

  assert.ok(!logs.includes("test-key-12345"));
  assert.ok(!logs.includes("key="));
  assert.ok(!logs.includes("generativelanguage"));
  assert.ok(!logs.includes("https://"));
  assert.ok(!logs.includes("Model overloaded"));
  assert.ok(!logs.includes("SUMMARY_DO_NOT_LOG"));
  assert.ok(!logs.includes("AUDIENCE_DO_NOT_LOG"));
  assert.ok(!logs.includes("PROMPT_TITLE_DO_NOT_LOG"));
  assert.ok(!logs.includes("PROMPT_PURPOSE_DO_NOT_LOG"));
});

test("gemini provider: a non-JSON error body still logs placeholders", async () => {
  const logs: string[] = [];
  const originalConsoleError = console.error;
  console.error = ((...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  }) as typeof console.error;

  global.fetch = async () => new Response("<html>upstream down</html>", { status: 502 });

  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-12345";

  let failure: CapturedFailure | undefined;
  try {
    const { getWebsitePlanningProvider, requestValidatedWebsitePlan } = await import(
      "@/lib/ai-planning/provider"
    );
    const provider = getWebsitePlanningProvider();
    if (provider) {
      try {
        await requestValidatedWebsitePlan(provider, DIAGNOSTIC_REQUEST);
      } catch (error) {
        failure = error as CapturedFailure;
      }
    }
  } finally {
    console.error = originalConsoleError;
    restoreFetch();
    if (savedKey) {
      process.env.GEMINI_API_KEY = savedKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  }

  const joined = logs.join("\n");
  assert.match(joined, /http=502 code=502 status=unknown/);
  assert.ok(!joined.includes("upstream down"));
  assert.equal(failure?.status, 502);
  assert.equal(failure?.code, "provider_error");
});

// ---------------------------------------------------------------------------
// Response completeness: truncation, multiple parts, blocking
// ---------------------------------------------------------------------------
// A 200 response can still be unusable. These cases record only metadata
// (finishReason, blockReason, part count, character count) — never the text.

const VALID_PLAN = {
  businessSummary: "A test business.",
  targetAudience: "Test audience.",
  recommendedTheme: "studio",
  requestedPageCount: 1,
  designPreferences: { notes: "Test notes." },
  specialRequirements: "",
  productIds: [],
  pages: [
    {
      title: "Home",
      slug: "home",
      purpose: "Home page.",
      proposedContent: "Welcome.",
      isHome: true,
      sections: [],
    },
  ],
  navigation: [{ pageSlug: "home", label: "Home" }],
  assumptions: [],
  unansweredQuestions: [],
  summary: "A test plan.",
};

test("gemini provider: MAX_TOKENS is classified as truncation, not invalid JSON", async () => {
  const { logs, failure, value } = await captureProviderResponse(200, {
    candidates: [
      {
        finishReason: "MAX_TOKENS",
        content: { parts: [{ text: '{"businessSummary":"TRUNCATED_CANARY' }] },
      },
    ],
  });

  assert.equal(value, undefined);
  assert.equal(failure?.status, 422);
  assert.equal(failure?.code, "output_truncated");
  assert.equal(
    failure?.message,
    "AI planning response was cut off before it finished. Please try manual planning.",
  );
  assert.match(logs, /\[ai-planning\] response finish=MAX_TOKENS block=unknown parts=1 chars=\d+/);

  // Metadata only: no generated text, key or prompt.
  assert.ok(!logs.includes("TRUNCATED_CANARY"));
  assert.ok(!logs.includes("test-key-12345"));
  assert.ok(!logs.includes("SUMMARY_DO_NOT_LOG"));
});

test("gemini provider: a usable response without finish metadata succeeds silently", async () => {
  const { logs, failure, value } = await captureProviderResponse(200, {
    candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PLAN) }] } }],
  });

  assert.equal(failure, undefined);
  assert.equal((value as { businessSummary: string }).businessSummary, "A test business.");
  assert.equal(logs, "");
});

test("gemini provider: multiple parts are assembled in order and thoughts are excluded", async () => {
  const json = JSON.stringify(VALID_PLAN);
  const midpoint = Math.floor(json.length / 2);

  const { logs, failure, value } = await captureProviderResponse(200, {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            // Would break parsing if it were treated as output.
            { text: '{"thoughtOnly":true}', thought: true },
            { text: json.slice(0, midpoint) },
            { text: json.slice(midpoint) },
          ],
        },
      },
    ],
  });

  assert.equal(failure, undefined);
  assert.equal((value as { pages: unknown[] }).pages.length, 1);
  assert.equal(logs, "");
});

test("gemini provider: empty or missing text keeps the empty-content error and logs metadata", async () => {
  const cases: { body: unknown; expected: RegExp }[] = [
    {
      body: { candidates: [{ finishReason: "STOP", content: { parts: [] } }] },
      expected: /finish=STOP block=unknown parts=0 chars=0/,
    },
    {
      body: { candidates: [{}] },
      expected: /finish=unknown block=unknown parts=0 chars=0/,
    },
    {
      body: { candidates: [{ content: { parts: [{ text: "   " }] } }] },
      expected: /finish=unknown block=unknown parts=1 chars=3/,
    },
    {
      body: {
        candidates: [{ content: { parts: [{ text: "THOUGHT_ONLY_CANARY", thought: true }] } }],
      },
      expected: /finish=unknown block=unknown parts=1 chars=0/,
    },
  ];

  for (const { body, expected } of cases) {
    const { logs, failure } = await captureProviderResponse(200, body);
    assert.equal(failure?.status, 502);
    assert.equal(failure?.code, "provider_error");
    assert.equal(
      failure?.message,
      "AI planning returned empty content. Please try manual planning.",
    );
    assert.match(logs, expected);
    assert.ok(!logs.includes("THOUGHT_ONLY_CANARY"));
  }
});

test("gemini provider: a blocked prompt logs the reason and keeps the no-results error", async () => {
  const { logs, failure } = await captureProviderResponse(200, {
    promptFeedback: { blockReason: "SAFETY" },
    candidates: [],
  });

  assert.match(logs, /\[ai-planning\] response finish=unknown block=SAFETY parts=0 chars=0/);
  assert.equal(failure?.status, 502);
  assert.equal(failure?.code, "provider_error");
  assert.equal(failure?.message, "AI planning returned no results. Please try manual planning.");
});

test("gemini provider: unparseable text still reports invalid_response with a length only", async () => {
  const { logs, failure } = await captureProviderResponse(200, {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "PROSE_ONLY_CANARY" }] } }],
  });

  assert.equal(failure?.status, 422);
  assert.equal(failure?.code, "invalid_response");
  assert.match(logs, /\[ai-planning\] response not parseable chars=\d+/);
  assert.ok(!logs.includes("PROSE_ONLY_CANARY"));
});

test("gemini provider: schema validation still rejects a complete but wrong plan", async () => {
  const { failure } = await captureProviderResponse(200, {
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify({ ...VALID_PLAN, unexpectedKey: true }) }] },
      },
    ],
  });

  assert.equal(failure?.status, 422);
  assert.equal(failure?.code, "invalid_plan");
});