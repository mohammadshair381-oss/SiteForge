import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readCustomerProfile } from "@/lib/auth/customer-accounts";
import { requireCustomerPage } from "@/lib/auth/customer-page";
import AccountShell from "@/components/storefront/account/AccountShell";
import { ChangePasswordForm, ProfileForm } from "@/components/storefront/account/AccountForms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Your profile" } };

/** The signed-in customer's own details and password. */
export default async function CustomerProfilePage() {
  const { business, customer } = await requireCustomerPage("/account/profile");
  const profile = await readCustomerProfile(business._id, customer.id);
  if (!profile) redirect("/account/login?next=%2Faccount%2Fprofile");

  return (
    <AccountShell
      themeId={business.themeId}
      customerName={customer.name}
      active="profile"
      title="Your profile"
      intro={<>The details this store uses for your account.</>}
    >
      {!profile.emailVerified && (
        <p className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          Your email address is not confirmed yet.{" "}
          <Link href="/account/verify-email" className="font-semibold underline underline-offset-2">Send a new confirmation link</Link>.
        </p>
      )}
      <p className="mb-4 text-sm">
        <Link href="/account/addresses" className="sf-acc-focus inline-flex min-h-10 items-center rounded font-medium underline underline-offset-4 focus-visible:outline-none">Manage your delivery addresses</Link>
      </p>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section aria-labelledby="profile-details" className="sf-acc-card p-5 sm:p-7">
          <h2 id="profile-details" className="sf-acc-title mb-5 font-display text-xl">Your details</h2>
          <ProfileForm initial={{ name: profile.name, phone: profile.phone, email: profile.email }} />
        </section>
        <section aria-labelledby="profile-password" className="sf-acc-card p-5 sm:p-7">
          <h2 id="profile-password" className="sf-acc-title mb-5 font-display text-xl">Change password</h2>
          <ChangePasswordForm />
        </section>
      </div>
    </AccountShell>
  );
}
