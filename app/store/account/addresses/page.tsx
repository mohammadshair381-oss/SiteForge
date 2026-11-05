import type { Metadata } from "next";
import { requireCustomerPage } from "@/lib/auth/customer-page";
import { MAX_SAVED_ADDRESSES, listCustomerAddresses } from "@/lib/customer-addresses";
import AccountShell from "@/components/storefront/account/AccountShell";
import AddressBook from "@/components/storefront/account/AddressBook";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Your addresses" } };

/** The signed-in customer's own saved delivery addresses at this store. */
export default async function CustomerAddressesPage() {
  const { business, customer } = await requireCustomerPage("/account/addresses");
  const addresses = await listCustomerAddresses(business._id, customer.id);

  return (
    <AccountShell
      themeId={business.themeId}
      customerName={customer.name}
      active="addresses"
      title="Your addresses"
      intro={<>Your default address fills in at checkout. Saved addresses are only used at {business.name}.</>}
    >
      <ConfirmHost inline />
      <AddressBook initial={addresses} maxAddresses={MAX_SAVED_ADDRESSES} />
    </AccountShell>
  );
}
