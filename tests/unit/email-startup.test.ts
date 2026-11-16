import assert from "node:assert/strict";
import test from "node:test";

import { assertEmailStartupConfig, createTransport, EmailConfigurationError, EmailDisabledError, isEmailDisabled, resolveEmailConfig, type EmailEnv } from "../../backend/lib/email";

// Pure tests of the startup rule: assertEmailStartupConfig(config) takes plain values and never
// reads process.env or contacts a provider. Safe, obviously fake values only.

const KEY = "re_dummy_startup_key_never_logged";

function config(overrides: Partial<EmailEnv> = {}): EmailEnv {
  return {
    NODE_ENV: "production",
    EMAIL_PROVIDER: "",
    EMAIL_API_KEY: "",
    EMAIL_FROM: "",
    EMAIL_REPLY_TO: "",
    APP_URL: "",
    ...overrides,
  };
}

const validProduction: Partial<EmailEnv> = {
  EMAIL_PROVIDER: "resend",
  EMAIL_API_KEY: KEY,
  EMAIL_FROM: "SiteForge <no-reply@example.com>",
  APP_URL: "https://app.example.com",
};

function startupMessage(values: EmailEnv): string {
  try {
    assertEmailStartupConfig(values);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

// --- production: refused ---------------------------------------------------------------------

test("production refuses to start when no email provider is configured", () => {
  const message = startupMessage(config());
  assert.match(message, /Email must be configured in production/);
  assert.match(message, /missing: EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM, APP_URL/);
  assert.match(message, /password-reset code/);
});

test("the missing list names only what is actually missing", () => {
  const message = startupMessage(config({ EMAIL_API_KEY: KEY, EMAIL_FROM: "no-reply@example.com", APP_URL: "https://app.example.com" }));
  assert.match(message, /missing: EMAIL_PROVIDER\)/);
  assert.ok(!message.includes(KEY), "the key value never appears");
});

test("a provider of only spaces counts as missing in production", () => {
  assert.match(startupMessage(config({ ...validProduction, EMAIL_PROVIDER: "   " })), /missing: EMAIL_PROVIDER\)/);
});

test("production refuses the console and memory transports", () => {
  assert.match(startupMessage(config({ ...validProduction, EMAIL_PROVIDER: "console" })), /'console' is not allowed in production/);
  assert.match(startupMessage(config({ ...validProduction, EMAIL_PROVIDER: "memory" })), /'memory' is not allowed in production/);
  assert.match(startupMessage(config({ ...validProduction, EMAIL_PROVIDER: "CONSOLE" })), /'console' is not allowed in production/);
});

test("production refuses an unknown provider", () => {
  assert.match(startupMessage(config({ ...validProduction, EMAIL_PROVIDER: "smtp" })), /EMAIL_PROVIDER must be one of/);
});

test("production refuses incomplete Resend settings", () => {
  assert.match(startupMessage(config({ ...validProduction, EMAIL_API_KEY: "" })), /EMAIL_API_KEY is required/);
  assert.match(startupMessage(config({ ...validProduction, EMAIL_FROM: "" })), /EMAIL_FROM must be a valid sender address/);
  assert.match(startupMessage(config({ ...validProduction, APP_URL: "" })), /APP_URL is required in production/);
});

test("production refuses a malformed API key without echoing it", () => {
  const malformed = [
    "sk_live_not_a_resend_key_1234",
    `"${KEY}"`, // pasted with its quotes
    "re_short",
    "re_has space_inside_1234",
    `re_newline\n_inside_1234`,
  ];
  for (const value of malformed) {
    const message = startupMessage(config({ ...validProduction, EMAIL_API_KEY: value }));
    assert.match(message, /EMAIL_API_KEY does not look like a Resend API key/, JSON.stringify(value.slice(0, 3)));
    assert.ok(!message.includes(value.trim()), "the key value never appears");
  }
});

test("production refuses malformed sender addresses", () => {
  for (const value of ["not-an-address", "SiteForge <no-reply@example.com>\r\nBcc: x@example.com", "no-reply@example"]) {
    assert.match(startupMessage(config({ ...validProduction, EMAIL_FROM: value })), /EMAIL_FROM must be a valid sender address/);
  }
  assert.match(
    startupMessage(config({ ...validProduction, EMAIL_REPLY_TO: "help@example.com\nX: y" })),
    /EMAIL_REPLY_TO must be a valid email address/,
  );
});

test("production refuses an APP_URL that is not a bare HTTPS base address", () => {
  assert.match(startupMessage(config({ ...validProduction, APP_URL: "app.example.com" })), /APP_URL must be an absolute URL/);
  assert.match(startupMessage(config({ ...validProduction, APP_URL: "http://app.example.com" })), /absolute HTTPS URL in production/);
  for (const value of ["https://user:pass@app.example.com", "https://app.example.com/?ref=mail", "https://app.example.com/#top"]) {
    const message = startupMessage(config({ ...validProduction, APP_URL: value }));
    assert.match(message, /APP_URL must be the application's base address/);
    assert.ok(!message.includes("pass@"), "no URL credentials echoed");
  }
});

// --- production: accepted --------------------------------------------------------------------

test("production starts with structurally valid Resend settings", () => {
  assert.doesNotThrow(() => assertEmailStartupConfig(config(validProduction)));
  assert.doesNotThrow(() => assertEmailStartupConfig(config({ ...validProduction, EMAIL_FROM: "no-reply@example.com" })));
  assert.doesNotThrow(() => assertEmailStartupConfig(config({ ...validProduction, APP_URL: "https://app.example.com/" })));
  assert.doesNotThrow(() => assertEmailStartupConfig(config({ ...validProduction, EMAIL_REPLY_TO: "support@example.com" })));
  assert.doesNotThrow(() => assertEmailStartupConfig(config({ ...validProduction, EMAIL_PROVIDER: "Resend" })));
});

// --- development and test: unchanged ---------------------------------------------------------

test("development still starts with an empty provider (console), console or memory", () => {
  for (const provider of ["", "console", "memory"]) {
    assert.doesNotThrow(() => assertEmailStartupConfig(config({ NODE_ENV: "development", EMAIL_PROVIDER: provider })), provider);
  }
  assert.deepEqual(resolveEmailConfig(config({ NODE_ENV: "development" })), { kind: "console" });
});

test("the test environment keeps the memory outbox and an empty provider", () => {
  assert.doesNotThrow(() => assertEmailStartupConfig(config({ NODE_ENV: "test", EMAIL_PROVIDER: "memory" })));
  assert.doesNotThrow(() => assertEmailStartupConfig(config({ NODE_ENV: "test" })));
  assert.deepEqual(resolveEmailConfig(config({ NODE_ENV: "test", EMAIL_PROVIDER: "memory" })), { kind: "memory" });
});

test("development still accepts Resend over plain-HTTP localhost, and checks it when chosen", () => {
  assert.doesNotThrow(() =>
    assertEmailStartupConfig(config({ ...validProduction, NODE_ENV: "development", APP_URL: "http://localhost:3000" })),
  );
  assert.match(
    startupMessage(config({ ...validProduction, NODE_ENV: "development", EMAIL_API_KEY: "not-a-key-at-all" })),
    /EMAIL_API_KEY does not look like a Resend API key/,
  );
});

test("an unconfigured production transport still fails closed at send time", () => {
  // Defence in depth for any process that skipped the startup hook.
  assert.deepEqual(resolveEmailConfig(config()), { kind: "unconfigured" });
});

// --- the explicit "no email" mode ------------------------------------------------------------

test("EMAIL_PROVIDER=disabled starts in production and development, and says so once", () => {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
  try {
    for (const nodeEnv of ["production", "development", "test"] as const) {
      assert.doesNotThrow(() => assertEmailStartupConfig(config({ NODE_ENV: nodeEnv, EMAIL_PROVIDER: "disabled" })), nodeEnv);
    }
    assert.doesNotThrow(() => assertEmailStartupConfig(config({ EMAIL_PROVIDER: " Disabled " })), "trimmed and case-insensitive");
  } finally {
    console.warn = original;
  }
  assert.ok(warned.every((line) => /EMAIL_PROVIDER=disabled/.test(line)));
  assert.equal(warned.length, 4);
});

test("an empty provider still refuses production, and names both ways forward", () => {
  const message = startupMessage(config());
  assert.match(message, /EMAIL_PROVIDER=resend/);
  assert.match(message, /EMAIL_PROVIDER=disabled/);
  assert.match(startupMessage(config({ EMAIL_PROVIDER: "disable" })), /EMAIL_PROVIDER must be one of/, "a typo is never read as off");
});

test("the disabled transport never sends and throws a configuration error", async () => {
  const resolved = resolveEmailConfig(config({ EMAIL_PROVIDER: "disabled" }));
  assert.deepEqual(resolved, { kind: "disabled" });
  const transport = createTransport(resolved);
  await assert.rejects(transport.send({ to: "a@example.com", subject: "s", text: "t", html: "h" }), (error: unknown) => error instanceof EmailDisabledError && error instanceof EmailConfigurationError);
  assert.equal(isEmailDisabled({ EMAIL_PROVIDER: "disabled" }), true);
  assert.equal(isEmailDisabled({ EMAIL_PROVIDER: "resend" }), false);
  assert.equal(isEmailDisabled({ EMAIL_PROVIDER: "" }), false);
});
