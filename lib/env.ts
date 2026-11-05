import { z } from "zod";

// "true"/"1" enable; anything else (including unset) is false.
const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

/** Default per-instance MongoDB connection pool size (see lib/db.ts). */
export const DEFAULT_MONGODB_MAX_POOL_SIZE = 10;

const schema = z.object({
  MONGODB_URI: z.string({ error: "Required" }).min(1, "MONGODB_URI is required"),
  // Optional per-instance pool cap. Serverless platforms run many instances,
  // each with its own pool, against a shared connection limit (Atlas M0: 500).
  MONGODB_MAX_POOL_SIZE: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    z.coerce
      .number()
      .int("MONGODB_MAX_POOL_SIZE must be a whole number")
      .min(1, "MONGODB_MAX_POOL_SIZE must be between 1 and 50")
      .max(50, "MONGODB_MAX_POOL_SIZE must be between 1 and 50")
      .optional(),
    )
    .transform((value) => value ?? DEFAULT_MONGODB_MAX_POOL_SIZE),
  SESSION_SECRET: z
    .string({ error: "Required" })
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  NEXT_PUBLIC_ROOT_DOMAIN: z.string().prefault("localhost:3000"),
  ROOT_DOMAINS: z.string().prefault("localhost:3000"),
  PAYMENT_PROVIDER: z.string().prefault("manual"),
  PAYMENT_WEBHOOK_SECRET: z.string().optional().prefault(""),
  // Explicit, default-off escape hatch. Manual activation of paid plans is
  // refused in production unless this is set to "true".
  ALLOW_MANUAL_BILLING: booleanFromEnv,
  // --- Email (see lib/email.ts) ---
  // Transport: "resend" | "console" | "memory". Left empty, development uses
  // the console transport and production stays fail-closed (no delivery).
  // "memory" is refused in production. Validation of provider-specific
  // requirements lives in lib/email.ts (resolveEmailConfig / startup check).
  EMAIL_PROVIDER: z.string().trim().toLowerCase().prefault(""),
  EMAIL_API_KEY: z.string().trim().prefault(""),
  EMAIL_FROM: z.string().trim().prefault(""),
  EMAIL_REPLY_TO: z.string().trim().prefault(""),
  // Absolute base URL used to build links inside emails (e.g. password reset).
  // Required (and must be https) for the resend provider in production.
  APP_URL: z.string().trim().prefault(""),
  // Name of the request header your reverse proxy sets to the real client IP
  // (e.g. "x-real-ip"). Leave empty to disable header-based IP extraction: the
  // app will NOT trust client-supplied forwarding headers unless configured.
  TRUSTED_IP_HEADER: z.string().trim().toLowerCase().prefault(""),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .prefault("development"),
});

export type Env = z.infer<typeof schema>;

/** The raw schema, exported for pure unit tests (prefer `env()` in app code). */
export const envSchema = schema;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration -> ${details}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Environment-specific rules that must hold before the server serves traffic
 * but that cannot live in the base `schema` without failing tests (and local
 * development) that deliberately run non-production configuration.
 *
 * Pure by design: it takes the already-parsed values and never reads
 * `process.env`, so it is safe to unit-test without mutating or caching the
 * environment. Error messages name variables only and never include values.
 */
export function assertRuntimeConfig(
  config: Pick<Env, "NODE_ENV" | "TRUSTED_IP_HEADER">,
): void {
  const issues: string[] = [];
  if (config.NODE_ENV === "production" && !config.TRUSTED_IP_HEADER) {
    issues.push(
      "TRUSTED_IP_HEADER is required in production: set it to the request header your reverse proxy overwrites",
    );
  }
  if (issues.length > 0) {
    throw new Error(`Invalid environment configuration -> ${issues.join("; ")}`);
  }
}

/**
 * Fail-fast startup validation. Called once when the server boots (see
 * `instrumentation.ts`) so missing or invalid required configuration surfaces
 * immediately instead of on the first request. Delegates the base shape check
 * (MONGODB_URI, SESSION_SECRET, ...) to `env()` and then applies the
 * environment-specific rules above.
 */
export function assertStartupEnv(): void {
  assertRuntimeConfig(env());
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Storefront customer accounts feature gate (default OFF). Only the exact
 * value "true" enables registration, login, verification and recovery;
 * missing, empty or any other value keeps every customer-account route a 404.
 * Read on every call (not cached) so an operator can switch it off without a
 * code change. Never enable it before the database indexes in
 * docs/customer-accounts.md exist.
 */
export function isCustomerAccountsEnabled(): boolean {
  return process.env.CUSTOMER_ACCOUNTS_ENABLED?.trim() === "true";
}

/**
 * Online payment for storefront orders (Razorpay Payment Links, each business's
 * own account). Default OFF: only the exact value "true" lets checkout offer
 * "Pay online", and only for businesses with an active connected account.
 * Read on every call. See docs/payments-architecture.md.
 */
export function isOrderOnlinePaymentsEnabled(): boolean {
  return process.env.ORDER_ONLINE_PAYMENTS_ENABLED?.trim() === "true";
}

/**
 * Live-mode (real money) Razorpay accounts are refused unless this is exactly
 * "true". Test-mode accounts work without it. Default OFF.
 */
export function isOrderPaymentsLiveAllowed(): boolean {
  return process.env.ORDER_PAYMENTS_LIVE_ALLOWED?.trim() === "true";
}

/**
 * Kill switch for the external AI planning provider (Gemini). Default OFF:
 * only the exact value "true" allows calls. A configured API key alone never
 * enables the provider, so business data cannot be sent to an AI provider
 * until an explicit provider and data-sharing decision has been made.
 * See docs/ai-website-builder-plan.md.
 */
export function isAiProviderEnabled(): boolean {
  // Exactly "true": no trimming, so " true" or a trailing newline never enable it.
  return process.env.AI_PROVIDER_ENABLED === "true";
}

/** Default Gemini model (approved provider: Google Gemini). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_MODEL_PATTERN = /^gemini-[a-z0-9][a-z0-9.-]{0,62}$/;

/**
 * The Gemini model to call (`GEMINI_MODEL`, optional). Only Gemini model ids
 * are accepted (`gemini-…`, lowercase letters, digits, dots and dashes): the
 * name becomes part of the request URL, so anything else is a configuration
 * error and AI stays unavailable (null) rather than calling something else.
 */
export function geminiModel(): string | null {
  const raw = process.env.GEMINI_MODEL;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GEMINI_MODEL;
  const model = raw.trim();
  return GEMINI_MODEL_PATTERN.test(model) ? model : null;
}

/**
 * More Gemini models a task may be routed to (`GEMINI_MODELS`, optional, comma-separated). Values
 * that are not valid Gemini model ids are left out. Listing a model does not select it.
 */
export function geminiExtraModels(): string[] {
  const values = (process.env.GEMINI_MODELS ?? "").split(",").map((value) => value.trim());
  return [...new Set(values.filter((value) => GEMINI_MODEL_PATTERN.test(value)))];
}

/** Upper bound for one AI provider call in ms (`AI_PROVIDER_TIMEOUT_MS`, 1-120000; default 30000). */
export function aiProviderTimeoutMs(): number {
  const value = Number(process.env.AI_PROVIDER_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1 && value <= 120_000 ? value : 30_000;
}
