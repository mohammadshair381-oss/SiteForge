import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { created, fail, handle, HttpError, ok, readJson } from "../../lib/api";

test("ok and created return JSON responses with the right status", async () => {
  const okRes = ok({ hello: "world" });
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { hello: "world" });

  const createdRes = created({ id: "1" });
  assert.equal(createdRes.status, 201);
  assert.deepEqual(await createdRes.json(), { id: "1" });
});

test("fail builds the { error, code } shape", async () => {
  const res = fail(418, "teapot", "short");
  assert.equal(res.status, 418);
  assert.deepEqual(await res.json(), { error: "teapot", code: "short" });
});

test("readJson parses a valid JSON body", async () => {
  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: 1 }),
  });
  assert.deepEqual(await readJson(request), { a: 1 });
});

test("readJson turns a malformed body into a 400 invalid_json", async () => {
  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  await assert.rejects(readJson(request), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_json");
    return true;
  });
});

test("handle passes through a successful response", async () => {
  const res = await handle(() => ok({ ok: true }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("handle maps HttpError to its status and code", async () => {
  const res = await handle(() => {
    throw new HttpError(403, "Nope", "forbidden");
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Nope", code: "forbidden" });
});

test("handle maps ZodError to 422 validation_error", async () => {
  const res = await handle(() => {
    z.object({ name: z.string() }).parse({ name: 123 });
    return ok({});
  });
  assert.equal(res.status, 422);
  const body = (await res.json()) as { code: string; error: string };
  assert.equal(body.code, "validation_error");
  assert.match(body.error, /name/i);
});

test("handle maps duplicate-key errors (11000) to 409 conflict", async () => {
  const res = await handle(() => {
    throw Object.assign(new Error("dup"), { code: 11000 });
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: "That record already exists",
    code: "conflict",
  });
});

test("handle hides unexpected errors behind a 500 internal_error", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await handle(() => {
      throw new Error("super secret internal detail");
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "internal_error");
    assert.equal(body.error, "Internal server error");
    assert.ok(!body.error.includes("secret"));
  } finally {
    console.error = originalError;
  }
});

test("fail preserves custom response headers", () => {
  const res = fail(429, "Too many requests", "rate_limited", {
    "Retry-After": "7",
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "7");
});

test("handle preserves HttpError response headers, including Retry-After", async () => {
  const res = await handle(() => {
    throw new HttpError(429, "Too many requests", "rate_limited", {
      "Retry-After": "5",
    });
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "5");
  assert.deepEqual(await res.json(), {
    error: "Too many requests",
    code: "rate_limited",
  });
});

test("an empty JSON body is a 400 invalid_json response", async () => {
  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "",
  });
  const res = await handle(async () => ok(await readJson(request)));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "Invalid JSON body",
    code: "invalid_json",
  });
});

test("readJson refuses oversized bodies and bad JSON", async () => {
  const { readJson, HttpError } = await import("../../lib/api");
  const post = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/x", { method: "POST", body, headers });
  assert.deepEqual(await readJson(post('{"a":1}')), { a: 1 });
  const big = "x".repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(readJson(post(JSON.stringify(big))), (error: unknown) => error instanceof HttpError && error.status === 413);
  await assert.rejects(readJson(post("{}", { "content-length": String(3 * 1024 * 1024) })), (error: unknown) => error instanceof HttpError && error.status === 413);
  await assert.rejects(readJson(post("{not json")), (error: unknown) => error instanceof HttpError && error.status === 400);
});
