import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCustomer, type CustomerContext } from "./customer-guards";

async function fromRequestHeaders(path: string): Promise<CustomerContext | null> {
  const headerList = await headers();
  return getCustomer(
    new Request(`http://storefront.invalid${path}`, {
      headers: { host: headerList.get("host") ?? "", cookie: headerList.get("cookie") ?? "" },
    }),
  );
}

/** Account pages: the signed-in customer of this store, or a redirect to sign in and back. */
export async function requireCustomerPage(path: string): Promise<CustomerContext> {
  const context = await fromRequestHeaders(path);
  if (!context) redirect(`/account/login?next=${encodeURIComponent(path)}`);
  return context;
}

/** Sign-in and registration pages: someone already signed in goes on instead. */
export async function redirectIfSignedIn(destination: string): Promise<void> {
  if (await fromRequestHeaders("/account")) redirect(destination);
}
