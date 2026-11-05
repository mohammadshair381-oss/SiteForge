"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/Button";
import { fieldErrorId, invalidProps } from "@/lib/api-errors";
import { DOMAIN_WARNING_TEXT, type DomainHealth } from "@/lib/domains/health";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Card, Notice, Pill, Skeleton, type Tone } from "@/components/ui/Surface";
import { confirmDialog } from "@/components/ui/ConfirmDialog";

type DomainStatus = "pending" | "verified" | "revoked";
type DomainLifecycle = "pending" | "failed" | "expired" | "verified" | "active" | "stale" | "revoked";

interface DomainEventRow {
  type: string;
  detail: string;
  at: string;
}

interface DomainRecord {
  domain: string;
  status: DomainStatus;
  lifecycle: DomainLifecycle;
  /** This is the domain the store has chosen. It serves only once `lifecycle` is `active`. */
  selected: boolean;
  health: DomainHealth;
  /** Verified before DNS and certificate checks existed, and still serving. */
  unconfirmed: boolean;
  lastDnsOkAt: string | null;
  lastCertificateOkAt: string | null;
  renewalStatus: string;
  renewalLastAttemptAt: string | null;
  renewalFailureCount: number;
  routingStatus: string;
  routingCheckedAt: string | null;
  routingError: string | null;
  certificateStatus: string;
  certificateCheckedAt: string | null;
  certificateExpiresAt: string | null;
  certificateError: string | null;
  activatedAt: string | null;
  events: DomainEventRow[];
  routingRecords: Array<{ type: string; name: string; value: string }>;
  verified: boolean;
  active: boolean;
  verifiedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  ownershipExpiresAt?: string | null;
  ownershipStale?: boolean;
  renewalPending?: boolean;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

interface DnsInstructions {
  type: string;
  name: string;
  value: string;
  ttl: number;
}

interface PendingPanel {
  domain: string;
  instructions: DnsInstructions;
  expiresAt: string | null;
}

const quietDangerClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Human-readable follow-up for a failed verification attempt. */
const VERIFY_ERROR_HINTS: Record<string, string> = {
  dns_not_found:
    "The TXT record is not visible yet. DNS changes can take a few minutes to propagate — keep the record in place and retry.",
  dns_mismatch:
    "A TXT record was found, but its value is different. Update it to the value shown above, then retry.",
  dns_lookup_failed:
    "The DNS lookup failed temporarily. Wait a few minutes and retry; your verification token stays valid.",
  invalid_token:
    "That token does not match the current verification request. Copy it from the TXT record again, or request a new token.",
  token_expired:
    "This verification request has expired. Request a new token to continue.",
  ownership_stale:
    "Ownership of this domain has to be re-verified before it can be used. Choose Renew ownership and add the new TXT record.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
};

const LIFECYCLE_BADGE: Record<DomainLifecycle, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  expired: { label: "Expired", tone: "warning" },
  verified: { label: "Verified", tone: "info" },
  active: { label: "Active", tone: "success" },
  stale: { label: "Re-verify", tone: "danger" },
  revoked: { label: "Removed", tone: "neutral" },
};

const EVENT_LABELS: Record<string, string> = {
  requested: "Verification requested",
  renewal_requested: "Ownership renewal requested",
  verified: "Ownership verified",
  verification_failed: "Ownership check did not pass",
  renewed: "Ownership renewed",
  selected: "Chosen for this store",
  routing_ok: "DNS points at SiteForge",
  routing_failed: "DNS does not point at SiteForge",
  certificate_pending: "Certificate not ready yet",
  certificate_issued: "Valid certificate confirmed",
  certificate_failed: "Certificate problem",
  certificate_renewal_started: "Certificate renewal started",
  certificate_renewed: "Certificate renewed",
  certificate_renewal_failed: "Certificate renewal did not work",
  check_unavailable: "A check could not be completed. Nothing was changed.",
  recovered: "Problem cleared",
  activated: "Domain became active",
  deactivated: "Domain stopped being active",
  removed: "Removed",
};

const ROUTING_TEXT: Record<string, string> = {
  ok: "Points at SiteForge.",
  failed: "Does not point at SiteForge yet.",
  unchecked: "Not checked yet.",
};

const CERTIFICATE_TEXT: Record<string, string> = {
  issued: "A valid certificate was confirmed.",
  pending: "Not ready yet. This can take a while after DNS changes.",
  failed: "There is a problem with the certificate.",
  not_configured: "This platform has no certificate setup yet.",
  not_started: "Checked once DNS points at SiteForge.",
};

const RENEWAL_TEXT: Record<string, string> = {
  not_due: "Not due yet.",
  due: "Due. It is requested at the next check.",
  in_progress: "In progress.",
  renewed: "Renewed.",
  failed: "The last request did not work. It is tried again at the next check.",
};

/** Never claims certificates renew by themselves unless an integration can actually do it. */
const RENEWAL_MODE_TEXT = {
  none: "No certificate setup yet, so nothing is renewed.",
  external: "Renewal happens outside SiteForge. SiteForge only watches the expiry date.",
  managed: "",
};

const shortDateTime = (value: string) => new Date(value).toLocaleString();

function expiryLabel(record: DomainRecord): string | null {
  if (record.status !== "pending") return null;
  if (!record.expiresAt) return null;
  return new Date(record.expiresAt).toLocaleString();
}

/** What SiteForge does for a custom domain today, and what it does not (AGENTS.md, "Known Partial Areas"). */
function AutomationNote() {
  return (
    <div className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
      <div>
        <p className="flex items-center gap-1.5 font-semibold text-slate-900">
          <Icon name="check" size={16} className="text-emerald-700" />
          SiteForge does this
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Checks that you own the domain with a DNS TXT record, asks you to re-verify before the proof runs out, and checks that the domain points here with a valid certificate before calling it active.
        </p>
      </div>
      <div>
        <p className="flex items-center gap-1.5 font-semibold text-slate-900">
          <Icon name="alert" size={16} className="text-amber-700" />
          Not automated yet
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          You create the DNS records with your DNS provider. SiteForge does not change your DNS, and it does not issue certificates itself.
          Verifying a domain does not make it reachable.
        </p>
      </div>
    </div>
  );
}

export default function DomainManager({
  businessId,
  canManage,
  customDomainEntitled,
}: {
  businessId: string;
  canManage: boolean;
  customDomainEntitled: boolean;
}) {
  const router = useRouter();
  const domainId = useId();
  const [domains, setDomains] = useState<DomainRecord[]>([]);
  const [currentCustomDomain, setCurrentCustomDomain] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ routingConfigured: boolean; certificatesConfigured: boolean; certificateRenewal: keyof typeof RENEWAL_MODE_TEXT; ready: boolean }>({ routingConfigured: false, certificatesConfigured: false, certificateRenewal: "none", ready: true });
  const [checking, setChecking] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busyDomain, setBusyDomain] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPanel | null>(null);
  const [verifyToken, setVerifyToken] = useState("");
  const [verifyErrorCode, setVerifyErrorCode] = useState<string | null>(null);
  const [clipboardError, setClipboardError] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const loadDomains = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/domains`);
      const data = (await res.json().catch(() => null)) as {
        domains?: DomainRecord[];
        currentCustomDomain?: string | null;
        routingConfigured?: boolean;
        certificatesConfigured?: boolean;
        certificateRenewal?: keyof typeof RENEWAL_MODE_TEXT;
        ready?: boolean;
        error?: string;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? "Unable to load domains");
        return;
      }
      setDomains(data?.domains ?? []);
      setCurrentCustomDomain(data?.currentCustomDomain ?? null);
      setSetup({ routingConfigured: data?.routingConfigured === true, certificatesConfigured: data?.certificatesConfigured === true, certificateRenewal: data?.certificateRenewal ?? "none", ready: data?.ready !== false });
    } catch {
      setError("Network error. Could not load domains.");
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  // Load on mount.
  useEffect(() => {
    void loadDomains();
  }, [loadDomains]);

  // Clear clipboard error after 3 seconds.
  useEffect(() => {
    if (clipboardError) {
      const timer = setTimeout(() => setClipboardError(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [clipboardError]);

  // "Copied" confirmation on the button clears itself.
  useEffect(() => {
    if (copiedValue === null) return;
    const timer = setTimeout(() => setCopiedValue(null), 2000);
    return () => clearTimeout(timer);
  }, [copiedValue]);

  /**
   * Requests (or re-requests) a verification token. Re-requesting is safe and
   * expected: a failed DNS check never consumes the previous token, and an
   * expired request can always be refreshed.
   */
  const startVerification = useCallback(
    async (rawDomain: string, renew = false) => {
      if (adding) return;
      const trimmed = rawDomain.trim();
      if (!trimmed) {
        setError("Enter a domain name.");
        return;
      }
      setAdding(true);
      setBusyDomain(trimmed);
      setError(null);
      setDomainError(null);
      setNotice(null);
      setPending(null);
      setVerifyToken("");
      setVerifyErrorCode(null);
      try {
        const res = await fetch(`/api/businesses/${businessId}/domains`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(renew ? { domain: trimmed, renew: true } : { domain: trimmed }),
        });
        const data = (await res.json().catch(() => null)) as {
          domain?: string;
          instructions?: DnsInstructions;
          expiresAt?: string;
          error?: string;
          code?: string;
        } | null;
        if (!res.ok) {
          const message = data?.error ?? "Unable to request domain verification";
          // A problem with the name itself belongs beside the field.
          if (!renew && ["domain_required", "invalid_domain", "reserved_domain", "domain_in_use", "domain_already_verified"].includes(data?.code ?? "")) setDomainError(message);
          else setError(message);
          setVerifyErrorCode(data?.code ?? null);
          return;
        }
        const requested = data?.domain ?? trimmed;
        setDomainInput(requested);
        setPending({
          domain: requested,
          instructions: data?.instructions ?? {
            type: "TXT",
            name: `_siteforge-verification.${requested}`,
            value: "",
            ttl: 300,
          },
          expiresAt: data?.expiresAt ?? null,
        });
        setNotice(
          renew
            ? "Renewal requested. Your domain keeps working while you add the new DNS TXT record shown below, then click Verify."
            : "Verification requested. Create the DNS TXT record shown below, then click Verify.",
        );
        await loadDomains();
      } catch {
        setError("Network error. Verification was not requested.");
      } finally {
        setAdding(false);
        setBusyDomain(null);
      }
    },
    [adding, businessId, loadDomains],
  );

  async function requestVerification(event: React.FormEvent) {
    event.preventDefault();
    await startVerification(domainInput);
  }

  async function verifyDomain() {
    if (verifying || !pending) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    setVerifyErrorCode(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/domains/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: pending.domain, token: verifyToken }),
      });
      const data = (await res.json().catch(() => null)) as {
        domain?: string;
        verified?: boolean;
        previousDomain?: string | null;
        renewed?: boolean;
        error?: string;
        code?: string;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? "Verification failed");
        setVerifyErrorCode(data?.code ?? null);
        return;
      }
      const verifiedDomain = data?.domain ?? pending.domain;
      setNotice(
        data?.renewed
          ? `Ownership of ${verifiedDomain} was re-verified.`
          : data?.previousDomain
          ? `You own ${verifiedDomain}, and it is now this store's domain instead of ${data.previousDomain}. It becomes active once DNS and the certificate are confirmed.`
          : `You own ${verifiedDomain}. It becomes active once DNS and the certificate are confirmed.`,
      );
      setPending(null);
      setVerifyToken("");
      await loadDomains();
      router.refresh();
    } catch {
      setError("Network error. Verification could not be completed.");
    } finally {
      setVerifying(false);
    }
  }

  /** Switches the active domain to an already-verified one (no new DNS proof). */
  async function activateDomain(domain: string) {
    if (verifying) return;
    setVerifying(true);
    setBusyDomain(domain);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/domains/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = (await res.json().catch(() => null)) as {
        previousDomain?: string | null;
        error?: string;
        code?: string;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? "Unable to choose that domain");
        return;
      }
      setNotice(
        data?.previousDomain
          ? `${domain} is now this store's domain instead of ${data.previousDomain}. It becomes active once DNS and the certificate are confirmed.`
          : `${domain} is now this store's domain. It becomes active once DNS and the certificate are confirmed.`,
      );
      await loadDomains();
      router.refresh();
    } catch {
      setError("Network error. The domain was not changed.");
    } finally {
      setVerifying(false);
      setBusyDomain(null);
    }
  }

  /** Asks the server to check DNS and the certificate. Only it can make a domain active. */
  async function checkActivation(domain: string) {
    if (checking) return;
    setChecking(domain);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/domains/activation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = (await res.json().catch(() => null)) as { active?: boolean; routingStatus?: string; certificateStatus?: string; health?: DomainHealth; error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "The check could not be completed");
        return;
      }
      setNotice(
        data?.active && data.health?.status !== "healthy"
          ? `${domain} stays active, but there is something to look at below.`
          : data?.active
          ? `${domain} is active: DNS and the certificate are confirmed.`
          : data?.routingStatus === "not_configured"
            ? "Nothing changed: this platform has no address for custom domains to point at yet."
            : `${domain} is not active yet. See what is still needed below.`,
      );
      await loadDomains();
      router.refresh();
    } catch {
      setError("Network error. The check could not be completed.");
    } finally {
      setChecking(null);
    }
  }

  async function removeDomain(domain: string) {
    if (removing) return;
    setRemoving(true);
    setBusyDomain(domain);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/domains`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        wasActive?: boolean;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? "Unable to remove domain");
        return;
      }
      setNotice(
        data?.wasActive
          ? `Domain ${domain} removed. This domain no longer serves your storefront.`
          : `Domain ${domain} removed.`,
      );
      if (pending?.domain === domain) {
        setPending(null);
        setVerifyToken("");
        setVerifyErrorCode(null);
      }
      await loadDomains();
      router.refresh();
    } catch {
      setError("Network error. The domain was not removed.");
    } finally {
      setRemoving(false);
      setBusyDomain(null);
    }
  }

  function copyToClipboard(text: string) {
    if (!navigator.clipboard) {
      setClipboardError(true);
      setTimeout(() => setClipboardError(false), 3000);
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setClipboardError(false);
        setCopiedValue(text);
      })
      .catch(() => {
        setClipboardError(true);
        setTimeout(() => setClipboardError(false), 3000);
      });
  }

  if (!customDomainEntitled) {
    return (
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              Custom domain
              <Pill>
                <Icon name="lock" size={12} />
                Not on your plan
              </Pill>
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Your current plan does not include custom domains. Upgrade your
              subscription to add a custom domain.
            </p>
          </div>
          {canManage && (
            <ButtonLink href={`/dashboard/businesses/${businessId}/billing`} variant="secondary">
              Compare plans
            </ButtonLink>
          )}
        </div>
      </Card>
    );
  }

  const dnsRows = pending
    ? [
        { label: "Type", value: pending.instructions.type, copy: false },
        { label: "Name", value: pending.instructions.name, copy: true },
        { label: "Value", value: pending.instructions.value, copy: true },
        { label: "TTL", value: String(pending.instructions.ttl), copy: false },
      ]
    : [];

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <Notice tone={error ? "danger" : "success"} role={error ? "alert" : "status"}>
          {error ?? notice}
        </Notice>
      )}
      {clipboardError && (
        <Notice tone="warning" role="alert">
          Could not copy to clipboard. Please copy the value manually.
        </Notice>
      )}

      <Card className="p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Custom domain</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Connect your own domain to this business in three steps: prove you own it with a DNS TXT record, point it at
          SiteForge, and have a valid certificate confirmed. Only then is it active. A store has one domain at a time, and a
          domain can belong to only one store.
        </p>

        <AutomationNote />

        {!setup.ready && (
          <Notice tone="warning" className="mt-4">
            Custom domains are not switched on yet, because a database step has not been done.
          </Notice>
        )}

        {/* Loading state */}
        {loading && (
          <div className="mt-4 space-y-2">
            <p role="status" className="sr-only">Loading domains…</p>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}

        {/* Current domains */}
        {!loading && domains.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100">
            {domains.map((d) => {
              const expired =
                d.status === "pending" &&
                !!d.expiresAt &&
                new Date(d.expiresAt) <= new Date();
              const hint = d.lastError ? VERIFY_ERROR_HINTS[d.lastError] : null;
              const stale = d.status === "verified" && d.ownershipStale;
              const badge = LIFECYCLE_BADGE[d.lifecycle] ?? LIFECYCLE_BADGE.pending;
              const showChecks = d.status === "verified" && d.selected && !stale;

              return (
                <li key={d.domain} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 basis-60">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                        <span className="min-w-0 break-all">{d.domain}</span>
                        <Pill tone={badge.tone} dot>{badge.label}</Pill>
                        {(d.health.status === "degraded" || d.health.status === "unhealthy") && (
                          <Pill tone={d.health.status === "unhealthy" ? "danger" : "warning"}>Needs attention</Pill>
                        )}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {stale
                          ? "Ownership proof expired — this domain is not serving until you renew it."
                          : d.lifecycle === "active" && d.health.status === "healthy"
                            ? "Active: you own this domain, it points at SiteForge, and a valid certificate was confirmed."
                            : d.lifecycle === "active"
                            ? "Active, but see what needs attention below."
                            : d.unconfirmed
                            ? "Verified: you own this domain and it keeps working as before, but its DNS and certificate have not been confirmed."
                            : d.lifecycle === "failed" && d.status === "verified"
                              ? "You own this domain, but the last check found a problem. See below."
                              : d.status === "verified" && d.selected
                                ? "Verified: you own this domain and it is your store's choice, but it is not active yet."
                                : d.status === "verified"
                                  ? "Verified, but another domain is your store's choice."
                                  : expired
                                    ? "Verification request expired."
                                    : d.lifecycle === "failed"
                                      ? "Failed: the last verification attempt did not succeed. You can try again."
                                      : "Pending verification."}
                      </p>
                      {d.status === "verified" && !d.ownershipStale && d.ownershipExpiresAt && (
                        <p className="mt-1 text-xs text-slate-500">
                          Ownership must be re-verified by{" "}
                          {new Date(d.ownershipExpiresAt).toLocaleDateString()}
                        </p>
                      )}
                      {d.status === "pending" && expiryLabel(d) && (
                        <p className="mt-1 text-xs text-slate-500">
                          Token expires {expiryLabel(d)}
                        </p>
                      )}
                      {hint && d.status === "pending" && (
                        <p className="mt-1 text-xs text-amber-800">{hint}</p>
                      )}
                      {d.health.warnings.length > 0 && (
                        <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-800">
                          {d.health.warnings.map((warning) => (
                            <li key={warning}>{DOMAIN_WARNING_TEXT[warning]}</li>
                          ))}
                        </ul>
                      )}
                      {showChecks && (
                        <dl className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
                          <div>
                            <dt className="inline font-medium text-slate-800">DNS: </dt>
                            <dd className="inline">
                              {setup.routingConfigured ? ROUTING_TEXT[d.routingStatus] ?? ROUTING_TEXT.unchecked : "This platform has no address for custom domains to point at yet."}
                              {d.routingCheckedAt ? ` Checked ${shortDateTime(d.routingCheckedAt)}.` : ""}
                              {d.lastDnsOkAt ? ` Last confirmed ${shortDateTime(d.lastDnsOkAt)}.` : ""}
                            </dd>
                          </div>
                          <div>
                            <dt className="inline font-medium text-slate-800">Certificate: </dt>
                            <dd className="inline">
                              {setup.certificatesConfigured ? CERTIFICATE_TEXT[d.certificateStatus] ?? CERTIFICATE_TEXT.not_started : CERTIFICATE_TEXT.not_configured}
                              {d.certificateExpiresAt ? ` Expires ${new Date(d.certificateExpiresAt).toLocaleDateString()}.` : ""}
                              {d.lastCertificateOkAt ? ` Last confirmed ${shortDateTime(d.lastCertificateOkAt)}.` : ""}
                            </dd>
                          </div>
                          <div>
                            <dt className="inline font-medium text-slate-800">Renewal: </dt>
                            <dd className="inline">
                              {RENEWAL_MODE_TEXT[setup.certificateRenewal] || RENEWAL_TEXT[d.renewalStatus] || RENEWAL_TEXT.not_due}
                              {d.renewalFailureCount > 0 && d.renewalLastAttemptAt ? ` Last attempt ${shortDateTime(d.renewalLastAttemptAt)}.` : ""}
                            </dd>
                          </div>
                        </dl>
                      )}
                      {showChecks && d.lifecycle !== "active" && d.routingRecords.length > 0 && (
                        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                          <p className="font-medium text-slate-800">Create one of these with your DNS provider:</p>
                          <ul className="mt-1 space-y-0.5 font-mono text-slate-700">
                            {d.routingRecords.map((record) => (
                              <li key={`${record.type}-${record.value}`} className="break-all">{record.type} {record.name} → {record.value}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {d.events.length > 0 && (
                        <details className="mt-2 text-xs text-slate-600">
                          <summary className="inline-flex min-h-10 cursor-pointer select-none items-center rounded font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
                            History
                          </summary>
                          <ul className="mt-1 space-y-0.5">
                            {d.events.map((event) => (
                              <li key={`${event.type}-${event.at}`}>{shortDateTime(event.at)}: {EVENT_LABELS[event.type] ?? event.type}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {canManage && showChecks && (
                        <Button
                          variant="secondary"
                          onClick={() => void checkActivation(d.domain)}
                          disabled={checking !== null || adding || removing || verifying}
                        >
                          {checking === d.domain ? "Checking…" : "Check DNS and certificate"}
                        </Button>
                      )}
                      {canManage && d.status === "pending" && (
                        <Button
                          variant="secondary"
                          onClick={() => void startVerification(d.domain)}
                          disabled={adding || removing || verifying}
                        >
                          {busyDomain === d.domain && adding ? "Requesting…" : "Get new token"}
                        </Button>
                      )}
                      {canManage && d.status === "verified" && (
                        <Button
                          variant="secondary"
                          onClick={() => void startVerification(d.domain, true)}
                          disabled={adding || removing || verifying}
                        >
                          {busyDomain === d.domain && adding ? "Requesting…" : "Renew ownership"}
                        </Button>
                      )}
                      {canManage && d.status === "verified" && !d.active && !d.ownershipStale && (
                        <Button
                          variant="secondary"
                          onClick={() => void activateDomain(d.domain)}
                          disabled={adding || removing || verifying}
                        >
                          {busyDomain === d.domain && verifying ? "Saving…" : "Use for this store"}
                        </Button>
                      )}
                      {canManage && (
                        <button
                          type="button"
                          onClick={async () => {
                            const confirmed = await confirmDialog({ title: `Remove ${d.domain}?`, message: "This domain stops being linked to your store immediately. You can add it again later, but you will need to verify it again.", confirmLabel: "Remove domain", tone: "danger" });
                            if (confirmed) void removeDomain(d.domain);
                          }}
                          disabled={removing}
                          className={quietDangerClass}
                        >
                          {busyDomain === d.domain && removing ? "Removing…" : "Remove"}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {!loading && domains.length === 0 && !pending && (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">No custom domains configured yet.</p>
        )}

        {/* Current active domain indicator */}
        {!loading && currentCustomDomain && (
          <Notice tone="info" className="mt-4">
            Domain chosen for this store: <strong className="break-all">{currentCustomDomain}</strong>
            {domains.find((item) => item.domain === currentCustomDomain)?.lifecycle === "active" ? " (active)" : " (not active yet)"}
          </Notice>
        )}

        {/* Domain request form */}
        {canManage && !pending && (
          <form onSubmit={requestVerification} className="mt-6 border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">Add a custom domain</h3>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label htmlFor={domainId} className={labelClass}>
                  Domain name
                </label>
                <input
                  id={domainId}
                  required
                  value={domainInput}
                  onChange={(e) => { setDomainInput(e.target.value); setDomainError(null); }}
                  placeholder="example.com"
                  className={inputClass}
                  {...invalidProps({ domain: domainError ?? undefined }, "domain", "custom-domain")}
                />
                <FieldError id={fieldErrorId("custom-domain", "domain")} message={domainError} />
              </div>
              <Button type="submit" disabled={adding || !setup.ready} className="w-full sm:w-auto">
                {adding ? "Requesting…" : "Request verification"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Enter a bare hostname (e.g. example.com). Do not include http://,
              paths, or query strings.
            </p>
          </form>
        )}

        {/* Pending verification: DNS instructions */}
        {pending && (
          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
            <h3 className="break-all text-base font-semibold text-slate-900">
              Verify {pending.domain}
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Create the following DNS TXT record with your DNS provider, then
              click &ldquo;Verify&rdquo; below.
            </p>
            <dl className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white text-sm">
              {dnsRows.map((row) => (
                <div key={row.label} className="grid gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:items-center">
                  <dt className="text-xs font-medium text-slate-500">{row.label}</dt>
                  <dd className="min-w-0 break-all font-mono text-slate-900">{row.value}</dd>
                  {row.copy && (
                    <dd>
                      <Button variant="secondary" onClick={() => copyToClipboard(row.value)} aria-label={`Copy ${row.label.toLowerCase()}`}>
                        {copiedValue === row.value ? "Copied" : "Copy"}
                      </Button>
                    </dd>
                  )}
                </div>
              ))}
            </dl>

            <div className="mt-4">
              <label htmlFor="verify-token" className={labelClass}>
                Verification token (from the DNS record value)
              </label>
              <input
                id="verify-token"
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                placeholder="Paste the token from the DNS record"
                className={inputClass}
              />
            </div>

            {verifyErrorCode && VERIFY_ERROR_HINTS[verifyErrorCode] && (
              <Notice tone="danger" role="alert" className="mt-3">
                {VERIFY_ERROR_HINTS[verifyErrorCode]}
              </Notice>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={verifyDomain} disabled={verifying}>
                {verifying ? "Verifying…" : "Verify domain"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setPending(null);
                  setVerifyToken("");
                  setVerifyErrorCode(null);
                  setError(null);
                  setNotice(null);
                }}
              >
                Cancel
              </Button>
            </div>
            {pending.expiresAt && new Date(pending.expiresAt) <= new Date() && (
              <p className="mt-3 text-sm font-medium text-red-700">
                This verification request has expired. Request a new token to
                continue.
              </p>
            )}
            <p className="mt-3 text-xs leading-5 text-slate-600">
              DNS changes can take a few minutes to propagate. A failed check
              does not use up your token — you can retry right here. TXT
              verification only proves you control the domain. After that, the
              domain still has to point at SiteForge and have a valid certificate
              before it becomes active.
            </p>
          </div>
        )}

        {!canManage && (
          <Notice tone="info" className="mt-4">
            Only business owners can manage custom domains.
          </Notice>
        )}
      </Card>
    </div>
  );
}
