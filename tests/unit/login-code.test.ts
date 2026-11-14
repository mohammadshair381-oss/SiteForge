import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { mock } from "node:test";

import {
  generateLoginCode,
  isLoginCode,
  loginCodeDigest,
  pendingLoginView,
  LOGIN_CODE_MAX_SENDS,
  LOGIN_CODE_RESEND_COOLDOWN_MS,
} from "../../backend/lib/auth/login-challenge";
import { developmentLoginCodeLoggingEnabled, logDevelopmentLoginCode, maskEmail } from "../../backend/lib/auth/dev-login-code";
import { renderLoginCodeEmail } from "../../backend/lib/email-templates";
import { platformCredentialFingerprint } from "../../backend/lib/auth/platform-device";

// Self-contained config (safe dummies only), read lazily by env(); nothing here touches a database.
process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "s".repeat(48);

test("codes are six digits from crypto.randomInt, never Math.random, with leading zeros kept", () => {
  const random = mock.method(Math, "random", () => {
    throw new Error("Math.random must not be used");
  });
  try {
    for (let i = 0; i < 2000; i++) assert.match(generateLoginCode(), /^\d{6}$/);
  } finally {
    random.mock.restore();
  }
  const target = crypto as unknown as { randomInt: (...args: unknown[]) => unknown };
  const forced = mock.method(target, "randomInt", () => 42);
  try {
    assert.equal(generateLoginCode(), "000042");
    assert.deepEqual(forced.mock.calls[0].arguments, [0, 1_000_000]);
  } finally {
    forced.mock.restore();
  }
});

test("only exactly six digits count as a code", () => {
  for (const ok of ["000000", "123456", "999999"]) assert.equal(isLoginCode(ok), true);
  for (const bad of ["12345", "1234567", "12345a", " 123456", "", null, 123456, "١٢٣٤٥٦"]) assert.equal(isLoginCode(bad), false);
});

test("a code's stored digest is keyed and bound to the sign-in and the account", () => {
  const digest = loginCodeDigest("challenge-a", "user-1", "123456");
  assert.match(digest, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(digest, loginCodeDigest("challenge-a", "user-1", "123456"));
  assert.notEqual(digest, loginCodeDigest("challenge-b", "user-1", "123456"), "another sign-in");
  assert.notEqual(digest, loginCodeDigest("challenge-a", "user-2", "123456"), "another account");
  assert.notEqual(digest, loginCodeDigest("challenge-a", "user-1", "123457"));
  assert.notEqual(digest, crypto.createHash("sha256").update("123456").digest("base64url"), "not a plain hash");
});

test("the browser view carries timings only", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const view = pendingLoginView({ codeExpiresAt: new Date(now.getTime() + 300_000), lastSentAt: now, sends: 1 }, now);
  assert.deepEqual(view, {
    codeRequired: true,
    expiresInSeconds: 300,
    resendInSeconds: LOGIN_CODE_RESEND_COOLDOWN_MS / 1000,
    resendsLeft: LOGIN_CODE_MAX_SENDS - 1,
    attemptsAllowed: 5,
    attemptsLeft: 5,
  });
  assert.deepEqual(Object.keys(view).sort(), ["attemptsAllowed", "attemptsLeft", "codeRequired", "expiresInSeconds", "resendInSeconds", "resendsLeft"]);
  // Guesses already made stay spent in the view after a resend.
  assert.equal(pendingLoginView({ codeExpiresAt: now, lastSentAt: now, sends: 2, attempts: 3 }, now).attemptsLeft, 2);
});

const DEV = { NODE_ENV: "development", AUTH_LOG_OTP: "true", EMAIL_PROVIDER: "console" };

test("development logging needs development, the exact flag AND an explicitly local email provider", () => {
  const cases: Array<[Record<string, string | undefined>, boolean]> = [
    // Allowed: development + exact flag + console or memory.
    [DEV, true],
    [{ ...DEV, EMAIL_PROVIDER: "memory" }, true],
    [{ ...DEV, EMAIL_PROVIDER: " Console " }, true],
    // The flag must be exactly "true".
    [{ ...DEV, AUTH_LOG_OTP: undefined }, false],
    [{ ...DEV, AUTH_LOG_OTP: "" }, false],
    [{ ...DEV, AUTH_LOG_OTP: "false" }, false],
    [{ ...DEV, AUTH_LOG_OTP: "1" }, false],
    [{ ...DEV, AUTH_LOG_OTP: "TRUE" }, false],
    [{ ...DEV, AUTH_LOG_OTP: " true" }, false],
    [{ ...DEV, AUTH_LOG_OTP: "true\n" }, false],
    // Production, even with the flag and a local provider.
    [{ ...DEV, NODE_ENV: "production" }, false],
    // Staging, test, unset or anything unexpected.
    [{ ...DEV, NODE_ENV: "staging" }, false],
    [{ ...DEV, NODE_ENV: "test" }, false],
    [{ ...DEV, NODE_ENV: undefined }, false],
    [{ ...DEV, NODE_ENV: "Development" }, false],
    [{ ...DEV, NODE_ENV: " development" }, false],
    // A real or unset provider: real delivery never coexists with logging.
    [{ ...DEV, EMAIL_PROVIDER: "resend" }, false],
    [{ ...DEV, EMAIL_PROVIDER: "" }, false],
    [{ ...DEV, EMAIL_PROVIDER: undefined }, false],
    [{ ...DEV, EMAIL_PROVIDER: "smtp" }, false],
    // A hosting platform.
    [{ ...DEV, VERCEL: "1" }, false],
    [{ ...DEV, VERCEL_ENV: "preview" }, false],
  ];
  for (const [environment, expected] of cases) {
    assert.equal(developmentLoginCodeLoggingEnabled(environment as NodeJS.ProcessEnv), expected, JSON.stringify(environment));
  }
});

test("production never writes a code, even with the flag on; development writes one masked line", () => {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  for (const environment of [
    { ...DEV, NODE_ENV: "production" },
    { NODE_ENV: "production", AUTH_LOG_OTP: "true", EMAIL_PROVIDER: "resend" },
    { ...DEV, NODE_ENV: "staging" },
    { ...DEV, EMAIL_PROVIDER: "resend" },
    { NODE_ENV: "development" },
  ]) {
    assert.equal(logDevelopmentLoginCode("jane@example.com", "042042", environment as NodeJS.ProcessEnv, write), false, JSON.stringify(environment));
  }
  assert.deepEqual(lines, []);

  assert.equal(logDevelopmentLoginCode("jane@example.com", "042042", DEV as NodeJS.ProcessEnv, write), true);
  assert.deepEqual(lines, ["[auth] Development sign-in code for j***@example.com: 042042"]);
  // Anything that is not a six-digit code (a token, a link) is never written.
  for (const notACode of ["https://app.example.com/verify#token=abc", "a".repeat(43), "12345"]) {
    assert.equal(logDevelopmentLoginCode("jane@example.com", notACode, DEV as NodeJS.ProcessEnv, write), false);
  }
  assert.equal(lines.length, 1);
});

test("the device-trust generation leaves existing fingerprints unchanged until it is raised", () => {
  const hash = "$2a$10$abcdefghijklmnopqrstuuJ1xYz0123456789ABCDEFGHIJKLMNOPQ";
  const base = platformCredentialFingerprint(hash);
  assert.match(base, /^[A-Za-z0-9_-]{43}$/);
  for (const absent of [undefined, null, 0, -1, 1.5, Number.NaN]) {
    assert.equal(platformCredentialFingerprint(hash, absent as number | null | undefined), base, `generation ${String(absent)} = the old fingerprint`);
  }
  const first = platformCredentialFingerprint(hash, 1);
  const second = platformCredentialFingerprint(hash, 2);
  assert.notEqual(first, base, "raising the generation outdates the fingerprint");
  assert.notEqual(second, first);
  assert.equal(platformCredentialFingerprint(hash, 1), first, "deterministic");
  assert.notEqual(platformCredentialFingerprint(`${hash}x`), base, "still changes with the password");
});

test("masking keeps only the first character and the domain", () => {
  assert.equal(maskEmail("jane.doe@example.com"), "j***@example.com");
  assert.equal(maskEmail("no-at-sign"), "***");
  assert.equal(maskEmail("@example.com"), "***");
});

test("the code email names the app, shows the code and its expiry, and warns", () => {
  const email = renderLoginCodeEmail({ name: "Jane <b>", code: "042042", expiresInMinutes: 5 });
  assert.equal(email.subject, "Your SiteForge sign-in code");
  for (const part of [email.text, email.html]) {
    assert.ok(part.includes("042042"));
    assert.ok(part.includes("SiteForge"));
    assert.ok(part.includes("expires in 5 minutes"));
    assert.match(part, /If you did not just try to log in/);
  }
  assert.match(email.text, /^ {4}042042$/m);
  assert.ok(!email.html.includes("<b>"), "the name is escaped");
  assert.ok(!/https?:\/\//.test(email.text), "no link: nothing to click");
  assert.throws(() => renderLoginCodeEmail({ code: "12345", expiresInMinutes: 5 }));
});

test("no client component imports the sign-in code modules", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && !name.startsWith(".")) walk(path);
      } else if (/\.(ts|tsx)$/.test(name)) {
        const source = readFileSync(path, "utf8");
        if (/^\s*["']use client["']/m.test(source) && /auth\/(login-challenge|dev-login-code|login-code-limits)["']/.test(source)) offenders.push(path);
      }
    }
  };
  for (const root of ["app", "frontend", "backend"]) walk(root);
  assert.deepEqual(offenders, []);
});
