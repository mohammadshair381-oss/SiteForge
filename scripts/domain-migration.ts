import { loadEnv } from "./load-env";

loadEnv();

/**
 * Legacy custom-domain record normalization.
 *
 *   npm run domain-migration                 # dry run (read-only counts)
 *   npm run domain-migration -- --apply      # refuses unless confirmed below
 *
 * Writing requires BOTH `--apply` and `CONFIRM_DOMAIN_MIGRATION=yes` in the
 * environment, so it can never run by accident. Back up first; see
 * docs/domain-lifecycle-migration.md. Prints counts only (no domains/tokens).
 */
async function main() {
  const [{ dbConnect }, migration] = await Promise.all([
    import("../lib/db"),
    import("../lib/domain-migration"),
  ]);
  const mongoose = (await import("mongoose")).default;

  await dbConnect();

  const plan = await migration.planLegacyDomainMigration();
  console.log("Legacy domain records (dry run):");
  console.log(`  verified -> status "verified", expiresAt cleared: ${plan.verified}`);
  console.log(`    of which expiresAt already past (TTL-eligible now): ${plan.verifiedExpiredAtRisk}`);
  console.log(`  removed  -> status "revoked": ${plan.revoked}`);

  if (process.argv.includes("--apply")) {
    if (process.env.CONFIRM_DOMAIN_MIGRATION !== "yes") {
      console.error("Refusing to write: set CONFIRM_DOMAIN_MIGRATION=yes to confirm.");
      process.exitCode = 1;
    } else {
      const result = await migration.applyLegacyDomainMigration();
      console.log(`Applied: ${result.verified} verified, ${result.revoked} revoked.`);
    }
  } else {
    console.log("No changes made. Re-run with --apply (and CONFIRM_DOMAIN_MIGRATION=yes) to write.");
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exit(1);
});
