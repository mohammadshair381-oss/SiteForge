import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { User } from "@/models/User";

const isDuplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 11000);

export const EMAIL_TAKEN = "An account with this email already exists. Log in, or reset your password if you forgot it.";

/**
 * Creates a platform account from signup (email and password; no emailed code, an owner decision).
 * The address is not confirmed by email: the account is created without `emailVerifiedAt`, like
 * every account from before confirmation existed, so it can use everything straight away.
 *
 * Because signing up signs in at once, an address that already has an account is refused with
 * `409 email_taken`: this tells the caller that the address is registered (see
 * docs/security-monitoring.md). Concurrent signups for one address create exactly one account
 * (the unique email index); the others get the same 409.
 */
export async function registerPlatformAccount(input: { name: string; email: string; password: string }) {
  await dbConnect();
  if (await User.exists({ email: input.email })) throw new HttpError(409, EMAIL_TAKEN, "email_taken", undefined, { email: EMAIL_TAKEN });
  const passwordHash = await hashPassword(input.password);
  try {
    return await User.create({ name: input.name, email: input.email, passwordHash, platformRole: "user" });
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, EMAIL_TAKEN, "email_taken", undefined, { email: EMAIL_TAKEN });
    throw error;
  }
}
