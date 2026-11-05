import type { Metadata } from "next";
import { AccountCard, LoginForm } from "@/components/storefront/account/AccountForms";
import { redirectIfSignedIn } from "@/lib/auth/customer-page";
import { safeStorefrontPath } from "@/lib/auth/customer-redirect";

export const metadata: Metadata = { title: { absolute: "Sign in" } };

export default async function CustomerLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { next } = await searchParams;
  const destination = safeStorefrontPath(Array.isArray(next) ? next[0] : next);
  await redirectIfSignedIn(destination === "/" ? "/account" : destination);
  return (
    <AccountCard title="Sign in" intro="Welcome back. Sign in to your account at this store.">
      <LoginForm next={destination} />
    </AccountCard>
  );
}
