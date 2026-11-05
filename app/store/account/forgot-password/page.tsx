import type { Metadata } from "next";
import { AccountCard, ForgotPasswordForm } from "@/components/storefront/account/AccountForms";

export const metadata: Metadata = { title: { absolute: "Forgot your password?" } };

export default function CustomerForgotPasswordPage() {
  return (
    <AccountCard
      title="Forgot your password?"
      intro="Enter the email you use at this store and we will send you a link to choose a new password."
    >
      <ForgotPasswordForm />
    </AccountCard>
  );
}
