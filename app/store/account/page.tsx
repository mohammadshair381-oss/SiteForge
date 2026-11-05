import type { Metadata } from "next";
import Link from "next/link";
import { readCustomerProfile } from "@/lib/auth/customer-accounts";
import { requireCustomerPage } from "@/lib/auth/customer-page";
import { countCustomerOrders, listCustomerOrders } from "@/lib/orders/customer-orders";
import AccountShell from "@/components/storefront/account/AccountShell";
import { OrderSummaryCard, orderDate } from "@/components/storefront/account/OrderSummary";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Your account" } };

/** The customer's dashboard at this store. The layout already enforces the feature flag and an eligible store. */
export default async function CustomerAccountPage() {
  const { business, customer } = await requireCustomerPage("/account");
  const [orders, orderCount, profile] = await Promise.all([
    listCustomerOrders(business._id, customer.id),
    countCustomerOrders(business._id, customer.id),
    readCustomerProfile(business._id, customer.id),
  ]);
  const recent = orders.slice(0, 2);
  const open = orders.filter((order) => order.status === "pending").length;

  const tile = (label: string, value: string, href: string) => (
    <Link href={href} className="sf-acc-card sf-acc-focus block p-5 transition-opacity hover:opacity-90 focus-visible:outline-none">
      <span className="sf-acc-muted block text-sm">{label}</span>
      <span className="sf-acc-title mt-1 block break-words font-display text-2xl">{value}</span>
    </Link>
  );

  return (
    <AccountShell
      themeId={business.themeId}
      customerName={customer.name}
      active="overview"
      title={`Hello, ${customer.name.split(/\s+/)[0]}`}
      intro={<>Your account at {business.name}.{profile ? ` Member since ${orderDate(profile.createdAt, false)}.` : ""}</>}
    >
      <ConfirmHost inline />
      {!customer.emailVerified && (
        <p className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          Your email address is not confirmed yet.{" "}
          <Link href="/account/verify-email" className="font-semibold underline underline-offset-2">Send a new confirmation link</Link>.
        </p>
      )}
      <div className="grid gap-4 min-[420px]:grid-cols-2 xl:grid-cols-3">
        {tile("Orders placed", String(orderCount), "/account/orders")}
        {tile("Awaiting payment or delivery", String(open), "/account/orders")}
        <div className="min-[420px]:col-span-2 xl:col-span-1">{tile("Email", customer.emailVerified ? "Confirmed" : "Not confirmed", "/account/profile")}</div>
      </div>

      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="sf-acc-title font-display text-xl sm:text-2xl">Recent orders</h2>
        {orders.length > 0 && (
          <Link href="/account/orders" className="sf-acc-focus inline-flex min-h-10 items-center rounded text-sm font-medium underline underline-offset-4 focus-visible:outline-none">
            All orders
          </Link>
        )}
      </div>
      {recent.length === 0 ? (
        <div className="sf-acc-card mt-4 px-6 py-10 text-center">
          <p className="font-semibold">You have no orders yet.</p>
          <p className="sf-acc-muted mx-auto mt-1 max-w-sm text-sm leading-6">Orders you place while signed in will appear here.</p>
          <Link href="/" className="sf-acc-action sf-acc-control sf-acc-focus mt-5 inline-flex min-h-11 items-center justify-center px-5 py-2 text-sm font-semibold focus-visible:outline-none">
            Start shopping
          </Link>
        </div>
      ) : (
        <ul className="mt-4 space-y-4">
          {recent.map((order) => (
            <li key={order.orderId}>
              <OrderSummaryCard order={order} />
            </li>
          ))}
        </ul>
      )}
    </AccountShell>
  );
}
