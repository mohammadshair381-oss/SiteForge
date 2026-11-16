import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getEntitlements } from "@/lib/billing";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import SettingsForm from "@/components/dashboard/SettingsForm";
import PaymentSettings from "@/components/dashboard/PaymentSettings";
import { headers } from "next/headers";
import OnlinePaymentAccount from "@/components/dashboard/OnlinePaymentAccount";
import AiConsentCard from "@/components/dashboard/AiConsentCard";
import { loadAiConsentView } from "@/lib/ai-builder/consent";
import { env, isCustomerAccountsEnabled, isProduction } from "@/lib/env";
import MembersManager from "@/components/dashboard/MembersManager";
import { listInvitations, rolesInviterMayGrant } from "@/lib/team-invitations";
import { isFeatureReady } from "@/lib/required-indexes";
import DomainManager from "@/components/dashboard/DomainManager";
import ManagementPageHeader from "@/components/dashboard/ManagementPageHeader";
import DeleteBusinessCard from "@/components/dashboard/DeleteBusinessCard";

export const dynamic = "force-dynamic";

export default async function BusinessSettings({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  await dbConnect();

  const [business, entitlements, members] = await Promise.all([
    Business.findById(id).lean(),
    getEntitlements(id),
    Membership.find({ business: id }).populate("user", "name email").sort({ createdAt: 1 }).lean(),
  ]);
  if (!business) notFound();
  // Shown to the owner for their Razorpay webhook configuration.
  const host = (await headers()).get("host");
  const platformOrigin =
    env().APP_URL.trim().replace(/\/+$/, "") || (host ? `${isProduction() ? "https" : "http"}://${host}` : "");
  const webhookUrl = `${platformOrigin}/api/webhooks/razorpay/${id}`;

  const serializedMembers = members.map((member) => {
    const user = member.user as unknown as
      | { _id: unknown; name: string; email: string }
      | null;
    return {
      _id: String(member._id),
      role: member.role,
      status: member.status,
      user: user
        ? { _id: String(user._id), name: user.name, email: user.email }
        : null,
    };
  });

  const showAi = membership.role === "owner" || membership.role === "manager";
  // Only the business's primary owner may delete it (lib/business-deletion.ts checks this again).
  const canDelete = membership.role === "owner" && String(business.owner) === String(user._id);
  const sections = [
    { id: "settings-profile", label: "Business profile" },
    { id: "settings-payments", label: "Payments" },
    ...(showAi ? [{ id: "settings-ai", label: "AI suggestions" }] : []),
    { id: "settings-team", label: "Team" },
    { id: "settings-domain", label: "Domain" },
    ...(canDelete ? [{ id: "settings-delete", label: "Delete business" }] : []),
  ];

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Business settings"
        description={
          membership.role === "owner"
            ? "Update the details customers see, manage team access, and connect a custom domain when your plan supports it."
            : membership.role === "manager"
              ? "Update the business details customers see on your website."
              : "Review the business details customers see. Your role does not allow changes."
        }
      />
      <nav aria-label="Settings sections" className="ui-scroll-x flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg border bg-slate-100 p-0.5">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-white hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
          >
            {section.label}
          </a>
        ))}
      </nav>
      <div id="settings-profile" className="scroll-mt-44 lg:scroll-mt-32">
        <SettingsForm
          businessId={id}
          canManage={membership.role === "owner" || membership.role === "manager"}
          initial={{
            name: business.name,
            description: business.description,
            logoUrl: business.logoUrl,
            contactEmail: business.contactEmail,
            phone: business.phone,
            address: business.address,
            serviceArea: business.serviceArea ?? "",
            currency: business.currency,
          }}
        />
      </div>
      <div id="settings-payments" className="scroll-mt-44 space-y-6 lg:scroll-mt-32">
        <PaymentSettings
          businessId={id}
          canManage={membership.role === "owner"}
          initialCodEnabled={business.codEnabled === true}
          initialGuestCodEnabled={business.guestCodEnabled === true}
          accountsEnabled={isCustomerAccountsEnabled()}
        />
        {membership.role === "owner" && <OnlinePaymentAccount businessId={id} webhookUrl={webhookUrl} />}
      </div>
      {showAi && (
        <div id="settings-ai" className="scroll-mt-44 lg:scroll-mt-32">
          <AiConsentCard businessId={id} view={await loadAiConsentView(id, membership.role === "owner")} />
        </div>
      )}
      <div id="settings-team" className="scroll-mt-44 lg:scroll-mt-32">
        <MembersManager
          businessId={id}
          initialMembers={serializedMembers}
          canManage={membership.role === "owner"}
          initialInvitations={membership.role === "staff" ? [] : await listInvitations(id)}
          invitationsReady={await isFeatureReady("team_invitations")}
          inviteRoles={rolesInviterMayGrant(membership.role, business.managersCanInvite === true)}
          initialManagersCanInvite={business.managersCanInvite === true}
          staffLimit={entitlements.staffLimit}
          currentUserId={String(user._id)}
          primaryOwnerId={String(business.owner)}
        />
      </div>
      <div id="settings-domain" className="scroll-mt-44 lg:scroll-mt-32">
        <DomainManager
          businessId={id}
          canManage={membership.role === "owner"}
          customDomainEntitled={entitlements.customDomain}
        />
      </div>
      {canDelete && (
        <div id="settings-delete" className="scroll-mt-44 lg:scroll-mt-32">
          <DeleteBusinessCard businessId={id} businessName={business.name} />
        </div>
      )}
    </div>
  );
}
