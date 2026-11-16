import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// End to end for the real startup hook: `register()` from instrumentation.ts runs in a child
// process with an explicit, minimal environment (env() caches its first parse, so each case needs
// its own process). The child never inherits this machine's environment, so no .env value or real
// credential can reach it, and its global fetch is replaced to prove startup sends no request.

const ROOT = path.resolve(__dirname, "..", "..");
const INSTRUMENTATION = pathToFileURL(path.join(ROOT, "instrumentation.ts")).href;
const KEY = "re_dummy_startup_key_never_logged";

const CHILD = `
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error("no network at startup"); };
let outcome;
try {
  const { register } = await import(${JSON.stringify(INSTRUMENTATION)});
  await register();
  outcome = { ok: true };
} catch (error) {
  outcome = { ok: false, message: String(error && error.message) };
}
process.stdout.write("\\n@@RESULT@@" + JSON.stringify({ ...outcome, fetchCalls }) + "\\n");
`;

interface StartupResult {
  ok: boolean;
  message?: string;
  fetchCalls: number;
}

function boot(values: Record<string, string>): StartupResult {
  const base: Record<string, string> = {
    NEXT_RUNTIME: "nodejs",
    MONGODB_URI: "mongodb://127.0.0.1:1/never-connected",
    SESSION_SECRET: "s".repeat(40),
    TRUSTED_IP_HEADER: "x-real-ip",
  };
  // Only what a Node child needs to run on this OS; nothing else is inherited.
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
    cwd: ROOT,
    env: { ...base, ...values } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  const line = (child.stdout ?? "").split("\n").find((entry) => entry.startsWith("@@RESULT@@"));
  if (!line) throw new Error(`startup child produced no result (exit ${child.status}): ${(child.stderr ?? "").slice(0, 400)}`);
  return JSON.parse(line.slice("@@RESULT@@".length)) as StartupResult;
}

const resendProduction = {
  NODE_ENV: "production",
  EMAIL_PROVIDER: "resend",
  EMAIL_API_KEY: KEY,
  EMAIL_FROM: "SiteForge <no-reply@example.com>",
  APP_URL: "https://app.example.com",
};

test("a production server does not start without an email provider", () => {
  const result = boot({ NODE_ENV: "production" });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Email delivery is required in production/);
  assert.match(result.message ?? "", /missing: EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM, APP_URL/);
  assert.equal(result.fetchCalls, 0);
});

test("a production server does not start with the console or memory transport", () => {
  for (const provider of ["console", "memory"]) {
    const result = boot({ ...resendProduction, EMAIL_PROVIDER: provider });
    assert.equal(result.ok, false, provider);
    assert.match(result.message ?? "", new RegExp(`'${provider}' is not allowed in production`));
  }
});

test("a production server does not start with a malformed key, and never prints it", () => {
  const result = boot({ ...resendProduction, EMAIL_API_KEY: `"${KEY}"` });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /EMAIL_API_KEY does not look like a Resend API key/);
  assert.ok(!(result.message ?? "").includes(KEY));
});

test("a production server starts with valid Resend settings and makes no provider request", () => {
  const result = boot(resendProduction);
  assert.deepEqual(result, { ok: true, fetchCalls: 0 });
});

test("development and test servers still start with their local transports", () => {
  assert.equal(boot({ NODE_ENV: "development" }).ok, true);
  assert.equal(boot({ NODE_ENV: "development", EMAIL_PROVIDER: "console" }).ok, true);
  assert.equal(boot({ NODE_ENV: "test", EMAIL_PROVIDER: "memory" }).ok, true);
});
