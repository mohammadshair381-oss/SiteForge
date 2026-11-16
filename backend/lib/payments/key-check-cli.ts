import { adoptPaymentKey, paymentKeyReport, type AdoptionRefusal, type PaymentKeyReport, type PaymentKeyState } from "@/lib/payments/key-check";

/**
 * `npm run payment-key-check` (backend/scripts/payment-key-check.ts). Kept here, apart from the
 * script's environment loading, so it can be tested. It prints only the state, the configured key's
 * fingerprint, the record's fingerprint and a COUNT of accounts with encrypted secrets: never a key,
 * a credential or a ciphertext. Exactly two commands exist; anything else is refused.
 *
 *   status
 *   adopt --expected-fingerprint <16 hex characters from the key escrow>
 *
 * Adoption is an approved operator action: staging first, production separately
 * (docs/payments-architecture.md, "Payment key check").
 */

export const USAGE = [
  "Usage:",
  "  npm run payment-key-check -- status",
  "  npm run payment-key-check -- adopt --expected-fingerprint <16 hex characters from the key escrow>",
].join("\n");

const STATE_NOTES: Record<PaymentKeyState, string> = {
  unconfigured: "PAYMENT_CREDENTIALS_KEY is missing or invalid: online payment features are off.",
  verified: "The configured key opens the check record.",
  mismatch: "The configured key does NOT open the check record: payment operations are paused. Restore the original key from escrow.",
  check_unreadable: "The check record exists but cannot be read: payment operations are paused. Do not delete it; investigate.",
  no_check_no_data: "No check record and no encrypted payment secrets: the first account connection will create the record.",
  unverified_legacy: "Encrypted payment secrets exist but no check record: adopt the key with its escrow fingerprint.",
  unknown: "The database could not be read. Nothing was changed. Try again.",
};

const REFUSALS: Record<AdoptionRefusal, string> = {
  invalid_expected_fingerprint: "Refused: --expected-fingerprint must be the 16 hex characters recorded with the key escrow.",
  unconfigured: "Refused: PAYMENT_CREDENTIALS_KEY is missing or invalid.",
  database_unavailable: "Refused: the database could not be read or written. Nothing was changed.",
  record_exists: "Refused: a check record already exists. It is never replaced.",
  fingerprint_mismatch: "Refused: the configured key's fingerprint differs from the escrow fingerprint. Nothing was changed.",
};

function describe(report: PaymentKeyReport, out: (line: string) => void): void {
  out(`state: ${report.state}`);
  out(`  ${STATE_NOTES[report.state]}`);
  out(`configured key fingerprint: ${report.configuredFingerprint ?? "none"}`);
  out(`check record fingerprint: ${report.expectedFingerprint ?? "none"}`);
  out(`encrypted payment accounts: ${report.encryptedAccounts ?? "unknown"}`);
}

/** Returns the process exit code: 0 done, 1 refused or not healthy, 2 usage error. */
export async function runPaymentKeyCheckCli(args: readonly string[], out: (line: string) => void): Promise<number> {
  const [command, ...rest] = args;

  if (command === "status" && rest.length === 0) {
    const report = await paymentKeyReport();
    describe(report, out);
    return report.state === "verified" || report.state === "no_check_no_data" ? 0 : 1;
  }

  if (command === "adopt" && rest.length === 2 && rest[0] === "--expected-fingerprint") {
    const result = await adoptPaymentKey(rest[1]);
    if (result.report) describe(result.report, out);
    if (!result.adopted) {
      out(REFUSALS[result.reason]);
      return 1;
    }
    out("Adopted: the check record was created. Payment operations are now verified against this key.");
    return result.report.state === "verified" ? 0 : 1;
  }

  out(USAGE);
  return 2;
}
