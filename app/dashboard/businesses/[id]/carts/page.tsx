import { requireBusinessRole } from "@/lib/auth/guards";
import { loadAbandonedCarts } from "@/lib/cart/abandoned";
import { formatPrice } from "@/lib/format";
import ManagementPageHeader from "@/components/dashboard/ManagementPageHeader";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill, StatTile } from "@/components/ui/Surface";

export const dynamic = "force-dynamic";

const when = (value: string) => new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

const LINE_NOTE = { ok: "", insufficient_stock: "not enough in stock", out_of_stock: "out of stock", unavailable: "no longer for sale" } as const;

/**
 * What shoppers left in their carts. Owners and managers, like orders. Read-only, and it
 * shows no contact details: carts do not hold any, and nothing here reaches a shopper.
 */
export default async function AbandonedCartsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);
  const summary = await loadAbandonedCarts(id);

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Abandoned carts"
        description="Carts nobody has touched for over 24 hours. They hold no stock, so they never keep an item from another shopper. They are deleted after 30 days without use."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Abandoned" value={summary.abandoned} hint="Untouched for over 24 hours" />
        <StatTile label="In use" value={summary.active} hint="Changed in the last 24 hours" />
        <StatTile label="Came back" value={summary.recovered} hint="Shoppers who returned to one of these carts" />
      </div>
      <Notice tone="info">
        SiteForge does not send reminders about abandoned carts. Marketing emails need a shopper&apos;s consent, and there is no way to collect that yet.
        When a shopper comes back, anything no longer for sale is left out and prices are brought up to date.
      </Notice>

      {summary.carts.length === 0 ? (
        <EmptyState icon={<Icon name="carts" size={20} />} title="No abandoned carts">
          Carts left for more than a day will appear here.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {summary.carts.map((cart) => (
              <li key={cart.id} className="px-4 py-4 sm:px-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                      {cart.itemCount} {cart.itemCount === 1 ? "item" : "items"}
                      <Pill>{cart.placedBy === "registered" ? "Registered customer" : "Guest"}</Pill>
                      {!cart.recoverable && <Pill tone="warning">Nothing left to buy</Pill>}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">Last changed {when(cart.updatedAt)} · deleted after {when(cart.expiresAt)}</p>
                  </div>
                  <p className="text-right">
                    <span className="block font-semibold tabular-nums text-slate-900">{formatPrice(cart.value, cart.currency)}</span>
                    <span className="block text-xs text-slate-500">at today&apos;s prices</span>
                  </p>
                </div>
                <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
                  {cart.lines.map((line, index) => (
                    <li key={index} className="break-words">
                      {line.quantity} × {line.name}
                      {line.variantLabel ? <span className="text-slate-500"> ({line.variantLabel})</span> : null}
                      {LINE_NOTE[line.status] ? <span className="text-xs text-amber-800"> · {LINE_NOTE[line.status]}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
