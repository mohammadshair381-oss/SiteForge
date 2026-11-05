import assert from "node:assert/strict";
import test from "node:test";

import { resolveEmailConfig, type EmailEnv } from "../../lib/email";

// Pure tests: resolveEmailConfig() takes plain values and never reads
// process.env, so these cases are order-independent. Safe dummies only.

const DUMMY_KEY = "re_dummy_key_never_logged";

function config(overrides: Partial<EmailEnv> = {}): EmailEnv {
  return {
    NODE_ENV: "development",
    EMAIL_PROVIDER: "",
    EMAIL_API_KEY: "",
    EMAIL_FROM: "",
    EMAIL_REPLY_TO: "",
    APP_URL: "",
    ...overrides,
  };
}

test("empty EMAIL_PROVIDER selects console in development", () => {
  assert.deepEqual(resolveEmailConfig(config()), { kind: "console" });
});

test("empty EMAIL_PROVIDER stays fail-closed in production", () => {
  assert.deepEqual(resolveEmailConfig(config({ NODE_ENV: "production" })), {
    kind: "unconfigured",
  });
});

test("memory is available outside production and refused in production", () => {
  assert.deepEqual(resolveEmailConfig(config({ EMAIL_PROVIDER: "memory" })), {
    kind: "memory",
  });
  assert.throws(
    () =>
      resolveEmailConfig(
        config({ NODE_ENV: "production", EMAIL_PROVIDER: "memory" }),
      ),
    /memory[^]*not allowed in production/,
  );
});

test("console is refused in production", () => {
  assert.throws(
    () =>
      resolveEmailConfig(
        config({ NODE_ENV: "production", EMAIL_PROVIDER: "console" }),
      ),
    /console[^]*not allowed in production/,
  );
});

test("unknown providers are rejected", () => {
  assert.throws(
    () => resolveEmailConfig(config({ EMAIL_PROVIDER: "sendgrid" })),
    /EMAIL_PROVIDER must be one of/,
  );
});

test("resend accepts a display-name sender and normalizes the config", () => {
  const resolved = resolveEmailConfig(
    config({
      EMAIL_PROVIDER: "resend",
      EMAIL_API_KEY: DUMMY_KEY,
      EMAIL_FROM: "SiteForge <no-reply@example.com>",
      APP_URL: "http://localhost:3000",
    }),
  );
  assert.equal(resolved.kind, "resend");
  if (resolved.kind !== "resend") return;
  assert.equal(resolved.apiKey, DUMMY_KEY);
  assert.equal(resolved.from, "SiteForge <no-reply@example.com>");
  assert.equal(resolved.appUrl, "http://localhost:3000");
  assert.equal(resolved.timeoutMs, 10_000);
  assert.equal(resolved.replyTo, undefined);
});

test("resend requires an API key and a plausible sender", () => {
  assert.throws(
    () =>
      resolveEmailConfig(
        config({ EMAIL_PROVIDER: "resend", EMAIL_FROM: "no-reply@example.com" }),
      ),
    /EMAIL_API_KEY is required/,
  );
  assert.throws(
    () =>
      resolveEmailConfig(
        config({
          EMAIL_PROVIDER: "resend",
          EMAIL_API_KEY: DUMMY_KEY,
          EMAIL_FROM: "not-an-address",
        }),
      ),
    /EMAIL_FROM must be a valid sender address/,
  );
});

test("resend in production requires an absolute HTTPS APP_URL", () => {
  const base: Partial<EmailEnv> = {
    NODE_ENV: "production",
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: DUMMY_KEY,
    EMAIL_FROM: "no-reply@example.com",
  };
  assert.throws(
    () => resolveEmailConfig(config({ ...base, APP_URL: "" })),
    /APP_URL is required in production/,
  );
  assert.throws(
    () => resolveEmailConfig(config({ ...base, APP_URL: "app.example.com" })),
    /APP_URL must be an absolute URL/,
  );
  assert.throws(
    () =>
      resolveEmailConfig(config({ ...base, APP_URL: "http://app.example.com" })),
    /APP_URL must be an absolute HTTPS URL/,
  );
  assert.equal(
    resolveEmailConfig(config({ ...base, APP_URL: "https://app.example.com" }))
      .kind,
    "resend",
  );
});

test("EMAIL_REPLY_TO is validated only when provided", () => {
  assert.throws(
    () =>
      resolveEmailConfig(
        config({
          EMAIL_PROVIDER: "resend",
          EMAIL_API_KEY: DUMMY_KEY,
          EMAIL_FROM: "no-reply@example.com",
          EMAIL_REPLY_TO: "not-an-address",
        }),
      ),
    /EMAIL_REPLY_TO must be a valid email address/,
  );

  const resolved = resolveEmailConfig(
    config({
      EMAIL_PROVIDER: "resend",
      EMAIL_API_KEY: DUMMY_KEY,
      EMAIL_FROM: "no-reply@example.com",
      EMAIL_REPLY_TO: "support@example.com",
    }),
  );
  assert.equal(resolved.kind === "resend" && resolved.replyTo, "support@example.com");
});

test("configuration errors never include the API key value", () => {
  let message = "";
  try {
    resolveEmailConfig(
      config({
        NODE_ENV: "production",
        EMAIL_PROVIDER: "resend",
        EMAIL_API_KEY: DUMMY_KEY,
        EMAIL_FROM: "",
        APP_URL: "",
      }),
    );
    assert.fail("expected resolveEmailConfig to throw");
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /EMAIL_FROM/);
  assert.ok(!message.includes(DUMMY_KEY));
});
