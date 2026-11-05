import Link from "next/link";
import { BUSINESS_STATUSES, SUBSCRIPTION_STATUSES } from "@/lib/constants";
import { dbConnect } from "@/lib/db";
import { getPlatformSettings } from "@/lib/platform-settings";
import { Notice } from "@/components/ui/Surface";
import { Plan } from "@/models/Plan";
import { businessQuerySchema, listAdminBusinesses } from "@/lib/admin/control-center";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import BusinessStatusAction from "@/components/admin/BusinessStatusAction";
import {
  Badge,
  EmptyRow,
  FilterActions,
  FilterBar,
  FilterField,
  PageTitle,
  Pagination,
  SearchField,
  TableCard,
  Td,
  Th,
  Tr,
  formatDate,
  inputClass,
  linkClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

export default async function AdminBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSuperAdminPage();
  const params = singleParams(await searchParams);
  const query = businessQuerySchema.parse(params);
  const result = await listAdminBusinesses(query);
  await dbConnect();
  const [plans, platform] = await Promise.all([Plan.find().sort({ sort: 1, price: 1 }).select("key name").lean(), getPlatformSettings()]);
  const current = { q: query.q, status: query.status, subscription: query.subscription, entitled: query.entitled, publishable: query.publishable, plan: query.plan, domain: query.domain, sort: query.sort === "newest" ? undefined : query.sort };

  return (
    <div className="space-y-5">
      <PageTitle title="Businesses" description="Search by business name, subdomain, custom domain, or owner name/email. Subscription status is what is stored. Feature access and Can publish come from the rules the rest of SiteForge uses, including expiry, grace periods, suspension, and whether an owner or manager is able to publish." />
      {result.capped && <Notice tone="info" role="status">This search stopped after looking through 20,000 stores. Narrow it with a name or status to see the rest.</Notice>}
      {platform.maintenanceEnabled && <Notice tone="warning" role="status">Maintenance mode is on, so publishing is paused for every store, whatever the Can publish column says.</Notice>}

      <FilterBar className="sm:grid-cols-2 lg:grid-cols-4">
        <SearchField label="Search" name="q" defaultValue={query.q ?? ""} maxLength={100} placeholder="Name, subdomain, owner…" className="sm:col-span-2" />
        <FilterField label="Status">
          <select name="status" defaultValue={query.status ?? ""} className={inputClass}>
            <option value="">Any</option>
            {BUSINESS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </FilterField>
        <FilterField label="Subscription">
          <select name="subscription" defaultValue={query.subscription ?? ""} className={inputClass}>
            <option value="">Any</option>
            {SUBSCRIPTION_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </FilterField>
        <FilterField label="Feature access">
          <select name="entitled" defaultValue={query.entitled ?? ""} className={inputClass}>
            <option value="">Any</option>
            <option value="1">Has access</option>
            <option value="0">No access</option>
          </select>
        </FilterField>
        <FilterField label="Can publish">
          <select name="publishable" defaultValue={query.publishable ?? ""} className={inputClass}>
            <option value="">Any</option>
            <option value="1">Eligible</option>
            <option value="0">Not eligible</option>
          </select>
        </FilterField>
        <FilterField label="Plan">
          <select name="plan" defaultValue={query.plan ?? ""} className={inputClass}>
            <option value="">Any</option>
            {plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Custom domain">
          <select name="domain" defaultValue={query.domain ?? ""} className={inputClass}>
            <option value="">Any</option>
            <option value="yes">Has a domain</option>
            <option value="no">No domain</option>
          </select>
        </FilterField>
        <FilterField label="Sort">
          <select name="sort" defaultValue={query.sort} className={inputClass}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name</option>
          </select>
        </FilterField>
        <FilterActions resetHref="/admin/businesses" className="sm:col-span-2 lg:col-span-1" />
      </FilterBar>

      <TableCard
        label="Businesses"
        minWidth="min-w-[1320px]"
        head={
          <>
            <Th>Business</Th>
            <Th>Owner</Th>
            <Th>Status</Th>
            <Th>Subscription</Th>
            <Th>Feature access</Th>
            <Th>Can publish</Th>
            <Th>Custom domain</Th>
            <Th right>Products</Th>
            <Th right>Orders</Th>
            <Th>Last order</Th>
            <Th>Created</Th>
            <Th>Action</Th>
          </>
        }
      >
        {result.businesses.length === 0 && (
          <EmptyRow colSpan={12} title="No businesses match these filters.">Try a different search, or reset the filters.</EmptyRow>
        )}
        {result.businesses.map((b) => (
          <Tr key={b.id}>
            <Td>
              <Link href={`/admin/businesses/${b.id}`} className={linkClass}>{b.name}</Link>
              <p className="text-xs text-slate-500">{b.subdomain}</p>
            </Td>
            <Td className="text-slate-600">{b.owner ? <>{b.owner.name}<span className="block text-xs text-slate-500">{b.owner.email}</span></> : "—"}</Td>
            <Td>
              <Badge value={b.status} />
              {b.publishedAt && <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">Published {formatDate(b.publishedAt)}</p>}
            </Td>
            <Td>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {b.plan ? b.plan.name : <span className="text-slate-500">None</span>}
                {b.subscriptionStatus && (b.subscriptionExpired ? <Badge value="expired" /> : <Badge value={b.subscriptionStatus} />)}
              </span>
              {b.provider && <p className="mt-0.5 text-xs text-slate-500">via {b.provider}</p>}
              {b.graceUntil && <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">Grace until {formatDate(b.graceUntil)}</p>}
              {b.manualPlanNowDisabled && <p className="mt-0.5 text-xs text-slate-500">Set by hand; manual billing is now off, so it runs until it ends</p>}
            </Td>
            <Td>
              <Badge value={b.access.featureAccess ? "active" : "inactive"} label={b.access.featureAccess ? "Yes" : "No"} />
              <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">{b.access.storeOnline ? "Store online" : "Store offline"}</p>
            </Td>
            <Td>
              <Badge value={b.access.publishEligible ? "active" : "inactive"} label={b.access.publishEligible ? "Eligible" : "Not eligible"} />
              {b.access.blockers.map((blocker) => <p key={blocker} className="mt-0.5 text-xs text-slate-500">{blocker}</p>)}
            </Td>
            <Td className="break-all text-slate-600">
              {b.customDomain ?? <span className="text-slate-500">None</span>}
              {b.domainNotInPlan && <p className="mt-0.5 break-normal text-xs text-slate-500">Not in this plan, so not serving</p>}
            </Td>
            <Td right>{b.productCount}</Td>
            <Td right>{b.orderCount}</Td>
            <Td className="whitespace-nowrap text-slate-500">{b.lastOrderAt ? formatDate(b.lastOrderAt) : "None"}</Td>
            <Td className="whitespace-nowrap text-slate-500">{formatDate(b.createdAt)}</Td>
            <Td><BusinessStatusAction business={{ id: b.id, name: b.name, status: b.status }} /></Td>
          </Tr>
        ))}
      </TableCard>
      <Pagination path="/admin/businesses" params={current} page={result.page} pageSize={result.pageSize} total={result.total} hasMore={result.hasMore} />
    </div>
  );
}
