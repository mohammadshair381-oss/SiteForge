import mongoose from "mongoose";
import { ZodError } from "zod";
import { HttpError, handle } from "../api";
import { runAfterResponse } from "../after-response";
import { dbConnect } from "../db";
import { EmailConfigurationError, EmailSendError, sendEmail } from "../email";
import {
  renderCustomerAccountExistsEmail,
  renderCustomerPasswordResetEmail,
  renderCustomerVerificationEmail,
} from "../email-templates";
import { isCustomerAccountsEnabled, isProduction } from "../env";
import {
  consumeRateLimit,
  enforceRateLimit,
  getClientIp,
  rateLimitedError,
  releaseRateLimit,
} from "../rate-limit";
import { rateLimitSourceKey } from "../client-address";
import { isTransactionsUnavailableError } from "../db-errors";
import { storefrontOrigin } from "../seo";
import { resolveCommerceBusiness } from "../tenant";
import { hashPassword, verifyPassword } from "./password";
import { customerCredentialFingerprint } from "./customer-device";
import {
  CUSTOMER_RESET_TTL_MS,
  CUSTOMER_VERIFICATION_TTL_MS,
  consumeCustomerToken,
  findUsableCustomerToken,
  issueCustomerToken,
} from "./customer-tokens";
import { Customer } from "@/models/Customer";
import { CustomerActionToken } from "@/models/CustomerActionToken";
import type { BusinessDoc } from "@/models/Business";

/**
 * Storefront customer registration, login, verification and recovery
 * (server-only). See docs/customer-accounts.md.
 *
 * Invariants:
 * - Everything is behind the CUSTOMER_ACCOUNTS_ENABLED gate (default off).
 * - The business comes ONLY from the storefront Host, through the same gate as
 *   commerce (`resolveCommerceBusiness`: published + active subscription,
 *   custom domain verified/fresh). Unknown/ineligible stores get 404.
 * - Public responses never reveal whether an email has an account. Work that
 *   differs by account existence (lookups, token issuance, email delivery)
 *   runs AFTER the response (`lib/after-response.ts`).
 * - Raw tokens, passwords, email contents and full links are never logged.
 * - Customer accounts never touch platform users, roles or memberships.
 */

/**
 * Same text whether or not the email has an account. It promises nothing about
 * delivery: email work runs after the response and can be capped, fail or be
 * lost (see docs/customer-accounts.md), so the wording says "will send".
 */
export const CUSTOMER_AUTH_GENERIC_MESSAGE =
  "If an account can be created or recovered with this email, we will send instructions to it. If nothing arrives within a few minutes, check your spam folder or try again.";
export const CUSTOMER_LOGIN_FAILED_MESSAGE = "Invalid email or password";
/** Every customer-auth response is private and must not be cached. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

function storeUnavailable(): HttpError {
  return new HttpError(404, "This store is not available", "not_found");
}

// ---------------------------------------------------------------------------
// Operational logging (safe fields only: event, operation, category)
// ---------------------------------------------------------------------------

/** Coarse, non-identifying category for an error (never its message). */
export function customerAuthErrorCategory(error: unknown): string {
  if (error instanceof EmailConfigurationError) return "email_configuration";
  if (error instanceof EmailSendError) {
    if (error.status === undefined) return "email_provider_unreachable";
    return error.status >= 500 || error.status === 429
      ? "email_provider_unavailable"
      : "email_provider_rejected";
  }
  if (error instanceof HttpError) return `http_${error.status}`;
  const name = error instanceof Error ? error.name : "";
  if (/^(Mongo|Mongoose|Validation|Cast|DocumentNotFound|Version)/.test(name)) return "database";
  return "unknown";
}

/**
 * One grep-able line per event, e.g.
 * `[customer-auth] event=email_delivery_failed operation=password-reset category=email_configuration`.
 * Operators should alert on `event=email_delivery_failed` and
 * `event=background_task_failed`.
 */
function logCustomerAuthEvent(
  level: "error" | "warn",
  event: string,
  fields: Record<string, string>,
): void {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console[level](`[customer-auth] event=${event} ${detail}`);
}

/** Runs account-dependent work after the response; failures are logged, never dropped silently. */
function scheduleCustomerAuthTask(operation: string, task: () => Promise<void>): void {
  runAfterResponse(task, {
    operation,
    onError: (error) =>
      logCustomerAuthEvent("error", "background_task_failed", {
        operation,
        category: customerAuthErrorCategory(error),
      }),
  });
}

// ---------------------------------------------------------------------------
// Request guards
// ---------------------------------------------------------------------------

/** Feature gate: a disabled feature looks exactly like an unavailable store. */
export function assertCustomerAccountsEnabled(): void {
  if (!isCustomerAccountsEnabled()) throw storeUnavailable();
}

/**
 * Wraps every customer-account route: enforces the feature gate FIRST (before
 * any parsing, rate limiting or database access), marks every response
 * (including errors) `no-store`, and replaces unexpected errors with a generic
 * 500 whose log line carries only a category (database errors can contain
 * customer emails).
 */
export async function handleCustomerAuthRoute(fn: () => Promise<Response>): Promise<Response> {
  const response = await handle(async () => {
    assertCustomerAccountsEnabled();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HttpError || error instanceof ZodError || isTransactionsUnavailableError(error)) throw error;
      logCustomerAuthEvent("error", "request_failed", { category: customerAuthErrorCategory(error) });
      throw new HttpError(500, "Internal server error", "internal_error");
    }
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** The storefront business for this request, or 404 (never a client id). */
export async function requireCustomerAuthBusiness(request: Request): Promise<BusinessDoc> {
  assertCustomerAccountsEnabled();
  await dbConnect();
  const business = await resolveCommerceBusiness(request.headers.get("host"));
  if (!business) throw storeUnavailable();
  return business;
}

/**
 * Cross-site protection for cookie-setting/state-changing customer endpoints:
 * JSON bodies only (a cross-site HTML form cannot send `application/json`
 * without a CORS preflight, which these routes never grant), and when the
 * browser sends an Origin it must be this storefront host.
 */
export function assertSameOriginJsonRequest(request: Request): void {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Expected a JSON request", "unsupported_media_type");
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = (request.headers.get("host") || "").toLowerCase();
  const allowed = isProduction() ? [`https://${host}`] : [`https://${host}`, `http://${host}`];
  if (!host || !allowed.includes(origin.toLowerCase())) {
    throw new HttpError(403, "Request origin verification failed", "csrf_failed");
  }
}

// ---------------------------------------------------------------------------
// Rate limits (keys are HMAC-hashed by lib/rate-limit; raw IPs/emails never stored)
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;

/**
 * Design (docs/customer-accounts.md, "Rate limits"):
 * - per IP (per store): every request, unchanged from Phase 2;
 * - per (email, IP): one source cannot spend a victim's budget for everyone;
 * - "IP" means the rate-limit SOURCE (`customerRateLimitSource`): one IPv4
 *   address, or one IPv6 /64, from the trusted proxy header only;
 * - login: only FAILED attempts count against the (email, IP) and the
 *   account-wide budget (reserved before the password check, released on a
 *   correct password); the account-wide cap bounds distributed guessing;
 * - login from a KNOWN DEVICE of this account (lib/auth/customer-device.ts)
 *   uses its own per-device failure budget instead of the (email, IP) and
 *   account-wide budgets, so an account-wide lock does not lock out the
 *   owner's known browsers;
 * - emails to one address are capped in the background: excess requests still
 *   get the generic 202 but send nothing (bounds email bombing without
 *   letting an attacker make the victim's own request fail).
 */
export const CUSTOMER_RATE_LIMITS = {
  register: {
    perIp: { limit: 10, windowMs: 15 * MINUTE },
    perEmailIp: { limit: 5, windowMs: 15 * MINUTE },
    emailsPerAddress: { limit: 5, windowMs: 60 * MINUTE },
  },
  login: {
    perIp: { limit: 20, windowMs: 15 * MINUTE },
    failuresPerEmailIp: { limit: 5, windowMs: 60 * MINUTE },
    failuresPerEmail: { limit: 50, windowMs: 60 * MINUTE },
    failuresPerDevice: { limit: 5, windowMs: 60 * MINUTE },
  },
  // Resend + forgot share the per-IP bucket; the other tiers are per kind.
  emailRequest: {
    perIp: { limit: 10, windowMs: 60 * MINUTE },
    perEmailIp: { limit: 3, windowMs: 60 * MINUTE },
    emailsPerAddress: { limit: 3, windowMs: 60 * MINUTE },
  },
  tokenSubmit: {
    perIp: { limit: 20, windowMs: 15 * MINUTE },
  },
  profileUpdate: {
    perIp: { limit: 30, windowMs: 15 * MINUTE },
  },
  passwordChange: {
    perIp: { limit: 10, windowMs: 15 * MINUTE },
    // Limits guessing the current password from a stolen session.
    perAccount: { limit: 5, windowMs: 60 * MINUTE },
  },
} as const;

type IpLimitedAction = keyof typeof CUSTOMER_RATE_LIMITS;
type EmailScope = "register" | "resend" | "forgot";

function emailPolicies(scope: EmailScope) {
  return scope === "register" ? CUSTOMER_RATE_LIMITS.register : CUSTOMER_RATE_LIMITS.emailRequest;
}

/**
 * The rate-limit source for this request: the trusted-proxy client address
 * (`getClientIp`, unchanged trust model) canonicalised by
 * `rateLimitSourceKey` (IPv4 address, IPv6 /64, or a shared bucket for
 * unknown/unparseable values).
 */
export function customerRateLimitSource(request: Request): string {
  return rateLimitSourceKey(getClientIp(request));
}

export async function enforceCustomerIpRateLimit(
  request: Request,
  businessId: string,
  action: IpLimitedAction,
): Promise<void> {
  const { perIp } = CUSTOMER_RATE_LIMITS[action];
  await enforceRateLimit({
    key: `customer-auth:${action}:ip:${businessId}:${customerRateLimitSource(request)}`,
    ...perIp,
  });
}

export async function enforceCustomerEmailIpRateLimit(
  request: Request,
  businessId: string,
  scope: EmailScope,
  email: string,
): Promise<void> {
  await enforceRateLimit({
    key: `customer-auth:${scope}:email-ip:${businessId}:${email}:${customerRateLimitSource(request)}`,
    ...emailPolicies(scope).perEmailIp,
  });
}

/** Background, silent cap on emails to one address for one store. */
async function allowEmailToAddress(businessId: string, scope: EmailScope, email: string): Promise<boolean> {
  const result = await consumeRateLimit({
    key: `customer-auth:${scope}:email-sends:${businessId}:${email}`,
    ...emailPolicies(scope).emailsPerAddress,
  });
  if (!result.allowed) {
    logCustomerAuthEvent("warn", "email_suppressed", { operation: scope, reason: "address_rate_limited" });
  }
  return result.allowed;
}

export interface LoginAttemptReservation {
  /** Call after a CORRECT password: the attempt then does not count as a failure. */
  release(): Promise<void>;
}

/**
 * Reserves one failed-login unit BEFORE the password check (atomic, so
 * concurrent guesses cannot overshoot); `release()` gives it back after a
 * correct password, so successful logins never count as failures.
 *
 * - Known device of THIS account (`deviceId` from a marker verified against
 *   the account's CURRENT password fingerprint): only that device's own
 *   failure bucket. It neither checks nor spends the (email, source) or
 *   account-wide budgets. The per-source limit (`enforceCustomerIpRateLimit`)
 *   still applies to every request, known device or not.
 * - Otherwise: the (email, source) bucket, then the account-wide bucket. A
 *   blocked source never consumes the account-wide budget.
 */
export async function reserveCustomerLoginAttempt(
  request: Request,
  businessId: string,
  email: string,
  deviceId?: string | null,
): Promise<LoginAttemptReservation> {
  const { failuresPerEmailIp, failuresPerEmail, failuresPerDevice } = CUSTOMER_RATE_LIMITS.login;
  if (deviceId) {
    const perDevice = await consumeRateLimit({
      key: `customer-auth:login:fail:device:${businessId}:${deviceId}`,
      ...failuresPerDevice,
    });
    if (!perDevice.allowed) throw rateLimitedError(perDevice.retryAfterMs);
    return {
      async release() {
        await releaseRateLimit(perDevice.bucketKey);
      },
    };
  }

  const source = customerRateLimitSource(request);
  const perSource = await consumeRateLimit({
    key: `customer-auth:login:fail:email-ip:${businessId}:${email}:${source}`,
    ...failuresPerEmailIp,
  });
  if (!perSource.allowed) throw rateLimitedError(perSource.retryAfterMs);
  const perAccount = await consumeRateLimit({
    key: `customer-auth:login:fail:email:${businessId}:${email}`,
    ...failuresPerEmail,
  });
  if (!perAccount.allowed) {
    await releaseRateLimit(perSource.bucketKey);
    throw rateLimitedError(perAccount.retryAfterMs);
  }
  return {
    async release() {
      await Promise.all([releaseRateLimit(perSource.bucketKey), releaseRateLimit(perAccount.bucketKey)]);
    },
  };
}

// ---------------------------------------------------------------------------
// Links and email
// ---------------------------------------------------------------------------

/**
 * Absolute storefront URL for an account page. Built from the business's
 * canonical storefront origin (tenant subdomain), never from the request Host,
 * so a forged Host header cannot redirect a token-bearing link elsewhere.
 */
export function customerAccountUrl(business: Pick<BusinessDoc, "subdomain">, path: string, token?: string): string {
  const base = `${storefrontOrigin(business.subdomain)}${path}`;
  // After `#`: browsers never send it to a server (lib/use-link-token.ts).
  return token ? `${base}#token=${encodeURIComponent(token)}` : base;
}

/**
 * Sends an email. A failure is logged with a category only (no recipient,
 * token, link or provider message) and never changes the public response.
 */
async function deliver(message: { to: string; subject: string; text: string; html: string }, operation: string) {
  try {
    await sendEmail(message);
    return true;
  } catch (error) {
    logCustomerAuthEvent("error", "email_delivery_failed", {
      operation,
      category: customerAuthErrorCategory(error),
    });
    return false;
  }
}

type AccountRecipient = { _id: mongoose.Types.ObjectId; email: string; name: string };

async function sendVerification(business: BusinessDoc, customer: AccountRecipient) {
  const issued = await issueCustomerToken({
    businessId: business._id,
    customerId: customer._id,
    type: "email_verification",
    ttlMs: CUSTOMER_VERIFICATION_TTL_MS,
  });
  if (!issued) return false;
  const email = renderCustomerVerificationEmail({
    storeName: business.name,
    name: customer.name,
    verifyUrl: customerAccountUrl(business, "/account/verify-email", issued.rawToken),
    expiresInHours: CUSTOMER_VERIFICATION_TTL_MS / (60 * MINUTE),
  });
  return deliver({ to: customer.email, ...email }, "verification");
}

async function sendAccountExists(
  business: BusinessDoc,
  customer: { email: string; name: string },
  pendingVerification: boolean,
) {
  const email = renderCustomerAccountExistsEmail({
    storeName: business.name,
    name: customer.name,
    loginUrl: customerAccountUrl(business, "/account/login"),
    forgotPasswordUrl: customerAccountUrl(business, "/account/forgot-password"),
    pendingVerification,
  });
  return deliver({ to: customer.email, ...email }, "account-exists");
}

async function sendPasswordReset(business: BusinessDoc, customer: AccountRecipient) {
  const issued = await issueCustomerToken({
    businessId: business._id,
    customerId: customer._id,
    type: "password_reset",
    ttlMs: CUSTOMER_RESET_TTL_MS,
  });
  if (!issued) return false;
  const email = renderCustomerPasswordResetEmail({
    storeName: business.name,
    name: customer.name,
    resetUrl: customerAccountUrl(business, "/account/reset-password", issued.rawToken),
    expiresInMinutes: CUSTOMER_RESET_TTL_MS / MINUTE,
  });
  return deliver({ to: customer.email, ...email }, "password-reset");
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

function isDuplicateKeyError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === 11000;
}

/**
 * Registration. The request path only hashes the password (same bcrypt cost
 * for every email); everything that depends on whether the email already has
 * an account runs after the response, and the caller always returns the same
 * 202 + CUSTOMER_AUTH_GENERIC_MESSAGE:
 * - new: create an UNVERIFIED account and email a verification link;
 * - existing (verified or not): change NOTHING (no new password, name or
 *   token) and email an "account already exists" notice; a customer who lost
 *   the password uses "forgot password", one who lost the link uses "resend";
 * - existing, inactive: nothing.
 *
 * Pre-hijacking defence: whoever registers first sets the pending password,
 * and verification also requires that CURRENT password (verifyCustomerEmail),
 * so a link clicked by the inbox owner never activates a password someone else
 * chose; the owner takes over with "forgot password", which proves inbox
 * control. Re-registration can no longer replace the password or invalidate
 * the pending link.
 *
 * A duplicate-key error (concurrent registration, when the unique index
 * exists) is treated as "existing". Without the unique index, concurrent
 * requests can still create duplicates; the index is a go-live prerequisite.
 */
export async function registerCustomer(
  business: BusinessDoc,
  input: { name: string; email: string; password: string },
): Promise<void> {
  const passwordHash = await hashPassword(input.password);
  scheduleCustomerAuthTask("register", () => completeRegistration(business, input, passwordHash));
}

async function completeRegistration(
  business: BusinessDoc,
  input: { name: string; email: string },
  passwordHash: string,
): Promise<void> {
  const businessId = String(business._id);
  let existing = await findAccount(business, input.email);
  if (!existing) {
    try {
      const created = await Customer.create({
        business: business._id,
        name: input.name,
        email: input.email,
        passwordHash,
        active: true,
        emailVerifiedAt: null,
      });
      if (await allowEmailToAddress(businessId, "register", input.email)) {
        await sendVerification(business, created);
      }
      return;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Lost a race with a concurrent registration: behave as "existing".
      existing = await findAccount(business, input.email);
      if (!existing) return;
    }
  }

  const customer = await Customer.findOne({ _id: existing._id, business: business._id })
    .select("name email active emailVerifiedAt")
    .lean();
  if (!customer || !customer.active) return;
  if (!(await allowEmailToAddress(businessId, "register", input.email))) return;
  await sendAccountExists(business, customer, !customer.emailVerifiedAt);
}

function findAccount(business: BusinessDoc, email: string) {
  return Customer.findOne({ business: business._id, email }).select("_id").lean();
}

let dummyHashPromise: Promise<string> | null = null;
/** A real bcrypt hash (same cost) to compare against when no account matches. */
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(`siteforge-dummy-${Math.random()}`);
  return dummyHashPromise;
}

export type CustomerLoginResult =
  | { ok: true; customer: { id: string; name: string; tokenVersion: number; credential: string } }
  | { ok: false; reason: "invalid" | "unverified" };

/**
 * Credential check. Unknown email, wrong password and inactive accounts are
 * all "invalid" (and take the same bcrypt time). "unverified" is returned only
 * after the correct password, and never yields a session. On success,
 * `credential` is the password fingerprint for a known-device marker (never
 * the hash itself).
 */
export async function authenticateCustomer(
  business: BusinessDoc,
  input: { email: string; password: string },
): Promise<CustomerLoginResult> {
  const customer = await Customer.findOne({ business: business._id, email: input.email })
    .select("+passwordHash name active tokenVersion emailVerifiedAt")
    .lean();
  const hash = customer?.passwordHash ?? (await dummyHash());
  const matches = await verifyPassword(input.password, hash);
  if (!customer || !customer.passwordHash || !matches || !customer.active) {
    return { ok: false, reason: "invalid" };
  }
  if (!customer.emailVerifiedAt) return { ok: false, reason: "unverified" };
  return {
    ok: true,
    customer: {
      id: String(customer._id),
      name: customer.name,
      tokenVersion: customer.tokenVersion ?? 0,
      credential: customerCredentialFingerprint(String(business._id), customer.passwordHash),
    },
  };
}

/**
 * The account's current password fingerprint, for checking a known-device
 * marker; null when there is no usable account (unknown, inactive or without a
 * password). Called only for a marker already bound to this (store, email), so
 * it is never reached by someone who does not already know the account.
 */
export async function currentCustomerCredential(business: BusinessDoc, email: string): Promise<string | null> {
  const customer = await Customer.findOne({ business: business._id, email })
    .select("+passwordHash active")
    .lean();
  if (!customer || !customer.active || !customer.passwordHash) return null;
  return customerCredentialFingerprint(String(business._id), customer.passwordHash);
}

/** Resend verification (after the response). Silent for unknown, verified or inactive accounts. */
export function resendCustomerVerification(business: BusinessDoc, email: string): void {
  scheduleCustomerAuthTask("resend", async () => {
    const customer = await Customer.findOne({ business: business._id, email })
      .select("name email active emailVerifiedAt")
      .lean();
    if (!customer || !customer.active || customer.emailVerifiedAt) return;
    if (!(await allowEmailToAddress(String(business._id), "resend", email))) return;
    await sendVerification(business, customer);
  });
}

/** Forgot password (after the response). Silent for unknown or inactive accounts. */
export function requestCustomerPasswordReset(business: BusinessDoc, email: string): void {
  scheduleCustomerAuthTask("forgot", async () => {
    const customer = await Customer.findOne({ business: business._id, email })
      .select("name email active")
      .lean();
    if (!customer || !customer.active) return;
    if (!(await allowEmailToAddress(String(business._id), "forgot", email))) return;
    await sendPasswordReset(business, customer);
  });
}

export type CustomerVerifyResult = "verified" | "invalid_token" | "invalid_password";

/**
 * Verifies an email with a single-use token of THIS business AND the
 * account's current password (pre-hijacking defence, see registerCustomer).
 * A wrong password does not spend the token. The token is consumed and the
 * account updated in one transaction, so concurrent attempts verify once.
 */
export async function verifyCustomerEmail(
  business: BusinessDoc,
  rawToken: string,
  password: string,
): Promise<CustomerVerifyResult> {
  const usable = await findUsableCustomerToken({
    businessId: business._id,
    rawToken,
    type: "email_verification",
  });
  if (!usable) return "invalid_token";
  const account = await Customer.findOne({ _id: usable.customerId, business: business._id, active: true })
    .select("+passwordHash tokenVersion")
    .lean();
  if (!account) return "invalid_token";
  if (!account.passwordHash || !(await verifyPassword(password, account.passwordHash))) {
    return "invalid_password";
  }

  let result: CustomerVerifyResult = "invalid_token";
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      result = "invalid_token";
      const consumed = await consumeCustomerToken({
        businessId: business._id,
        rawToken,
        type: "email_verification",
        session,
      });
      if (!consumed) return;
      // Same password version that was just checked: if the password changed
      // in between (e.g. a reset), this becomes a no-op instead.
      const updated = await Customer.updateOne(
        {
          _id: consumed.customerId,
          business: business._id,
          active: true,
          tokenVersion: account.tokenVersion,
          emailVerifiedAt: null,
        },
        { $set: { emailVerifiedAt: new Date() } },
        { session },
      );
      // Roll back the consumption too: the token is only spent on success.
      if (updated.matchedCount !== 1) throw new RollbackSignal();
      result = "verified";
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
    result = "invalid_token";
  } finally {
    await session.endSession();
  }
  return result;
}

/** Thrown inside a transaction callback to abort it without an error response. */
class RollbackSignal extends Error {}

export interface CustomerProfile {
  name: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  createdAt: string;
}

function profileOf(customer: { name: string; email: string; phone?: string; emailVerifiedAt?: Date | null; createdAt: Date }): CustomerProfile {
  return {
    name: customer.name,
    email: customer.email,
    phone: customer.phone ?? "",
    emailVerified: customer.emailVerifiedAt instanceof Date,
    createdAt: new Date(customer.createdAt).toISOString(),
  };
}

/** A customer's own details, allowlisted. Always scoped to the business. */
export async function readCustomerProfile(businessId: unknown, customerId: string): Promise<CustomerProfile | null> {
  await dbConnect();
  const customer = await Customer.findOne({ _id: customerId, business: businessId, active: true })
    .select("name email phone emailVerifiedAt createdAt")
    .lean();
  return customer ? profileOf(customer) : null;
}

/** Updates only the name and phone. The email and verification state never change here. */
export async function updateCustomerProfile(
  businessId: unknown,
  customerId: string,
  input: { name: string; phone: string },
): Promise<CustomerProfile | null> {
  await dbConnect();
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, business: businessId, active: true },
    { $set: { name: input.name, phone: input.phone } },
    { new: true, runValidators: true },
  )
    .select("name email phone emailVerifiedAt createdAt")
    .lean();
  return customer ? profileOf(customer) : null;
}

export type CustomerPasswordChangeResult =
  | { ok: true; email: string; tokenVersion: number; credential: string }
  | { ok: false; reason: "invalid_password" | "same_password" };

/**
 * A signed-in customer changes their password, proving the current one. In one
 * transaction the new hash is stored (the model bumps `tokenVersion`, which
 * signs out every device and outdates every known-device marker) and every open
 * reset or verification link dies. The route then signs this browser in again.
 */
export async function changeCustomerPassword(
  business: BusinessDoc,
  customerId: string,
  currentPassword: string,
  newPassword: string,
): Promise<CustomerPasswordChangeResult> {
  await dbConnect();
  const account = await Customer.findOne({ _id: customerId, business: business._id, active: true })
    .select("+passwordHash")
    .lean();
  if (!account?.passwordHash || !(await verifyPassword(currentPassword, account.passwordHash))) {
    return { ok: false, reason: "invalid_password" };
  }
  if (await verifyPassword(newPassword, account.passwordHash)) return { ok: false, reason: "same_password" };
  const passwordHash = await hashPassword(newPassword);

  const session = await mongoose.startSession();
  let changed: CustomerPasswordChangeResult = { ok: false, reason: "invalid_password" };
  try {
    await session.withTransaction(async () => {
      changed = { ok: false, reason: "invalid_password" };
      const customer = await Customer.findOne({ _id: customerId, business: business._id, active: true })
        .select("+passwordHash email tokenVersion")
        .session(session);
      // The password changed while this request was hashing: start again.
      if (!customer || customer.passwordHash !== account.passwordHash) return;
      customer.passwordHash = passwordHash;
      await customer.save({ session });
      await CustomerActionToken.updateMany(
        { business: business._id, customer: customer._id, usedAt: null },
        { $set: { usedAt: new Date() } },
        { session },
      );
      changed = {
        ok: true,
        email: customer.email,
        tokenVersion: customer.tokenVersion ?? 0,
        credential: customerCredentialFingerprint(String(business._id), passwordHash),
      };
    });
  } finally {
    await session.endSession();
  }
  return changed;
}

/**
 * Resets a password with a single-use token of THIS business. On success it
 * returns only what the route needs for a new known-device marker: the account
 * email and the NEW password's fingerprint (never the hash); null otherwise.
 * The token is checked (without being spent) BEFORE the bcrypt work, so junk
 * tokens cost no hashing. Then, in one transaction: consume the token, store
 * the new hash (the model bumps `tokenVersion`, revoking every existing
 * session; the new hash also outdates every existing known-device marker),
 * mark the email verified (the reset proved inbox control) and invalidate
 * every other open token of the account.
 */
export async function resetCustomerPassword(
  business: BusinessDoc,
  rawToken: string,
  newPassword: string,
): Promise<{ email: string; credential: string; customerId: string } | null> {
  const usable = await findUsableCustomerToken({
    businessId: business._id,
    rawToken,
    type: "password_reset",
  });
  if (!usable) return null;
  const passwordHash = await hashPassword(newPassword);
  const session = await mongoose.startSession();
  let reset: { email: string; credential: string; customerId: string } | null = null;
  try {
    await session.withTransaction(async () => {
      reset = null;
      const consumed = await consumeCustomerToken({
        businessId: business._id,
        rawToken,
        type: "password_reset",
        session,
      });
      if (!consumed) return;
      const customer = await Customer.findOne({
        _id: consumed.customerId,
        business: business._id,
        active: true,
      })
        .select("+passwordHash email emailVerifiedAt tokenVersion")
        .session(session);
      if (!customer) throw new RollbackSignal();
      customer.passwordHash = passwordHash;
      if (!customer.emailVerifiedAt) customer.emailVerifiedAt = new Date();
      await customer.save({ session });
      // Every other open link (reset or verification) for this account dies.
      await CustomerActionToken.updateMany(
        { business: business._id, customer: customer._id, usedAt: null },
        { $set: { usedAt: new Date() } },
        { session },
      );
      reset = {
        customerId: String(customer._id),
        email: customer.email,
        credential: customerCredentialFingerprint(String(business._id), passwordHash),
      };
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
    reset = null;
  } finally {
    await session.endSession();
  }
  return reset;
}
