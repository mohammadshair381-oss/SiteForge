import { hashPassword } from "@/lib/auth/password";
import { User, type UserDoc } from "@/models/User";

export interface CreateUserOptions {
  email?: string;
  name?: string;
  password?: string;
  platformRole?: "user" | "super_admin";
  active?: boolean;
}

export async function createUser(options: CreateUserOptions = {}): Promise<UserDoc> {
  const email = options.email ?? `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  const password = options.password ?? "password123";
  const passwordHash = await hashPassword(password);

  const user = await User.create({
    email,
    name: options.name ?? "Test User",
    passwordHash,
    platformRole: options.platformRole ?? "user",
    active: options.active ?? true,
  });

  (user as UserDoc & { _plainPassword?: string })._plainPassword = password;
  return user;
}

export function getPlainPassword(user: UserDoc): string | undefined {
  return (user as UserDoc & { _plainPassword?: string })._plainPassword;
}

export {};