import Link from "next/link";
import { getSecuritySummary, listSecurityEvents, securityQuerySchema, TARGETED_ACCOUNT_THRESHOLD, BUSY_SOURCE_THRESHOLD } from "@/lib/admin/security";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import { SECURITY_EVENT_REASONS, SECURITY_EVENT_TYPES } from "@/models/SecurityEvent";
import { Notice } from "@/components/ui/Surface";
import {
  Badge,
  Card,
  EmptyNote,
  EmptyRow,
  FilterActions,
  FilterBar,
  FilterField,
  PageTitle,
  Pagination,
  StatGrid,
  StatTile,
  TableCard,
  Td,
  Th,
  Tr,
  formatDate,
  inputClass,
  linkClass,
  listClass,
  monoClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  login_failed: "Failed sign-in",
  admin_login: "Super admin sign-in",
  admin_reauth_failed: "Admin password confirmation failed",
  customer_login_failed: "Failed customer sign-in",
  password_reset_requested: "Password reset requested",
  password_reset_failed: "Password reset refused",
  password_reset_completed: "Password reset completed",
  customer_session_revoked: "Revoked customer session used",
  platform_session_revoked: "Revoked platform session used",
  email_verification_failed: "Email verification refused",
  password_change_failed: "Password change: wrong current password",
};
const REASON_LABEL: Record<string, string> = {
  unknown_account: "no such account",
  wrong_password: "wrong password",
  inactive_account: "deactivated account",
  invalid_token: "invalid or expired link",
  reset_conflict: "account changed meanwhile",
  token_version_mismatch: "session was signed out",
  account_missing: "account no longer exists",
};
const BADGE_TONE: Record<string, string> = {
  login_failed: "pending",
  customer_login_failed: "pending",
  password_reset_failed: "pending",
  customer_session_revoked: "pending",
  admin_reauth_failed: "failed",
  admin_login: "verified",
  password_reset_completed: "verified",
  password_reset_requested: "draft",
  platform_session_revoked: "pending",
  email_verification_failed: "pending",
  password_change_failed: "pending",
};

export default async function AdminSecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSuperAdminPage();
  const query = securityQuerySchema.parse(singleParams(await searchParams));
  const [summary, list] = await Promise.all([getSecuritySummary(), listSecurityEvents(query)]);
  const current = { type: query.type, reason: query.reason, scope: query.scope, business: query.business, user: query.user, from: query.from, to: query.to };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Security monitoring"
        description={`Platform and storefront sign-in and password-reset events from the last ${list.retentionDays} days. Passwords, raw addresses and unknown emails are never stored: "Account" and "Source" are keyed fingerprints that group repeated attempts. Admin actions are in the audit log.`}
      />

      {(summary.targetedAccounts.length > 0 || summary.adminReauthFailures24h > 0 || summary.busySources.length > 0) && (
        <div className="space-y-2">
          {summary.adminReauthFailures24h > 0 && (
            <Notice tone="danger" role="alert">
              <strong className="font-semibold">Critical:</strong> {summary.adminReauthFailures24h} failed admin password confirmation(s) in the last 24 hours. If this was not
              you or another admin mistyping, sign that admin out everywhere and investigate.
            </Notice>
          )}
          {summary.targetedAccounts.length > 0 && (
            <Notice tone="warning">
              <strong className="font-semibold">Warning:</strong> {summary.targetedAccounts.length} account(s) had {TARGETED_ACCOUNT_THRESHOLD}+ failed sign-ins in the last hour.
            </Notice>
          )}
          {summary.busySources.length > 0 && (
            <Notice tone="warning">
              <strong className="font-semibold">Warning:</strong> {summary.busySources.length} source(s) had {BUSY_SOURCE_THRESHOLD}+ failed sign-ins in the last 24 hours.
            </Notice>
          )}
        </div>
      )}

      <StatGrid>
        <StatTile label="Failed sign-ins (1 h)" value={summary.failedLogins.lastHour} detail={`${summary.failedLogins.last24h} in 24 h · ${summary.failedLogins.last7d} in 7 days`} />
        <StatTile label="Super admin sign-ins (24 h)" value={summary.adminLogins24h} href="/admin/security?type=admin_login" />
        <StatTile label="Admin re-auth failures (24 h)" value={summary.adminReauthFailures24h} href="/admin/security?type=admin_reauth_failed" attention={summary.adminReauthFailures24h > 0} />
        <StatTile label="Targeted accounts (1 h)" value={summary.targetedAccounts.length} detail={`${TARGETED_ACCOUNT_THRESHOLD}+ failures each`} attention={summary.targetedAccounts.length > 0} />
        <StatTile label="Failed customer sign-ins (1 h)" value={summary.customerFailedLogins.lastHour} detail={`${summary.customerFailedLogins.last24h} in 24 h, all stores`} href="/admin/security?type=customer_login_failed" />
        <StatTile label="Password resets (24 h)" value={summary.passwordResets24h.requested} detail={`${summary.passwordResets24h.completed} completed · ${summary.passwordResets24h.failed} refused`} href="/admin/security?type=password_reset_failed" />
        <StatTile label="Revoked sessions used (24 h)" value={summary.revokedCustomerSessions24h + summary.revokedPlatformSessions24h} detail={`${summary.revokedPlatformSessions24h} platform · ${summary.revokedCustomerSessions24h} customer · once per account per 10 min`} href="/admin/security?type=platform_session_revoked" />
        <StatTile label="Verification / password-change refusals (24 h)" value={summary.emailVerificationFailures24h + summary.passwordChangeFailures24h} detail={`${summary.emailVerificationFailures24h} verification · ${summary.passwordChangeFailures24h} password change`} href="/admin/security?type=email_verification_failed" />
      </StatGrid>

      {(summary.targetedAccounts.length > 0 || summary.busySources.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Targeted accounts (last hour)">
            {summary.targetedAccounts.length === 0 ? <EmptyNote>None.</EmptyNote> : (
              <ul className={listClass}>
                {summary.targetedAccounts.map((t) => (
                  <li key={t.digest} className="flex flex-wrap justify-between gap-2 py-2">
                    <span className="min-w-0 break-words">
                      {t.scope === "storefront" ? (
                        <>Customer at {t.business ? <Link className={linkClass} href={`/admin/security?scope=storefront&business=${t.business.id}`}>{t.business.name}</Link> : "a store"} <code className={monoClass}>{t.digest}</code></>
                      ) : t.user ? (
                        <Link className={linkClass} href={`/admin/security?user=${t.user.id}`}>{t.user.name} · {t.user.email}</Link>
                      ) : (
                        <span>No such platform account <code className={monoClass}>{t.digest}</code></span>
                      )}
                    </span>
                    <span className="font-medium text-slate-900 [font-variant-numeric:tabular-nums]">{t.failures} failures</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Busy sources (last 24 hours)">
            {summary.busySources.length === 0 ? <EmptyNote>None.</EmptyNote> : (
              <ul className={listClass}>
                {summary.busySources.map((s) => (
                  <li key={s.digest} className="flex flex-wrap justify-between gap-2 py-2">
                    <code className={monoClass}>{s.digest}</code>
                    <span className="font-medium text-slate-900 [font-variant-numeric:tabular-nums]">{s.failures} failures · {s.distinctAccounts} account(s)</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <FilterBar className="sm:grid-cols-2 lg:grid-cols-5">
        <FilterField label="Event">
          <select name="type" defaultValue={query.type ?? ""} className={inputClass}>
            <option value="">Any</option>
            {SECURITY_EVENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </FilterField>
        <FilterField label="Reason">
          <select name="reason" defaultValue={query.reason ?? ""} className={inputClass}>
            <option value="">Any</option>
            {SECURITY_EVENT_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
          </select>
        </FilterField>
        <FilterField label="Where">
          <select name="scope" defaultValue={query.scope ?? ""} className={inputClass}>
            <option value="">Platform and storefronts</option>
            <option value="platform">Platform accounts</option>
            <option value="storefront">Storefront customers</option>
          </select>
        </FilterField>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={query.from ?? ""} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={query.to ?? ""} className={inputClass} />
        </FilterField>
        {query.user && <input type="hidden" name="user" value={query.user} />}
        {query.business && <input type="hidden" name="business" value={query.business} />}
        <FilterActions resetHref="/admin/security" className="sm:col-span-2 lg:col-span-5" />
      </FilterBar>

      <TableCard
        label="Security events"
        minWidth="min-w-[860px]"
        head={
          <>
            <Th>When (UTC)</Th>
            <Th>Event</Th>
            <Th>Account</Th>
            <Th>Account fingerprint</Th>
            <Th>Source fingerprint</Th>
          </>
        }
      >
        {list.events.length === 0 && (
          <EmptyRow colSpan={5} title="No security events match these filters.">Try a wider date range, or reset the filters.</EmptyRow>
        )}
        {list.events.map((e) => (
          <Tr key={e.id}>
            <Td className="whitespace-nowrap text-xs text-slate-500">{formatDate(e.createdAt, true)}</Td>
            <Td>
              <Badge value={BADGE_TONE[e.type] ?? "draft"} label={TYPE_LABEL[e.type] ?? e.type} />
              {e.reason && <span className="ml-2 text-xs text-slate-500">{REASON_LABEL[e.reason]}</span>}
            </Td>
            <Td>
              {e.scope === "storefront" ? (
                <span>
                  Customer{e.customerRef ? <code className="ml-1 font-mono text-xs">…{e.customerRef}</code> : null}
                  {e.business && (
                    <span className="block text-xs">
                      at <Link className={linkClass} href={`/admin/security?scope=storefront&business=${e.business.id}`}>{e.business.name}</Link>
                    </span>
                  )}
                </span>
              ) : e.user ? (
                <Link className={linkClass} href={`/admin/security?user=${e.user.id}`}>{e.user.name}</Link>
              ) : (
                <span className="text-slate-500">—</span>
              )}
            </Td>
            <Td><code className={monoClass}>{e.account ?? "—"}</code></Td>
            <Td><code className={monoClass}>{e.source ?? "—"}</code></Td>
          </Tr>
        ))}
      </TableCard>
      <Pagination path="/admin/security" params={current} page={list.page} pageSize={list.pageSize} total={list.total} />
    </div>
  );
}
