import Link from "next/link";
import { requireSuperAdminPage } from "@/lib/admin/page-access";
import { aiPlatformStatus } from "@/lib/ai-builder/provider";
import { billingConfig } from "@/lib/billing-razorpay";
import { isManualBillingAllowed } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { databaseSupportsTransactions } from "@/lib/db-capabilities";
import { env, isCustomerAccountsEnabled, isOrderOnlinePaymentsEnabled } from "@/lib/env";
import { integrationStatuses } from "@/lib/integration-status";
import { readPlatformSettingsState } from "@/lib/platform-settings";
import { registrationUnavailableReason } from "@/lib/platform-status";
import { FEATURE_LABELS, missingIndexes, type IndexedFeature } from "@/lib/required-indexes";
import { Plan } from "@/models/Plan";
import PlatformSettingsForm from "@/components/admin/PlatformSettingsForm";
import { Badge, Card, PageTitle, formatDate, linkClass, listClass } from "@/components/admin/ControlCenterUI";
import { Notice } from "@/components/ui/Surface";
import { formatPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

const FEATURES: IndexedFeature[] = ["subscription_billing", "team_invitations", "custom_domains", "customer_carts", "notifications", "order_refunds", "customer_accounts"];

function Status({ on, onLabel = "On", offLabel = "Off" }: { on: boolean; onLabel?: string; offLabel?: string }) {
  return <Badge value={on ? "active" : "inactive"} label={on ? onLabel : offLabel} />;
}

function Row({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <span className="min-w-0 flex-1 basis-56">
        <span className="font-medium text-slate-900">{label}</span>
        {note && <span className="block text-xs text-slate-500">{note}</span>}
      </span>
      {children}
    </li>
  );
}

/**
 * Platform settings. Only the first card can be changed here. Everything else is shown so
 * a Super Admin can see the platform's state: whether settings are present, never their
 * values. Integrations, live payments and production AI are changed in the environment.
 */
export default async function AdminSettingsPage() {
  await requireSuperAdminPage();
  await dbConnect();
  const [state, plans, readiness, transactions] = await Promise.all([
    readPlatformSettingsState(),
    Plan.find().sort({ sort: 1, price: 1 }).select("key name price currency interval active").lean(),
    Promise.all(FEATURES.map(async (feature) => ({ feature, missing: await missingIndexes(feature) }))),
    databaseSupportsTransactions(),
  ]);
  const ai = await aiPlatformStatus();
  const billing = billingConfig();
  const config = env();
  const { settings } = state;
  const unavailable = state.source === "unavailable";
  const registrationReason = registrationUnavailableReason({ registrationOpen: settings.registrationOpen, maintenance: { enabled: settings.maintenanceEnabled, message: settings.maintenanceMessage } });

  return (
    <div className="space-y-5">
      <PageTitle title="Platform settings" description="The settings you can change are in the form below, and each change is audited. The rest shows how the platform is set up. Secret values are never displayed." />

      {unavailable && (
        <Notice tone="warning" role="alert" title="The saved settings could not be read">
          The platform is using its last known values, or the defaults, until the database answers. Saving is off so nothing is overwritten. Reload this page to try again.
        </Notice>
      )}
      {!unavailable && settings.maintenanceEnabled && (
        <Notice tone="warning" role="status" title="Maintenance mode is on">
          New accounts, new stores and publishing are paused for everyone. Storefronts, checkout and payments keep working.
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card title="What people see now">
            <ul className={listClass}>
              <Row label="New accounts" note={registrationReason ?? "The registration page is open."}>
                <Status on={registrationReason === null} onLabel="Accepted" offLabel="Not accepted" />
              </Row>
              <Row label="Maintenance mode" note={settings.maintenanceEnabled ? settings.maintenanceMessage || "Showing the standard message." : undefined}>
                <Status on={settings.maintenanceEnabled} />
              </Row>
              <Row label="Support contact" note={settings.supportEmail ? undefined : "None set, so people are told to contact their platform administrator."}>
                {settings.supportEmail ? <span className="break-all text-[13px] text-slate-700">{settings.supportEmail}</span> : <Status on={false} offLabel="Not set" />}
              </Row>
            </ul>
            <p className="mt-3 text-xs text-slate-500">{state.updatedAt ? `Last changed ${formatDate(state.updatedAt, true)}.` : unavailable ? "Last change unknown." : "Never changed: these are the defaults."}</p>
          </Card>
          <Card title="General, registration and maintenance">
            <PlatformSettingsForm initial={settings} revision={state.revision} unavailable={unavailable} />
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Subscription plans" action={<Link href="/admin/plans" className={`text-[13px] ${linkClass}`}>Manage plans →</Link>}>
            <ul className={listClass}>
              {plans.map((plan) => (
                <Row key={plan.key} label={plan.name} note={plan.price === 0 ? "Free" : `${formatPrice(plan.price, plan.currency)} per ${plan.interval}`}>
                  <Status on={plan.active} onLabel="Offered" offLabel="Not offered" />
                </Row>
              ))}
            </ul>
          </Card>

          <Card title="Feature availability">
            <ul className={listClass}>
              <Row label="Customer accounts" note="CUSTOMER_ACCOUNTS_ENABLED. Needs its indexes first (docs/customer-accounts.md)."><Status on={isCustomerAccountsEnabled()} /></Row>
              <Row label="Online payments for store orders" note="ORDER_ONLINE_PAYMENTS_ENABLED. Live keys need separate approval."><Status on={isOrderOnlinePaymentsEnabled()} /></Row>
              <Row label="Manual plan activation" note="Always allowed outside production. In production, ALLOW_MANUAL_BILLING."><Status on={isManualBillingAllowed()} onLabel="Allowed" offLabel="Not allowed" /></Row>
              <Row label="AI suggestions" note="AI_PROVIDER_ENABLED and a key. Production needs separate approval, and each owner's consent."><Status on={ai.available} onLabel="Available" offLabel="Not available" /></Row>
            </ul>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Payment, email, storage and domain integrations">
          <ul className={listClass}>
            <Row label="Billing mode" note={`PAYMENT_PROVIDER is ${config.PAYMENT_PROVIDER}.`}>
              {billing ? <Badge value={billing.mode === "live" ? "active" : "pending"} label={billing.mode === "live" ? "Live keys" : "Test keys"} /> : <Badge value="inactive" label="Not online" />}
            </Row>
            {integrationStatuses().map((item) => (
              <Row key={item.key} label={item.label} note={item.note}>
                <Status on={item.configured} onLabel="Settings present" offLabel="Not set up" />
              </Row>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-5 text-slate-500">&quot;Settings present&quot; only means the values exist. It does not mean the provider has been reached or that the integration works.</p>
        </Card>

        <Card title="Database readiness">
          <ul className={listClass}>
            <li className="py-2">
              <p className="font-medium text-slate-900">
                Replica set (transactions) <Badge value={transactions === false ? "inactive" : transactions === null ? "pending" : "active"} label={transactions === false ? "Standalone: saving will fail" : transactions === null ? "Could not check" : "Ready"} />
              </p>
              {transactions === false && <p className="text-xs text-slate-600">Products, pages, team changes and orders need transactions. MongoDB must run as a replica set: see docs/database-preparation.md.</p>}
            </li>
            {readiness.map(({ feature, missing }) => (
              <li key={feature} className="py-2">
                <p className="font-medium text-slate-900">{FEATURE_LABELS[feature]} <Badge value={missing.length === 0 ? "active" : "inactive"} label={missing.length === 0 ? "Ready" : "Off until indexes exist"} /></p>
                {missing.map((item) => <p key={item} className="break-all font-mono text-xs text-slate-600">{item}</p>)}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-5 text-slate-500">Creating these indexes is an approved operation: see docs/database-preparation.md. Nothing on this page creates them.</p>
        </Card>
      </div>
      <p className="text-xs text-slate-500">Page generated {formatDate(new Date(), true)}.</p>
    </div>
  );
}
