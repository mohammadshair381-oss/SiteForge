import "../helpers/env";

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { claudeAdapter } from "../../backend/lib/ai-providers/claude";
import { openaiAdapter } from "../../backend/lib/ai-providers/openai";
import { decryptAiKey, encryptAiKey, lastFour } from "../../backend/lib/ai-providers/credentials";
import { AiProviderError } from "../../backend/lib/ai-providers/errors";
import { AI_DISCLOSED_PROVIDER_IDS, getAiProvider } from "../../backend/lib/ai-providers/registry";
import type { AiProviderRequest } from "../../backend/lib/ai-providers/types";

/** The Claude and OpenAI adapters, against a faked network: nothing here reaches a real provider. */

const realFetch = globalThis.fetch;
const CLAUDE_KEY = "sk-ant-test-0000000000000000000000claude";
const OPENAI_KEY = "sk-test-00000000000000000000000000openai";
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = CLAUDE_KEY;
  process.env.OPENAI_API_KEY = OPENAI_KEY;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

const request = (model: string): AiProviderRequest => ({
  model,
  system: "Return JSON.",
  prompt: "<owner_request>hi</owner_request>",
  history: [{ role: "user", text: "earlier" }, { role: "assistant", text: "noted" }],
  maxOutputTokens: 1024,
  logTag: "ai-builder",
  subject: "AI suggestions",
  advice: "Please try again later.",
});

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const claudeAnswer = (text: string, stop = "end_turn") =>
  sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);

test("both providers are registered and named in the owners' consent", () => {
  assert.ok(getAiProvider("claude"));
  assert.ok(getAiProvider("openai"));
  assert.deepEqual([...AI_DISCLOSED_PROVIDER_IDS].sort(), ["claude", "gemini", "openai"]);
  assert.equal(claudeAdapter.isConfigured(), true);
  assert.equal(claudeAdapter.defaultModel(), "claude-opus-5-5");
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(claudeAdapter.isConfigured(), false, "no key, not configured");
});

test("Claude: the key goes only in a header, the request carries the conversation, and JSON comes back", async () => {
  let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    return claudeAnswer('{"ok":true}');
  }) as typeof fetch;
  const result = await claudeAdapter.generateStructured(request("claude-opus-5-5"));
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.providerId, "claude");
  assert.deepEqual(result.usage, { promptTokens: 12, outputTokens: 5, totalTokens: 17 });
  assert.ok(seen);
  const call = seen as { url: string; headers: Headers; body: Record<string, unknown> };
  assert.match(call.url, /\/v1\/messages/);
  // The SDK sends the key as x-api-key or in Authorization, depending on its version: a header either way.
  assert.ok(call.headers.get("x-api-key") === CLAUDE_KEY || (call.headers.get("authorization") ?? "").endsWith(CLAUDE_KEY), "the key is in a header");
  assert.ok(!call.url.includes(CLAUDE_KEY) && !JSON.stringify(call.body).includes(CLAUDE_KEY), "the key is never in the address or the body");
  assert.equal(call.body.model, "claude-opus-5-5");
  assert.equal(call.body.system, "Return JSON.");
  assert.deepEqual(call.body.messages, [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "noted" },
    { role: "user", content: "<owner_request>hi</owner_request>" },
  ]);
  assert.equal(call.body.fallbacks, "default", "refusals fall back on the server");
  assert.match(call.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
});

test("Claude: a refusal or a cut-off answer is never used", async () => {
  globalThis.fetch = (async () => claudeAnswer("", "refusal")) as unknown as typeof fetch;
  await assert.rejects(claudeAdapter.generateStructured(request("claude-opus-5-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "blocked");
  globalThis.fetch = (async () => claudeAnswer('{"partial', "max_tokens")) as unknown as typeof fetch;
  await assert.rejects(claudeAdapter.generateStructured(request("claude-opus-5-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "truncated");
});

test("Claude: upstream errors become fixed messages, and neither the key nor Anthropic's text is logged", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "secret upstream detail" } }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await assert.rejects(claudeAdapter.generateText(request("claude-opus-5-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "authentication" && !error.message.includes("secret upstream detail"));
    globalThis.fetch = (async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await assert.rejects(claudeAdapter.generateText(request("claude-opus-5-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "rate_limited");
  } finally {
    console.error = original;
  }
  assert.ok(logs.every((line) => !line.includes(CLAUDE_KEY) && !line.includes("secret upstream detail")));
});

test("OpenAI: the key goes only in a header, JSON mode is asked for, and usage is the provider's own numbers", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await openaiAdapter.generateStructured(request("gpt-5"));
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.usage, { promptTokens: 9, outputTokens: 4, totalTokens: 13 });
  assert.ok(seen);
  const call = seen as { url: string; init: RequestInit };
  assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  assert.equal((call.init.headers as Record<string, string>).Authorization, `Bearer ${OPENAI_KEY}`);
  const body = JSON.parse(String(call.init.body));
  assert.ok(!String(call.init.body).includes(OPENAI_KEY));
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages.at(-1).content, "<owner_request>hi</owner_request>");
});

test("OpenAI: a cut-off, refused or failed answer is never used", async () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  globalThis.fetch = reply({ choices: [{ finish_reason: "length", message: { content: '{"part' } }] });
  await assert.rejects(openaiAdapter.generateStructured(request("gpt-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "truncated");
  globalThis.fetch = reply({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] });
  await assert.rejects(openaiAdapter.generateStructured(request("gpt-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "blocked");
  globalThis.fetch = reply({ error: { message: "secret" } }, 401);
  await assert.rejects(openaiAdapter.generateStructured(request("gpt-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "authentication" && !error.message.includes("secret"));
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(openaiAdapter.generateStructured(request("gpt-5")), (error: unknown) => error instanceof AiProviderError && error.kind === "not_configured" && error.reachedProvider === false);
});

test("stored keys are encrypted, readable only with the same secret, and only the last four leave", () => {
  const encrypted = encryptAiKey(CLAUDE_KEY);
  assert.ok(!JSON.stringify(encrypted).includes(CLAUDE_KEY), "the stored value never contains the key");
  assert.equal(decryptAiKey(encrypted), CLAUDE_KEY);
  assert.notEqual(encryptAiKey(CLAUDE_KEY).iv, encrypted.iv, "a new IV each time");
  assert.equal(decryptAiKey({ ...encrypted, tag: Buffer.alloc(16).toString("base64") }), null, "damaged values read as missing");
  assert.equal(lastFour(CLAUDE_KEY), "aude");
});
