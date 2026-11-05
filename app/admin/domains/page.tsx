import Link from "next/link";
import { DOMAIN_FILTERS, domainQuerySchema, listAdminDomains } from "@/lib/admin/domain-health";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import { certificateRenewalMode } from "@/lib/domains/certificates";
import { DOMAIN_WARNING_TEXT } from "@/lib/domains/health";
import { getScheduledJobStatus } from "@/lib/scheduled-jobs";
import {
  Badge,
  Card,
  EmptyRow,
  PageTitle,
  Pagination,
  TableCard,
  Td,
  Th,
  Tr,
  formatDate,
  hrefWith,
  linkClass,
  segmentClass,
  segmentedClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

const FILTER_LABELS: Record<(typeof DOMAIN_FILTERS)[number], string> = { all: "All", attention: "Needs attention" };

const RENEWAL_MODE_TEXT = {
  none: "No certificate integration is configured, so nothing is checked or renewed.",
  external: "The configured integration only inspects certificates. Renewal has to happen outside SiteForge.",
  managed: "The configured integration can issue and renew. SiteForge asks it to renew at each check when a certificate is close to expiring.",
};

export default async function AdminDomainsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSuperAdminPage();
  const params = singleParams(await searchParams);
  const query = domainQuerySchema.parse(params);
  const [list, job] = await Promise.all([listAdminDomains(query), getScheduledJobStatus("domain-health")]);
  const current = { filter: query.filter };

  return (
    <div className="space-y-5">
      <PageTitle title="Custom domains" description={`Read-only. Ownership, DNS, certificate and renewal state for each store's domain. ${RENEWAL_MODE_TEXT[certificateRenewalMode()]}`} />

      <div className={segmentedClass} role="tablist" aria-label="Filter domains">
        {DOMAIN_FILTERS.map((filter) => (
          <Link key={filter} role="tab" aria-selected={query.filter === filter} href={hrefWith("/admin/domains", {}, { filter })} className={segmentClass(query.filter === filter)}>
            {FILTER_LABELS[filter]}
          </Link>
        ))}
      </div>

      <TableCard
        label="Custom domains"
        head={
          <>
            <Th>Domain</Th>
            <Th>Business</Th>
            <Th>State</Th>
            <Th>Health</Th>
            <Th>Last DNS confirmed</Th>
            <Th>Last certificate confirmed</Th>
            <Th>Certificate expires</Th>
            <Th>Renewal</Th>
          </>
        }
      >
        {list.items.length === 0 ? (
          <EmptyRow colSpan={8} title="No domains here" />
        ) : (
          list.items.map((row) => (
            <Tr key={row.id}>
              <Td>
                <span className="break-all font-medium text-slate-900">{row.domain}</span>
                {row.health.warnings.map((warning) => (
                  <p key={warning} className="mt-0.5 text-xs text-slate-600">{DOMAIN_WARNING_TEXT[warning]}</p>
                ))}
              </Td>
              <Td><Link className={linkClass} href={`/admin/businesses/${row.businessId}`}>{row.businessName}</Link></Td>
              <Td><Badge value={row.lifecycle} /></Td>
              <Td><Badge value={row.health.status} /></Td>
              <Td>
                {formatDate(row.lastDnsOkAt, true)}
                {row.routingError && <p className="mt-0.5 text-xs text-slate-500">{row.routingError.replace(/_/g, " ")}</p>}
              </Td>
              <Td>
                {formatDate(row.lastCertificateOkAt, true)}
                {row.certificateError && <p className="mt-0.5 text-xs text-slate-500">{row.certificateError.replace(/_/g, " ")}</p>}
              </Td>
              <Td>{formatDate(row.certificateExpiresAt)}</Td>
              <Td>
                <Badge value={row.renewalStatus} />
                {row.renewalFailureCount > 0 && <p className="mt-0.5 text-xs text-red-700">{row.renewalFailureCount} failed{row.renewalLastError ? `: ${row.renewalLastError.replace(/_/g, " ")}` : ""}</p>}
              </Td>
            </Tr>
          ))
        )}
      </TableCard>
      <Pagination path="/admin/domains" params={current} page={list.page} pageSize={list.pageSize} total={list.total} />

      <Card title="Scheduled domain checks">
        {job.lastStartedAt ? (
          <p className="text-[13px] text-slate-700">
            Last run {formatDate(job.lastStartedAt, true)}: {job.lastOutcome ?? "not finished"}. {job.recent[0] ? `${job.recent[0].checked} checked, ${job.recent[0].skipped} skipped, ${job.recent[0].failed} failed.` : ""}
          </p>
        ) : (
          <p className="text-[13px] text-slate-600">No scheduled run has been recorded. Domains are only checked when an owner asks, until a scheduler is set up (docs/scheduled-jobs.md).</p>
        )}
      </Card>
    </div>
  );
}
