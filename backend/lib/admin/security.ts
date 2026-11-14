import mongoose from "mongoose";
import { z } from "zod";
import { dbConnect } from "@/lib/db";
import {
  SECURITY_EVENT_REASONS,
  SECURITY_EVENT_RETENTION_DAYS,
  SECURITY_EVENT_SCOPES,
  SECURITY_EVENT_TYPES,
  SecurityEvent,
} from "@/models/SecurityEvent";
import { Business } from "@/models/Business";
import { User } from "@/models/User";

/** Sign-in failures of either kind (platform users, storefront customers). */
const LOGIN_FAILURES = ["login_failed", "customer_login_failed"];

/**
 * Read-only security monitoring for super admins (server-only).
 * Digests are shown shortened; they identify repeated attempts without
 * revealing the email or address. Known accounts are shown by name/email
 * (platform admins already see them in the user list).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PAGE_SIZE = 50;

/** Thresholds for alerts (match the login limiter: 5 failures per email per 5 minutes). */
export const TARGETED_ACCOUNT_THRESHOLD = 5;
export const BUSY_SOURCE_THRESHOLD = 20;

export function shortDigest(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function retentionFloor(now: Date): Date {
  return new Date(now.getTime() - SECURITY_EVENT_RETENTION_DAYS * DAY);
}

export interface SecuritySummary {
  failedLogins: { lastHour: number; last24h: number; last7d: number };
  /** Storefront customer sign-in failures (all stores). */
  customerFailedLogins: { lastHour: number; last24h: number };
  passwordResets24h: { requested: number; failed: number; completed: number };
  revokedCustomerSessions24h: number;
  revokedPlatformSessions24h: number;
  emailVerificationFailures24h: number;
  passwordChangeFailures24h: number;
  adminLogins24h: number;
  adminReauthFailures24h: number;
  /** Emails (as digests) with many failures in the last hour, per platform or per store. */
  targetedAccounts: Array<{
    digest: string;
    failures: number;
    scope: "platform" | "storefront";
    user: { id: string; name: string; email: string } | null;
    business: { id: string; name: string } | null;
  }>;
  /** Client sources (as digests) with many failures in the last 24 hours. */
  busySources: Array<{ digest: string; failures: number; distinctAccounts: number }>;
}

export async function getSecuritySummary(now = new Date()): Promise<SecuritySummary> {
  await dbConnect();
  const since = (ms: number) => ({ $gte: new Date(now.getTime() - ms) });
  const count = (type: string, ms: number) => SecurityEvent.countDocuments({ type, createdAt: since(ms) });
  const [
    lastHour, last24h, last7d, adminLogins24h, adminReauthFailures24h,
    customerHour, customerDay, resetRequested, resetFailed, resetCompleted, revoked24h,
    platformRevoked24h, verifyFailed24h, passwordChangeFailed24h,
    targeted, sources,
  ] = await Promise.all([
    count("login_failed", HOUR),
    count("login_failed", DAY),
    count("login_failed", 7 * DAY),
    count("admin_login", DAY),
    count("admin_reauth_failed", DAY),
    count("customer_login_failed", HOUR),
    count("customer_login_failed", DAY),
    count("password_reset_requested", DAY),
    count("password_reset_failed", DAY),
    count("password_reset_completed", DAY),
    count("customer_session_revoked", DAY),
    count("platform_session_revoked", DAY),
    count("email_verification_failed", DAY),
    count("password_change_failed", DAY),
    SecurityEvent.aggregate<{ _id: { digest: string; scope: string | null; business: unknown }; failures: number; user: unknown }>([
      { $match: { type: { $in: LOGIN_FAILURES }, createdAt: since(HOUR), emailDigest: { $type: "string" } } },
      // The same email on the platform or at two stores is three different accounts.
      { $group: { _id: { digest: "$emailDigest", scope: "$scope", business: "$business" }, failures: { $sum: 1 }, user: { $max: "$user" } } },
      { $match: { failures: { $gte: TARGETED_ACCOUNT_THRESHOLD } } },
      { $sort: { failures: -1 } },
      { $limit: 20 },
    ]),
    SecurityEvent.aggregate<{ _id: string; failures: number; accounts: string[] }>([
      { $match: { type: { $in: [...LOGIN_FAILURES, "password_reset_failed"] }, createdAt: since(DAY), sourceDigest: { $type: "string" } } },
      { $group: { _id: "$sourceDigest", failures: { $sum: 1 }, accounts: { $addToSet: "$emailDigest" } } },
      { $match: { failures: { $gte: BUSY_SOURCE_THRESHOLD } } },
      { $sort: { failures: -1 } },
      { $limit: 20 },
    ]),
  ]);
  const [users, businesses] = await Promise.all([
    User.find({ _id: { $in: targeted.map((t) => t.user).filter(Boolean) } }).select("name email").lean(),
    Business.find({ _id: { $in: targeted.map((t) => t._id.business).filter(Boolean) } }).select("name").lean(),
  ]);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const businessById = new Map(businesses.map((b) => [String(b._id), b]));
  return {
    failedLogins: { lastHour, last24h, last7d },
    customerFailedLogins: { lastHour: customerHour, last24h: customerDay },
    passwordResets24h: { requested: resetRequested, failed: resetFailed, completed: resetCompleted },
    revokedCustomerSessions24h: revoked24h,
    revokedPlatformSessions24h: platformRevoked24h,
    emailVerificationFailures24h: verifyFailed24h,
    passwordChangeFailures24h: passwordChangeFailed24h,
    adminLogins24h,
    adminReauthFailures24h,
    targetedAccounts: targeted.map((t) => {
      const scope = t._id.scope === "storefront" ? ("storefront" as const) : ("platform" as const);
      const u = scope === "platform" && t.user ? byId.get(String(t.user)) : undefined;
      const b = t._id.business ? businessById.get(String(t._id.business)) : undefined;
      return {
        digest: shortDigest(t._id.digest) ?? "",
        failures: t.failures,
        scope,
        // Platform accounts by name/email (admins manage them); storefront customers by store only.
        user: u ? { id: String(u._id), name: u.name, email: u.email } : null,
        business: b ? { id: String(b._id), name: b.name } : null,
      };
    }),
    busySources: sources.map((s) => ({ digest: shortDigest(s._id) ?? "", failures: s.failures, distinctAccounts: s.accounts.length })),
  };
}

export const securityQuerySchema = z.object({
  type: z.enum(SECURITY_EVENT_TYPES).optional().catch(undefined),
  reason: z.enum(SECURITY_EVENT_REASONS).optional().catch(undefined),
  scope: z.enum(SECURITY_EVENT_SCOPES).optional().catch(undefined),
  business: z.string().regex(/^[0-9a-f]{24}$/i).optional().catch(undefined),
  user: z.string().regex(/^[0-9a-f]{24}$/i).optional().catch(undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).prefault(1).catch(1),
});
export type SecurityQuery = z.infer<typeof securityQuerySchema>;

export async function listSecurityEvents(query: SecurityQuery, now = new Date()) {
  await dbConnect();
  const createdAt: Record<string, Date> = { $gte: retentionFloor(now) };
  if (query.from) {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    if (from > createdAt.$gte) createdAt.$gte = from;
  }
  if (query.to) createdAt.$lt = new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + DAY);
  const filter: Record<string, unknown> = { createdAt };
  if (query.type) filter.type = query.type;
  if (query.reason) filter.reason = query.reason;
  if (query.user) filter.user = new mongoose.Types.ObjectId(query.user);
  if (query.business) filter.business = new mongoose.Types.ObjectId(query.business);
  // Events written before scopes existed have no `scope`: they are platform events.
  if (query.scope === "platform") filter.scope = { $in: ["platform", null] };
  if (query.scope === "storefront") filter.scope = "storefront";

  const [total, rows] = await Promise.all([
    SecurityEvent.countDocuments(filter),
    SecurityEvent.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .populate({ path: "user", select: "name email platformRole", model: User })
      .populate({ path: "business", select: "name", model: Business })
      .lean(),
  ]);
  return {
    page: query.page,
    pageSize: PAGE_SIZE,
    total,
    retentionDays: SECURITY_EVENT_RETENTION_DAYS,
    events: rows.map((e) => {
      const u = e.user as unknown as { _id?: unknown; name?: string; email?: string; platformRole?: string } | null;
      const b = e.business as unknown as { _id?: unknown; name?: string } | null;
      return {
        id: String(e._id),
        type: e.type,
        reason: e.reason ?? null,
        scope: e.scope === "storefront" ? ("storefront" as const) : ("platform" as const),
        business: b?._id ? { id: String(b._id), name: b.name ?? "" } : null,
        /** Storefront customer: a short reference to the opaque account id, never a name or email. */
        customerRef: e.customer ? String(e.customer).slice(-8) : null,
        user: u?._id ? { id: String(u._id), name: u.name ?? "", email: u.email ?? "", platformRole: u.platformRole ?? "user" } : null,
        account: shortDigest(e.emailDigest),
        source: shortDigest(e.sourceDigest),
        createdAt: e.createdAt,
      };
    }),
  };
}
