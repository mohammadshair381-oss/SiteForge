import { env } from "../env";
import { sendEmail } from "../email";
import { renderPasswordResetEmail } from "../email-templates";
import { createActionToken } from "./action-tokens";
import { AuthToken } from "@/models/AuthToken";
import type { Types } from "mongoose";

/**
 * Password-reset orchestration: issues a single-use `password_reset` action
 * token and delivers the branded reset email. Kept separate from the route so
 * the forgot-password handler stays focused on the enumeration-safe response.
 *
 * The raw token only ever appears inside the delivered email; it is never
 * returned to callers, logged or persisted.
 */

export const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60; // 1 hour
const PASSWORD_RESET_TTL_MINUTES = PASSWORD_RESET_TTL_MS / (1000 * 60);

/** Builds the absolute reset link on the configured APP_URL. */
export function buildPasswordResetUrl(rawToken: string): string {
  const base = env().APP_URL.replace(/\/+$/, "");
  // After `#`: browsers never send it to a server (lib/use-link-token.ts).
  return `${base}/reset-password#token=${encodeURIComponent(rawToken)}`;
}

export interface IssuePasswordResetOptions {
  userId: Types.ObjectId | string;
  to: string;
  name?: string | null;
}

/**
 * Creates a fresh reset token (invalidating any previous one for the user) and
 * sends the email. Throws if the email provider fails — it never reports
 * delivery that did not happen.
 *
 * If sending fails after the token was created, the token is retired (best
 * effort) so a link to an email that was never delivered cannot be used. This
 * uses the existing `AuthToken` document directly rather than inventing a new
 * token-lifecycle API.
 */
export async function issuePasswordReset(
  options: IssuePasswordResetOptions,
): Promise<{ expiresAt: Date }> {
  const { rawToken, expiresAt, tokenId } = await createActionToken(
    options.userId,
    "password_reset",
    PASSWORD_RESET_TTL_MS,
  );

  try {
    const { subject, text, html } = renderPasswordResetEmail({
      name: options.name,
      resetUrl: buildPasswordResetUrl(rawToken),
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    });

    await sendEmail({ to: options.to, subject, text, html });
  } catch (error) {
    try {
      await AuthToken.updateOne(
        { _id: tokenId, usedAt: null },
        { $set: { usedAt: new Date() } },
      );
    } catch {
      // Best-effort only: the send failure below is what the caller must see.
    }
    throw error;
  }

  return { expiresAt };
}
