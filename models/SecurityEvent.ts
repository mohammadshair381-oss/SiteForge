import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Authentication security events (append-only, server-written) for platform
 * users and storefront customer accounts (`scope`).
 *
 * Data minimisation: no passwords, no raw email addresses for unknown
 * accounts, no raw IP addresses, no user agents, no request bodies. Attempts
 * are correlated through keyed HMAC digests (`lib/security-events.ts`), which
 * cannot be reversed without the server secret. A known account is referenced
 * by id only.
 *
 * Retention: `expiresAt` = createdAt + 90 days. Views ignore older events.
 * Index policy: `autoIndex` / `autoCreate` OFF. The TTL index that deletes
 * expired events, and the read index, are an approved operation
 * (docs/security-monitoring.md). Until the TTL index exists, events are
 * retained but never shown after 90 days.
 *
 * Volume is bounded by the existing login rate limits (failures are recorded
 * only for attempts that pass the per-IP and per-email limiters).
 */
export const SECURITY_EVENT_TYPES = [
  /** Platform sign-in failed (reason says why). */
  "login_failed",
  /** A super admin signed in. */
  "admin_login",
  /** A super admin entered a wrong password when confirming a role change. */
  "admin_reauth_failed",
  /** Storefront customer sign-in failed (unknown, wrong password and inactive are not distinguished, by design). */
  "customer_login_failed",
  /** A password reset link was requested (platform or storefront). */
  "password_reset_requested",
  /** A password reset was attempted with an invalid, expired or used token. */
  "password_reset_failed",
  /** A password was changed through a reset link. */
  "password_reset_completed",
  /** A signed customer session was presented after it was revoked or the account was deactivated/removed. */
  "customer_session_revoked",
  /** A signed PLATFORM session was presented after it was revoked (sign-out everywhere, role change, deactivation). */
  "platform_session_revoked",
  /** An email-verification link was refused (invalid/expired token, or wrong password for customers). */
  "email_verification_failed",
  /** A signed-in platform user entered a wrong current password when changing it. */
  "password_change_failed",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export const SECURITY_EVENT_REASONS = [
  "unknown_account",
  "wrong_password",
  "unverified_account",
  "inactive_account",
  "invalid_token",
  "reset_conflict",
  "token_version_mismatch",
  "account_missing",
] as const;
export type SecurityEventReason = (typeof SECURITY_EVENT_REASONS)[number];

export const SECURITY_EVENT_RETENTION_DAYS = 90;

/** Platform accounts (SiteForge users) vs storefront customer accounts. */
export const SECURITY_EVENT_SCOPES = ["platform", "storefront"] as const;
export type SecurityEventScope = (typeof SECURITY_EVENT_SCOPES)[number];

export interface SecurityEventDoc {
  _id: Types.ObjectId;
  type: SecurityEventType;
  reason: SecurityEventReason | null;
  /** Absent on events written before scopes existed: those are platform events. */
  scope?: SecurityEventScope;
  user: Types.ObjectId | null;
  /** Storefront events: the store (from the Host) and, when known, the customer account id. */
  business?: Types.ObjectId | null;
  customer?: Types.ObjectId | null;
  /** HMAC of the normalised email that was attempted. */
  emailDigest: string | null;
  /** HMAC of the trusted client address; null when it is not available. */
  sourceDigest: string | null;
  createdAt: Date;
  expiresAt: Date;
}

const securityEventSchema = new Schema<SecurityEventDoc>(
  {
    type: { type: String, enum: SECURITY_EVENT_TYPES, required: true, immutable: true },
    reason: { type: String, enum: [...SECURITY_EVENT_REASONS, null], default: null, immutable: true },
    scope: { type: String, enum: SECURITY_EVENT_SCOPES, default: "platform", immutable: true },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    business: { type: Schema.Types.ObjectId, ref: "Business", default: null, immutable: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer", default: null, immutable: true },
    emailDigest: { type: String, default: null, maxlength: 64, immutable: true },
    sourceDigest: { type: String, default: null, maxlength: 64, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
  },
);

securityEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
securityEventSchema.index({ type: 1, createdAt: -1 });

function refuseMutation(): never {
  throw new Error("Security events are append-only");
}
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) {
  securityEventSchema.pre(op, refuseMutation);
}
securityEventSchema.pre("save", function () {
  if (!this.isNew) refuseMutation();
});

export const SecurityEvent: Model<SecurityEventDoc> =
  (models.SecurityEvent as Model<SecurityEventDoc>) ||
  model<SecurityEventDoc>("SecurityEvent", securityEventSchema);
