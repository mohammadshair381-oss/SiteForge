import type { Metadata } from "next";
import { AccountCard, VerifyEmailForm } from "@/components/storefront/account/AccountForms";

export const metadata: Metadata = { title: { absolute: "Confirm your email" } };

/**
 * The link token is never auto-submitted (mail scanners prefetch links); the
 * customer confirms with their password, which the form sends with the token.
 */
export default function CustomerVerifyEmailPage() {
  return (
    <AccountCard title="Confirm your email">
      <VerifyEmailForm />
    </AccountCard>
  );
}
