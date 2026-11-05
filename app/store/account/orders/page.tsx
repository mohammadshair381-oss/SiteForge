import type { Metadata } from "next";
import Link from "next/link";
import { requireCustomerPage } from "@/lib/auth/customer-page";
import { listCustomerOrdersPage } from "@/lib/orders/customer-orders";
import AccountShell from "@/components/storefront/account/AccountShell";
import { OrderSummaryCard } from "@/components/storefront/account/OrderSummary";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Your orders" } };

/**
 * The signed-in customer's orders at this store. Scoped by the Host-resolved
 * business AND the session's customer (`listCustomerOrders`). Orders placed as
 * a guest are not listed here.
 */
export default async function CustomerOrdersPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const { business, customer } = await requireCustomerPage("/account/orders");
  const { page: pageParam } = await searchParams;
  const page = typeof pageParam === "string" && /^[1-9][0-9]{0,3}$/.test(pageParam) ? Number(pageParam) : 1;
  const { orders, hasMore } = await listCustomerOrdersPage(business._id, customer.id, page);
  const pagerLink = "sf-acc-secondary sf-acc-control sf-acc-focus inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm font-semibold focus-visible:outline-none";

  return (
    <AccountShell
      themeId={business.themeId}
      customerName={customer.name}
      active="orders"
      title="Your orders"
      intro={<>Orders placed while signed in at {business.name}. Orders placed as a guest are not shown here.</>}
    >
      <ConfirmHost inline />
      {orders.length === 0 ? (
        <div className="sf-acc-card px-6 py-12 text-center">
          <p className="font-semibold">{page > 1 ? "There are no more orders." : "You have no orders yet."}</p>
          <p className="sf-acc-muted mx-auto mt-1 max-w-sm text-sm leading-6">Orders you place while signed in will appear here.</p>
          <Link href="/" className="sf-acc-action sf-acc-control sf-acc-focus mt-5 inline-flex min-h-11 items-center justify-center px-5 py-2 text-sm font-semibold focus-visible:outline-none">
            Start shopping
          </Link>
        </div>
      ) : (
        <ul className="space-y-4">
          {orders.map((order) => (
            <li key={order.orderId}>
              <OrderSummaryCard order={order} />
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || hasMore) && (
        <nav aria-label="More orders" className="mt-6 flex flex-wrap justify-between gap-3">
          {page > 1 ? <Link href={page === 2 ? "/account/orders" : `/account/orders?page=${page - 1}`} className={pagerLink}>Newer orders</Link> : <span />}
          {hasMore && <Link href={`/account/orders?page=${page + 1}`} className={pagerLink}>Older orders</Link>}
        </nav>
      )}
    </AccountShell>
  );
}
