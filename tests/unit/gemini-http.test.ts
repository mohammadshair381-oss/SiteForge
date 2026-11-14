import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";

import { GEMINI_TIMEOUT_MS, geminiGenerateJson, parseProviderJson } from "../../backend/lib/ai-planning/gemini-http";
import { HttpError } from "../../backend/lib/api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

const options = { apiKey: "test-key", prompt: "<owner_request>hi</owner_request>", system: "Return JSON.", maxOutputTokens: 512, logTag: "ai-builder", subject: "AI suggestions", advice: "Please try again later." };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("the key goes only in a header; fixed instructions are sent apart from the untrusted prompt", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return ok({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 } });
  }) as typeof fetch;
  const result = await geminiGenerateJson(options);
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.usage, { promptTokens: 12, outputTokens: 5, totalTokens: 17 });
  assert.ok(!seen!.url.includes("test-key") && !seen!.url.includes("key="), "no key in the URL");
  assert.equal((seen!.init.headers as Record<string, string>)["x-goog-api-key"], "test-key");
  const body = JSON.parse(String(seen!.init.body));
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Return JSON." }] });
  assert.equal(body.contents[0].parts[0].text, options.prompt);
  assert.equal(body.generationConfig.maxOutputTokens, 512);
});

test("token counts are only the provider's own numbers (null when absent or malformed)", async () => {
  globalThis.fetch = (async () => ok({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: { promptTokenCount: "12", totalTokenCount: -1 } })) as unknown as typeof fetch;
  assert.deepEqual((await geminiGenerateJson(options)).usage, { promptTokens: null, outputTokens: null, totalTokens: null });
});

test("the timeout also covers a response body that never finishes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    // Headers arrive at once; the body hangs until the request is aborted.
    return {
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    } as unknown as Response;
  }) as typeof fetch;
  const pending = geminiGenerateJson(options);
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(GEMINI_TIMEOUT_MS);
  await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.status === 504 && error.code === "timeout" && error.message === "AI suggestions request timed out. Please try again later.");
});

test("upstream errors become fixed messages; Google's text is never forwarded or logged", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "secret project detail" } }), { status: 429 })) as typeof fetch;
    await assert.rejects(geminiGenerateJson(options), (e: unknown) => e instanceof HttpError && e.status === 429 && !e.message.includes("secret"));
    assert.ok(logs.every((line) => !line.includes("secret") && !line.includes("test-key")));
    assert.match(logs[0], /^\[ai-builder\] upstream failure http=429 code=429 status=RESOURCE_EXHAUSTED$/);
  } finally {
    console.error = original;
  }
});

test("provider JSON is parsed from raw, fenced or embedded output; nothing else", () => {
  assert.deepEqual(parseProviderJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseProviderJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseProviderJson('Sure! {"a":3} done'), { a: 3 });
  assert.equal(parseProviderJson("no json here"), undefined);
  assert.equal(parseProviderJson("{broken"), undefined);
});

test("model and timeout come from the server environment; invalid values never reach the network", async () => {
  const { geminiModel, aiProviderTimeoutMs, DEFAULT_GEMINI_MODEL } = await import("../../backend/lib/env");
  const { aiBuilderStatus } = await import("../../backend/lib/ai-builder/provider");
  const saved = { model: process.env.GEMINI_MODEL, timeout: process.env.AI_PROVIDER_TIMEOUT_MS, enabled: process.env.AI_PROVIDER_ENABLED, key: process.env.GEMINI_API_KEY };
  try {
    delete process.env.GEMINI_MODEL;
    assert.equal(geminiModel(), DEFAULT_GEMINI_MODEL);
    process.env.GEMINI_MODEL = " gemini-2.5-pro ";
    assert.equal(geminiModel(), "gemini-2.5-pro");
    for (const bad of ["gpt-4", "gemini-../../x", "gemini-pro?key=1", "GEMINI-PRO"]) {
      process.env.GEMINI_MODEL = bad;
      assert.equal(geminiModel(), null, bad);
    }
    process.env.AI_PROVIDER_ENABLED = "true";
    process.env.GEMINI_API_KEY = "test-key";
    assert.deepEqual(aiBuilderStatus(), { enabled: true, configured: false, available: false }, "an invalid model disables AI");
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return ok({});
    }) as unknown as typeof fetch;
    await assert.rejects(geminiGenerateJson(options), (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "provider_not_configured");
    assert.equal(called, false);

    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    let url = "";
    globalThis.fetch = (async (u: string) => {
      url = u;
      return ok({ candidates: [{ content: { parts: [{ text: "{}" }] } }] });
    }) as unknown as typeof fetch;
    assert.equal((await geminiGenerateJson(options)).model, "gemini-2.5-pro");
    assert.ok(url.endsWith("/models/gemini-2.5-pro:generateContent"));

    for (const [value, expected] of [[undefined, 30_000], ["5000", 5000], ["0", 30_000], ["999999", 30_000], ["abc", 30_000], ["1.5", 30_000]] as const) {
      if (value === undefined) delete process.env.AI_PROVIDER_TIMEOUT_MS;
      else process.env.AI_PROVIDER_TIMEOUT_MS = value;
      assert.equal(aiProviderTimeoutMs(), expected, String(value));
    }
  } finally {
    for (const [name, value] of [["GEMINI_MODEL", saved.model], ["AI_PROVIDER_TIMEOUT_MS", saved.timeout], ["AI_PROVIDER_ENABLED", saved.enabled], ["GEMINI_API_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("personal or secret data in the outgoing text is refused before any request", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return ok({});
  }) as unknown as typeof fetch;
  for (const prompt of ["Email jane@example.com", "Call +1 415 555 0134", "Key AIzaSyA1234567890abcdefghijklmnop"]) {
    await assert.rejects(geminiGenerateJson({ ...options, prompt }), (error: unknown) => error instanceof HttpError && error.status === 422 && error.code === "unsafe_content");
  }
  assert.equal(called, false);
});

test("a request that never got an HTTP response is reported as unreachable (callers do not charge it)", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(
    geminiGenerateJson(options),
    (error: unknown) => error instanceof HttpError && error.status === 502 && error.code === "provider_unreachable" && error.message === "AI suggestions request failed. Please try again later.",
  );
});
