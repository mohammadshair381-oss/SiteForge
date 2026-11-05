import type { Metadata } from "next";
import { AccountCard, ResetPasswordForm } from "@/components/storefront/account/AccountForms";

export const metadata: Metadata = { title: { absolute: "Choose a new password" } };

export default function CustomerResetPasswordPage() {
  return (
    <AccountCard title="Choose a new password">
      <ResetPasswordForm />
    </AccountCard>
  );
}
