import bcrypt from "bcryptjs";

const ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

let dummyHashPromise: Promise<string> | null = null;

/** Takes as long as checking a real password, for addresses with no usable account. */
export async function spendPasswordCheck(plain: string): Promise<void> {
  dummyHashPromise ??= hashPassword(`siteforge-dummy-${Math.random()}`);
  await verifyPassword(plain, await dummyHashPromise);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
