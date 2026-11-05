import assert from "node:assert/strict";
import test from "node:test";

import {
  clearEmailOutbox,
  createTransport,
  EmailConfigurationError,
  EmailSendError,
  getEmailOutbox,
  resolveEmailConfig,
  RESEND_ENDPOINT,
  type EmailMessage,
  type ResolvedEmailConfig,
} from "../../lib/email";

// Transport tests never touch the network: fetch is always stubbed. Safe
// dummies only; the "API key" is an obvious placeholder that must never appear
// in an error message.

const DUMMY_KEY = "re_dummy_key_never_logged";
const FROM = "SiteForge <no-reply@example.com>";
const ACTION_URL = "https://app.example.com/action?token=SUPERSECRET";

const MESSAGE: EmailMessage = {
  to: "alice@example.com",
  subject: "Hello",
  text: `plain text ${ACTION_URL}`,
  html: `<p>html</p><a href="${ACTION_URL}">link</a>`,
};

type ResendConfig = Extract<ResolvedEmailConfig, { kind: "resend" }>;

function resendConfig(overrides: Partial<ResendConfig> = {}): ResendConfig {
  return {
    kind: "resend",
    apiKey: DUMMY_KEY,
    from: FROM,
    appUrl: "https://app.example.com",
    timeoutMs: 10_000,
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("resend posts to the expected endpoint with auth headers and payload", async () => {
  const { fetchImpl, calls } = stubFetch(async () =>
    jsonResponse({ id: "email_123" }),
  );
  const transport = createTransport(resendConfig(), { fetchImpl });

  const result = await transport.send(MESSAGE);

  assert.equal(result.provider, "resend");
  assert.equal(result.id, "email_123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_ENDPOINT);
  assert.equal(calls[0].init?.method, "POST");

  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${DUMMY_KEY}`);
  assert.equal(headers["Content-Type"], "application/json");

  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(body.to, ["alice@example.com"]);
  assert.equal(body.from, FROM);
  assert.equal(body.subject, MESSAGE.subject);
  assert.equal(body.text, MESSAGE.text);
  assert.equal(body.html, MESSAGE.html);
  assert.ok(!("reply_to" in body));
});

test("reply_to is sent only when configured", async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse({ id: "x" }));
  const transport = createTransport(
    resendConfig({ replyTo: "support@example.com" }),
    { fetchImpl },
  );

  await transport.send(MESSAGE);

  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.equal(body.reply_to, "support@example.com");
});

test("non-success provider responses raise a controlled error", async () => {
  const { fetchImpl } = stubFetch(
    async () => new Response("provider detail cannot leak", { status: 401 }),
  );
  const transport = createTransport(resendConfig(), { fetchImpl });

  await assert.rejects(transport.send(MESSAGE), (error: unknown) => {
    assert.ok(error instanceof EmailSendError);
    const err = error as EmailSendError;
    assert.equal(err.status, 401);
    assert.match(err.message, /401/);
    assert.ok(!err.message.includes(DUMMY_KEY));
    assert.ok(!err.message.includes("provider detail cannot leak"));
    return true;
  });
});

test("network failures are wrapped, not surfaced raw", async () => {
  const fetchImpl = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1");
  }) as typeof fetch;
  const transport = createTransport(resendConfig(), { fetchImpl });

  await assert.rejects(transport.send(MESSAGE), (error: unknown) => {
    assert.ok(error instanceof EmailSendError);
    assert.match((error as Error).message, /failed before receiving a response/);
    assert.ok(!(error as Error).message.includes("ECONNREFUSED"));
    return true;
  });
});

test("a request exceeding the timeout is aborted and reported", async () => {
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as typeof fetch;
  const transport = createTransport(resendConfig(), { fetchImpl, timeoutMs: 20 });

  await assert.rejects(transport.send(MESSAGE), (error: unknown) => {
    assert.ok(error instanceof EmailSendError);
    assert.match((error as Error).message, /timed out/);
    return true;
  });
});

test("memory transport records messages in the shared outbox", async () => {
  clearEmailOutbox();
  const transport = createTransport({ kind: "memory" });

  const result = await transport.send(MESSAGE);

  assert.deepEqual(result, { provider: "memory", id: null });
  const outbox = getEmailOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].subject, MESSAGE.subject);
  assert.equal(outbox[0].to, MESSAGE.to);

  clearEmailOutbox();
  assert.equal(getEmailOutbox().length, 0);
});

test("memory transport refuses to operate in production", async () => {
  const transport = createTransport({ kind: "memory" }, { production: true });
  await assert.rejects(
    transport.send(MESSAGE),
    (error: unknown) => error instanceof EmailConfigurationError,
  );
});

test("console transport refuses to operate in production", async () => {
  const transport = createTransport({ kind: "console" }, { production: true });
  await assert.rejects(
    transport.send(MESSAGE),
    (error: unknown) => error instanceof EmailConfigurationError,
  );
});

test("console transport logs a masked recipient with no links or tokens", async () => {
  const logs: string[] = [];
  const original = console.info;
  console.info = ((...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  }) as typeof console.info;

  try {
    const transport = createTransport({ kind: "console" });
    const result = await transport.send(MESSAGE);
    assert.deepEqual(result, { provider: "console", id: null });
  } finally {
    console.info = original;
  }

  const joined = logs.join("\n");
  assert.match(joined, /a\*\*\*@example\.com/);
  assert.ok(!joined.includes("SUPERSECRET"));
  assert.ok(!joined.includes("http"));
});

test("unconfigured transport fails clearly instead of faking delivery", async () => {
  const transport = createTransport({ kind: "unconfigured" });
  await assert.rejects(
    transport.send(MESSAGE),
    (error: unknown) => error instanceof EmailConfigurationError,
  );
});

test("a resolved resend config can be turned into a transport", () => {
  const resolved = resolveEmailConfig({
    NODE_ENV: "test",
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: DUMMY_KEY,
    EMAIL_FROM: FROM,
    EMAIL_REPLY_TO: "",
    APP_URL: "https://app.example.com",
  });
  const transport = createTransport(resolved);
  assert.equal(transport.provider, "resend");
});
