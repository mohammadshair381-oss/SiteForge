import { redirect } from "next/navigation";
import { resolveSuperAdminPageAccess } from "@/lib/auth/guards";

/** Page-level guard for /admin pages: same checks as the admin API. */
export async function requireSuperAdminPage() {
  const access = await resolveSuperAdminPageAccess();
  if (access.kind === "login") redirect("/login");
  if (access.kind === "forbidden") redirect("/dashboard");
  return access.user;
}

/** Flatten Next.js searchParams to single string values. */
export function singleParams(raw: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
}
