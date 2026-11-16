import { env, type Env } from "./env";

/**
 * Server-only email infrastructure.
 *
 * Provider-independent at the application layer: callers use `sendEmail()`, and
 * the concrete transport (Resend HTTP API, console, or an in-memory outbox for
 * tests) is selected from configuration. There is no provider SDK: Resend is
 * called through native `fetch`.
 *
 * Safety rules enforced here:
 * - No email is sent and no environment value is read while this module is
 *   imported; everything happens inside a function call.
 * - The memory transport is refused in production.
 * - The console transport is refused in production (it must never masquerade as
 *   real delivery), and it never logs message bodies, links or tokens.
 * - Production fails its startup check without a real provider (`assertEmailStartupConfig`,
 *   called from `instrumentation.ts`; requests then answer 500, while the process may keep
 *   running, so deployments need a health check). Should a process skip that hook anyway,
 *   `sendEmail` still fails clearly instead of pretending to succeed.
 * - A failed provider request throws (and is therefore distinguishable from a
 *   successful `{ id }` result). There are no automatic retries, which could
 *   produce duplicate sends.
 * - Errors never include the API key, request body, raw tokens or full links.
 *
 * This module reads server-only secrets and must never be imported into a
 * client component.
 */

export type EmailProviderName = "resend" | "console" | "memory";
export type EmailTransportName = EmailProviderName | "unconfigured" | "disabled";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDelivery {
  provider: EmailProviderName;
  /** Provider message id where available; `null` for transports without one. */
  id: string | null;
}

export interface EmailTransport {
  readonly provider: EmailTransportName;
  send(message: EmailMessage): Promise<EmailDelivery>;
}

/** The subset of configuration the email layer needs. */
export type EmailEnv = Pick<
  Env,
  | "NODE_ENV"
  | "EMAIL_PROVIDER"
  | "EMAIL_API_KEY"
  | "EMAIL_FROM"
  | "EMAIL_REPLY_TO"
  | "APP_URL"
>;

export type ResolvedEmailConfig =
  | { kind: "unconfigured" }
  | { kind: "disabled" }
  | { kind: "console" }
  | { kind: "memory" }
  | {
      kind: "resend";
      apiKey: string;
      from: string;
      replyTo?: string;
      appUrl: string;
      timeoutMs: number;
    };

export const DEFAULT_EMAIL_TIMEOUT_MS = 10_000;
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Configuration is missing or unsafe for the current environment. */
export class EmailConfigurationError extends Error {
  readonly code = "email_misconfigured";
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

/**
 * Email is deliberately switched off (`EMAIL_PROVIDER=disabled`). A configuration error like any
 * other, so every caller's existing "email could not be sent" handling applies; callers that can
 * tell the person something better check `isEmailDisabled()` first.
 */
export class EmailDisabledError extends EmailConfigurationError {
  constructor() {
    super("Email is turned off on this platform (EMAIL_PROVIDER=disabled)");
    this.name = "EmailDisabledError";
  }
}

/** A configured provider rejected or could not complete the request. */
export class EmailSendError extends Error {
  readonly code = "email_send_failed";
  constructor(
    message: string,
    readonly provider: EmailProviderName,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (pure; no environment access)
// ---------------------------------------------------------------------------

function isProductionEnv(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

/** Accepts a bare address or a `Display Name <address>` form. */
function extractAddress(value: string): string {
  const match = value.match(/<([^>]+)>\s*$/);
  return (match ? match[1] : value).trim();
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extractAddress(value));
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.host);
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Links are built as `${APP_URL}/reset-password#token=…`, so APP_URL must be a bare base address:
 * a query or fragment would swallow the token, and credentials in it would be mailed to everyone.
 */
function isBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Control characters (including CR/LF) never belong in a configured value. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Structural check only: Resend API keys start with `re_`. A value with spaces, quotes or another
 * prefix is a copy-paste mistake (for example a key pasted with its surrounding quotes). Passing
 * this check says nothing about whether the key is active or the sender domain is verified.
 */
function isPlausibleResendKey(value: string): boolean {
  return value.startsWith("re_") && value.length >= 10 && !/[\s"'`]/.test(value) && !hasControlCharacter(value);
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/**
 * Validates the email configuration and returns the transport to use. Pure with
 * respect to the environment (it takes the parsed values), so it is safe to
 * unit-test and to reuse for startup validation.
 *
 * Provider rules:
 * - empty provider: console outside production, `unconfigured` in production
 *   (fail-closed) so an unconfigured deploy never pretends to deliver; the
 *   production startup check fails in that state (`assertEmailStartupConfig`);
 * - `console`: development only;
 * - `memory`: development/test only;
 * - `disabled`: an explicit, owner-chosen "no email" mode, allowed everywhere. Nothing is sent and
 *   every send throws `EmailDisabledError`; flows that need email say so (docs/email-delivery.md);
 * - `resend`: requires a Resend-shaped EMAIL_API_KEY and a valid EMAIL_FROM; APP_URL,
 *   when set, must be a bare absolute base address, and in production it is
 *   required and must be HTTPS.
 */
export function resolveEmailConfig(config: EmailEnv): ResolvedEmailConfig {
  const production = isProductionEnv(config.NODE_ENV);
  const provider = config.EMAIL_PROVIDER.trim().toLowerCase();

  if (!provider) {
    return production ? { kind: "unconfigured" } : { kind: "console" };
  }

  if (provider === "disabled") return { kind: "disabled" };

  if (provider === "console") {
    if (production) {
      throw new EmailConfigurationError(
        "EMAIL_PROVIDER 'console' is not allowed in production: configure the 'resend' provider",
      );
    }
    return { kind: "console" };
  }

  if (provider === "memory") {
    if (production) {
      throw new EmailConfigurationError(
        "EMAIL_PROVIDER 'memory' is not allowed in production",
      );
    }
    return { kind: "memory" };
  }

  if (provider !== "resend") {
    throw new EmailConfigurationError(
      "EMAIL_PROVIDER must be one of 'resend', 'disabled', 'console' or 'memory'",
    );
  }

  const apiKey = config.EMAIL_API_KEY.trim();
  if (!apiKey) {
    throw new EmailConfigurationError(
      "EMAIL_API_KEY is required for the 'resend' provider",
    );
  }
  if (!isPlausibleResendKey(apiKey)) {
    throw new EmailConfigurationError(
      "EMAIL_API_KEY does not look like a Resend API key: it must start with 're_' and contain no spaces or quotes",
    );
  }

  const from = config.EMAIL_FROM.trim();
  if (!from || hasControlCharacter(from) || !isPlausibleEmail(from)) {
    throw new EmailConfigurationError(
      "EMAIL_FROM must be a valid sender address (e.g. 'SiteForge <no-reply@your-domain>')",
    );
  }

  const replyTo = config.EMAIL_REPLY_TO.trim();
  if (replyTo && (hasControlCharacter(replyTo) || !isPlausibleEmail(replyTo))) {
    throw new EmailConfigurationError(
      "EMAIL_REPLY_TO must be a valid email address when set",
    );
  }

  const appUrl = config.APP_URL.trim();
  if (!appUrl) {
    if (production) {
      throw new EmailConfigurationError("APP_URL is required in production");
    }
  } else if (!isAbsoluteUrl(appUrl)) {
    throw new EmailConfigurationError("APP_URL must be an absolute URL");
  } else if (production && !isHttpsUrl(appUrl)) {
    throw new EmailConfigurationError(
      "APP_URL must be an absolute HTTPS URL in production",
    );
  } else if (!isBaseUrl(appUrl)) {
    throw new EmailConfigurationError(
      "APP_URL must be the application's base address, without credentials, a query or a fragment",
    );
  }

  return {
    kind: "resend",
    apiKey,
    from,
    replyTo: replyTo || undefined,
    appUrl,
    timeoutMs: DEFAULT_EMAIL_TIMEOUT_MS,
  };
}

/**
 * Startup validation entry point (called from `instrumentation.ts`).
 *
 * - Any environment: an explicitly configured provider must be valid for it.
 * - Production: email must be configured on purpose: a real provider (`resend`), or the explicit
 *   `disabled` mode (no email: password reset, invitations and order emails are off and say so). An
 *   empty provider fails, so a forgotten setting is a deploy-time failure rather than a silent gap:
 *   Next.js then answers 500 to requests, though the process may keep running, so the hosting
 *   platform's health check of `/login` is what keeps traffic away (docs/email-delivery.md). Never
 *   exit here.
 *
 * The check is local and structural (names, formats, required values). It never contacts the
 * provider, so passing it does not prove that the key is active, the sender domain is verified or
 * mail will arrive. Messages name variables only, never their values.
 */
export function assertEmailStartupConfig(config: EmailEnv = env()): void {
  const resolved = resolveEmailConfig(config);
  if (resolved.kind === "disabled") {
    console.warn("[email] Email is turned off (EMAIL_PROVIDER=disabled): password reset, team invitations and order emails are unavailable.");
    return;
  }
  if (!isProductionEnv(config.NODE_ENV) || resolved.kind === "resend") return;

  // In production `console` and `memory` already threw above, so only an empty provider is left.
  const missing = [
    "EMAIL_PROVIDER",
    ...(config.EMAIL_API_KEY.trim() ? [] : ["EMAIL_API_KEY"]),
    ...(config.EMAIL_FROM.trim() ? [] : ["EMAIL_FROM"]),
    ...(config.APP_URL.trim() ? [] : ["APP_URL"]),
  ];
  throw new EmailConfigurationError(
    `Email must be configured in production: set EMAIL_PROVIDER=resend with EMAIL_API_KEY, EMAIL_FROM and an HTTPS APP_URL, ` +
      `or EMAIL_PROVIDER=disabled to run without email ` +
      `(missing: ${missing.join(", ")}). Without it no password-reset code (or any other email) can be sent.`,
  );
}

// ---------------------------------------------------------------------------
// In-memory outbox (memory transport; tests only)
// ---------------------------------------------------------------------------

export interface OutboxMessage extends EmailMessage {
  sentAt: string;
}

// Stored on globalThis so multiple module instances (e.g. under tsx) share one
// outbox, mirroring the shared-state approach used by the test header mock.
const emailGlobal = globalThis as unknown as {
  __siteforgeEmailOutbox?: OutboxMessage[];
  __siteforgeEmailFailure?: Error | null;
};

/**
 * Test-only fault injection for the MEMORY transport: while set, every send
 * throws this error. Inert in production, where the memory transport itself
 * is refused.
 */
export function setMemoryEmailFailure(error: Error | null): void {
  emailGlobal.__siteforgeEmailFailure = error;
}

function outbox(): OutboxMessage[] {
  if (!emailGlobal.__siteforgeEmailOutbox) {
    emailGlobal.__siteforgeEmailOutbox = [];
  }
  return emailGlobal.__siteforgeEmailOutbox;
}

export function getEmailOutbox(): readonly OutboxMessage[] {
  return outbox();
}

export function clearEmailOutbox(): void {
  emailGlobal.__siteforgeEmailOutbox = [];
}

// ---------------------------------------------------------------------------
// Console transport logging (redacted)
// ---------------------------------------------------------------------------

function maskAddress(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

function redactLinks(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"')]+/g, "[link redacted]");
}

function logConsoleEmail(message: EmailMessage): void {
  // Local-development only. The body is intentionally omitted so action links,
  // tokens and email contents can never reach a log, and the recipient is masked.
  console.info(
    `[email:console] to=${maskAddress(message.to)} subject=${JSON.stringify(
      redactLinks(message.subject),
    )} (body omitted; set EMAIL_PROVIDER=resend to deliver real mail)`,
  );
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export interface EmailTransportDeps {
  /** Override the global fetch (used by tests with mocked responses). */
  fetchImpl?: typeof fetch;
  /** Override the request timeout in milliseconds. */
  timeoutMs?: number;
  /** Defence-in-depth: refuses console/memory transports when true. */
  production?: boolean;
}

function createUnconfiguredTransport(): EmailTransport {
  return {
    provider: "unconfigured",
    async send() {
      throw new EmailConfigurationError(
        "Email is not configured: set EMAIL_PROVIDER and its credentials before sending",
      );
    },
  };
}

function createDisabledTransport(): EmailTransport {
  return {
    provider: "disabled",
    async send() {
      throw new EmailDisabledError();
    },
  };
}

function createConsoleTransport(deps: EmailTransportDeps): EmailTransport {
  return {
    provider: "console",
    async send(message) {
      if (deps.production) {
        throw new EmailConfigurationError(
          "The console email transport cannot be used in production",
        );
      }
      logConsoleEmail(message);
      return { provider: "console", id: null };
    },
  };
}

function createMemoryTransport(deps: EmailTransportDeps): EmailTransport {
  return {
    provider: "memory",
    async send(message) {
      if (deps.production) {
        throw new EmailConfigurationError(
          "The memory email transport cannot be used in production",
        );
      }
      if (emailGlobal.__siteforgeEmailFailure) throw emailGlobal.__siteforgeEmailFailure;
      outbox().push({ ...message, sentAt: new Date().toISOString() });
      return { provider: "memory", id: null };
    },
  };
}

type ResendConfig = Extract<ResolvedEmailConfig, { kind: "resend" }>;

async function sendWithResend(
  config: ResendConfig,
  message: EmailMessage,
  deps: EmailTransportDeps,
): Promise<EmailDelivery> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? config.timeoutMs;

  const payload: Record<string, unknown> = {
    from: config.from,
    to: [message.to],
    subject: message.subject,
    text: message.text,
    html: message.html,
  };
  if (config.replyTo) {
    payload.reply_to = config.replyTo;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new EmailSendError(
        `Resend rejected the request with HTTP status ${response.status}`,
        "resend",
        response.status,
      );
    }

    let id: string | null = null;
    try {
      const data = (await response.json()) as { id?: unknown };
      if (typeof data.id === "string") id = data.id;
    } catch {
      id = null;
    }
    return { provider: "resend", id };
  } catch (error) {
    if (error instanceof EmailSendError) throw error;
    if (error instanceof EmailConfigurationError) throw error;
    // Network failure, DNS error or timeout/abort. Never surface the raw error
    // (it can echo request details) and never retry automatically.
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new EmailSendError(
      aborted
        ? "Resend request timed out"
        : "Resend request failed before receiving a response",
      "resend",
    );
  } finally {
    clearTimeout(timer);
  }
}

function createResendTransport(
  config: ResendConfig,
  deps: EmailTransportDeps,
): EmailTransport {
  return {
    provider: "resend",
    send: (message) => sendWithResend(config, message, deps),
  };
}

/** Builds a transport from an already-resolved configuration. */
export function createTransport(
  config: ResolvedEmailConfig,
  deps: EmailTransportDeps = {},
): EmailTransport {
  switch (config.kind) {
    case "unconfigured":
      return createUnconfiguredTransport();
    case "disabled":
      return createDisabledTransport();
    case "console":
      return createConsoleTransport(deps);
    case "memory":
      return createMemoryTransport(deps);
    case "resend":
      return createResendTransport(config, deps);
  }
}

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

/**
 * Sends one email using the configured transport. Resolves with the delivery
 * result on success and throws (`EmailConfigurationError` /
 * `EmailSendError`) otherwise, so a failure is never reported as success.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailDelivery> {
  const config = env();
  const resolved = resolveEmailConfig(config);
  const transport = createTransport(resolved, {
    production: isProductionEnv(config.NODE_ENV),
  });
  return transport.send(message);
}

/**
 * Whether email is deliberately switched off (`EMAIL_PROVIDER=disabled`). Flows that need email check
 * this first to tell the person plainly, instead of failing after the fact.
 */
export function isEmailDisabled(config: Pick<EmailEnv, "EMAIL_PROVIDER"> = env()): boolean {
  return config.EMAIL_PROVIDER.trim().toLowerCase() === "disabled";
}
