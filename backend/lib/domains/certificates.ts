import tls from "node:tls";

/**
 * The boundary between SiteForge and whatever provides TLS certificates (server-only).
 * No issuing provider ships with SiteForge. There are two kinds of integration:
 *
 * - `CertificateProvider` can only report on a certificate. Issuing and renewing happen
 *   elsewhere (at the ingress, for example), and SiteForge only watches the result.
 * - `ManagedCertificateProvider` can also issue and renew. Only with one of these does
 *   SiteForge ask for a renewal. None exists yet: add one and register it below.
 *
 * `CUSTOM_DOMAIN_CERT_PROVIDER` picks one by name. Without one, no new custom domain can
 * become active.
 */

/**
 * `issued`: a valid certificate was confirmed. `pending`: not ready yet. `failed`: a
 * definite problem. `unavailable`: no answer could be had, which says nothing about the
 * certificate, so a domain in service must stay in service.
 */
export type CertificateState = "pending" | "issued" | "failed" | "unavailable";

export interface CertificateStatus {
  state: CertificateState;
  /** The provider's own reference, if it has one. Never a key or private material. */
  ref?: string | null;
  expiresAt?: Date | null;
  /** A short reason code. */
  error?: string | null;
}

export interface CertificateProvider {
  readonly name: string;
  status(domain: string, ref: string | null): Promise<CertificateStatus>;
}

export interface ManagedCertificateProvider extends CertificateProvider {
  /** Starts issuing, or reports what already exists. May be called more than once. */
  issue(domain: string): Promise<CertificateStatus>;
  /** Starts a renewal, or reports one in progress. May be called more than once. */
  renew(domain: string, ref: string): Promise<CertificateStatus>;
}

export function isManagedCertificateProvider(provider: CertificateProvider): provider is ManagedCertificateProvider {
  const candidate = provider as Partial<ManagedCertificateProvider>;
  return typeof candidate.issue === "function" && typeof candidate.renew === "function";
}

const PROBE_TIMEOUT_MS = 8_000;
// The certificate presented is definitely not usable.
const DEFINITE_CERTIFICATE_FAILURES = new Set(["CERT_HAS_EXPIRED", "CERT_REVOKED"]);
// Something answered, with a certificate that is not for this name yet.
const NOT_READY_CERTIFICATE_ERRORS = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_NOT_YET_VALID",
]);

/**
 * Connects to the domain and asks whether it presents a certificate that verifies. It
 * issues and renews NOTHING. Callers only use it after DNS was confirmed to point at the
 * configured target, so it cannot be used to reach an address of the owner's choosing.
 * Only a status comes out of it.
 */
function probeCertificate(domain: string): Promise<CertificateStatus> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: true, timeout: PROBE_TIMEOUT_MS });
    const finish = (status: CertificateStatus) => {
      socket.destroy();
      resolve(status);
    };
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const expiresAt = certificate?.valid_to ? new Date(certificate.valid_to) : null;
      finish(socket.authorized ? { state: "issued", ref: null, expiresAt, error: null } : { state: "pending", error: "not_trusted" });
    });
    socket.once("timeout", () => finish({ state: "unavailable", error: "timeout" }));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const code = typeof error.code === "string" ? error.code.slice(0, 60) : "connection_failed";
      const state = DEFINITE_CERTIFICATE_FAILURES.has(code) ? "failed" : NOT_READY_CERTIFICATE_ERRORS.has(code) ? "pending" : "unavailable";
      finish({ state, error: code });
    });
  });
}

const tlsProbeProvider: CertificateProvider = {
  name: "tls_probe",
  status: (domain) => probeCertificate(domain),
};

const registry = new Map<string, CertificateProvider>([[tlsProbeProvider.name, tlsProbeProvider]]);

/** Adds an integration. Nothing uses it until `CUSTOM_DOMAIN_CERT_PROVIDER` names it. */
export function registerCertificateProvider(provider: CertificateProvider): void {
  registry.set(provider.name, provider);
}

export function certificateProvider(): CertificateProvider | null {
  const name = process.env.CUSTOM_DOMAIN_CERT_PROVIDER?.trim();
  return name ? registry.get(name) ?? null : null;
}

/**
 * Who renews certificates here, for honest wording: `none` means nothing is set up,
 * `external` means they are only watched, and `managed` means an integration is asked to.
 */
export type CertificateRenewalMode = "none" | "external" | "managed";

export function certificateRenewalMode(): CertificateRenewalMode {
  const provider = certificateProvider();
  if (!provider) return "none";
  return isManagedCertificateProvider(provider) ? "managed" : "external";
}
