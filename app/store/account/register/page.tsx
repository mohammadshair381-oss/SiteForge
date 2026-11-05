import type { Metadata } from "next";
import { AccountCard, RegisterForm } from "@/components/storefront/account/AccountForms";
import { redirectIfSignedIn } from "@/lib/auth/customer-page";

export const metadata: Metadata = { title: { absolute: "Create an account" } };

export default async function CustomerRegisterPage() {
  await redirectIfSignedIn("/account");
  return (
    <AccountCard
      title="Create an account"
      intro="Your account belongs to this store only. We will email you a link to confirm your address."
    >
      <RegisterForm />
    </AccountCard>
  );
}
