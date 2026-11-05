import { dbConnect } from "@/lib/db";
import { requireSuperAdminPage } from "@/lib/admin/page-access";
import { Plan } from "@/models/Plan";
import AdminPanel from "@/components/admin/AdminPanel";
import { PageTitle } from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

export default async function AdminPlansPage() {
  await requireSuperAdminPage();
  await dbConnect();
  const plans = await Plan.find().sort({ sort: 1, price: 1 }).lean();

  return (
    <div className="space-y-5">
      <PageTitle
        title="Plans and entitlements"
        description="Limits are enforced on the server (lib/billing.ts) for every business on the plan. Every change is recorded in the audit log. Paid plans charge through Razorpay once online billing is configured and the plan is set up there; until then, prices here charge nobody."
      />
      <AdminPanel
        sections={["plans"]}
        initialBusinesses={[]}
        initialPlans={plans.map((plan) => ({
          key: plan.key,
          name: plan.name,
          description: plan.description,
          price: plan.price,
          currency: plan.currency,
          interval: plan.interval,
          active: plan.active,
          sort: plan.sort,
          features: {
            productLimit: plan.features.productLimit,
            staffLimit: plan.features.staffLimit,
            customDomain: plan.features.customDomain,
            removeBranding: plan.features.removeBranding,
            aiRequestsPerMonth: plan.features.aiRequestsPerMonth,
            themes: plan.features.themes,
            pageLimit: plan.features.pageLimit ?? null,
            storageMb: plan.features.storageMb ?? null,
            monthlyOrderLimit: plan.features.monthlyOrderLimit ?? null,
          },
        }))}
      />
    </div>
  );
}
