import { loadEnv } from "./load-env";

loadEnv();

/**
 * Payment-key check (docs/payments-architecture.md, "Payment key check"):
 *
 *   npm run payment-key-check -- status
 *   npm run payment-key-check -- adopt --expected-fingerprint <from the key escrow>
 *
 * Prints only states, fingerprints and counts. Adoption is an approved operator action: staging
 * first, production separately. It never decrypts a store's secrets and never replaces a record.
 */
async function main(): Promise<number> {
  const { runPaymentKeyCheckCli } = await import("../lib/payments/key-check-cli");
  try {
    return await runPaymentKeyCheckCli(process.argv.slice(2), (line) => console.log(line));
  } finally {
    const mongoose = (await import("mongoose")).default;
    await mongoose.disconnect().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch(() => {
    // No error detail: it could carry connection details.
    console.error("payment-key-check failed before finishing. Run the status command to see the current state.");
    process.exit(1);
  });
