import { dbConnect } from "@/lib/db";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email";
import { renderPlatformAccountExistsEmail } from "@/lib/email-templates";
import { hashPassword } from "@/lib/auth/password";
import { issueEmailVerification } from "@/lib/auth/email-verification";
import { checkRateLimit } from "@/lib/rate-limit";
import { User } from "@/models/User";

const NOTICE_WINDOW_MS = 60 * 60 * 1000;
const NOTICE_MAX_PER_EMAIL = 3;

const isDuplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 11000);

/**
 * Runs after the register response. A new address gets an unverified account and a
 * confirmation link; an address that already has an account gets a notice and keeps
 * everything it had. Attempts per address are capped, silently, so this cannot be
 * used to fill someone's mailbox.
 */
export async function processRegistration(input: { name: string; email: string; password: string }): Promise<void> {
  await dbConnect();
  const allowed = await checkRateLimit({ key: `register:email:${input.email}`, limit: NOTICE_MAX_PER_EMAIL, windowMs: NOTICE_WINDOW_MS });
  if (!allowed) return;

  const existing = await User.findOne({ email: input.email }).select("name email active").lean<{ name?: string; email: string; active?: boolean }>();
  if (existing) {
    await sendAccountExistsNotice(existing);
    return;
  }

  const passwordHash = await hashPassword(input.password);
  let user;
  try {
    user = await User.create({
      name: input.name,
      email: input.email,
      passwordHash,
      platformRole: "user",
      // New accounts start explicitly unverified. The field has no schema
      // default so legacy accounts are unaffected.
      emailVerifiedAt: null,
    });
  } catch (error) {
    // A concurrent registration of the same address won; it gets the link.
    if (isDuplicateKey(error)) return;
    throw error;
  }
  await issueEmailVerification({ userId: user._id, to: user.email, name: user.name });
}

async function sendAccountExistsNotice(user: { name?: string; email: string; active?: boolean }): Promise<void> {
  if (user.active === false) return;
  const base = env().APP_URL.replace(/\/+$/, "");
  await sendEmail({ to: user.email, ...renderPlatformAccountExistsEmail({ name: user.name, loginUrl: `${base}/login`, resetUrl: `${base}/forgot-password` }) });
}
