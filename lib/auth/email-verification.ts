import { env } from "../env";
import { sendEmail } from "../email";
import { renderEmailVerificationEmail } from "../email-templates";
import { createActionToken } from "./action-tokens";
import type { Types } from "mongoose";

/**
 * Email-verification orchestration: issues a single-use action token and
 * delivers the branded verification email. Kept separate from the routes so
 * registration and resend share one implementation.
 *
 * The raw token only ever appears inside the delivered email; it is never
 * returned to callers, logged or persisted.
 */

export const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const EMAIL_VERIFICATION_TTL_HOURS = EMAIL_VERIFICATION_TTL_MS / (1000 * 60 * 60);

/** Builds the absolute verification link on the configured APP_URL. */
export function buildVerificationUrl(rawToken: string): string {
  const base = env().APP_URL.replace(/\/+$/, "");
  // After `#`: browsers never send it to a server (lib/use-link-token.ts).
  return `${base}/verify-email#token=${encodeURIComponent(rawToken)}`;
}

export interface IssueVerificationOptions {
  userId: Types.ObjectId | string;
  to: string;
  name?: string | null;
}

/**
 * Creates a fresh verification token (invalidating any previous one for the
 * user) and sends the email. Throws if the email provider fails so callers can
 * decide how to surface it — it never reports delivery that did not happen.
 */
export async function issueEmailVerification(
  options: IssueVerificationOptions,
): Promise<{ expiresAt: Date }> {
  const { rawToken, expiresAt } = await createActionToken(
    options.userId,
    "email_verification",
    EMAIL_VERIFICATION_TTL_MS,
  );

  const { subject, text, html } = renderEmailVerificationEmail({
    name: options.name,
    verifyUrl: buildVerificationUrl(rawToken),
    expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
  });

  await sendEmail({ to: options.to, subject, text, html });

  return { expiresAt };
}
