import { isCustomerAccountsEnabled } from "@/lib/env";
import { resolveCheckoutCustomer } from "@/lib/auth/customer-guards";
import type { BusinessDoc } from "@/models/Business";

/**
 * Props for the storefront shopping bar (server-only, display only): whether
 * customer accounts are on and, if so, the first name of a signed-in, verified
 * customer of THIS store. Never throws the customer-feature 404.
 */
export async function shopperBarProps(
  business: Pick<BusinessDoc, "_id" | "name">,
  cookieHeader: string | null,
): Promise<{ storeName: string; accountsEnabled: boolean; signedInName: string | null; signedInUnverified: boolean }> {
  const accountsEnabled = isCustomerAccountsEnabled();
  if (!accountsEnabled) return { storeName: business.name, accountsEnabled, signedInName: null, signedInUnverified: false };
  const resolution = await resolveCheckoutCustomer(
    new Request("http://storefront.invalid/", { headers: { cookie: cookieHeader ?? "" } }),
    business,
  );
  return {
    storeName: business.name,
    accountsEnabled,
    signedInName: resolution.status === "customer" ? resolution.customer.name.split(" ")[0] || resolution.customer.name : null,
    // Signed in with this store but the e-mail is not confirmed yet. Expired,
    // revoked, other-store and inactive sessions all count as signed out.
    signedInUnverified: resolution.status === "unverified",
  };
}
