/**
 * Recognising a database that cannot run transactions (pure). SiteForge needs a replica set
 * (MongoDB Atlas always is one). A standalone `mongod` refuses every transaction, and nothing
 * falls back to writing without one: `handle()` in lib/api.ts turns this into a clear refusal,
 * and because the transaction never started, nothing was changed.
 */
const ILLEGAL_OPERATION = 20;

export function isTransactionsUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === ILLEGAL_OPERATION && typeof message === "string" && /transaction numbers|replica set/i.test(message);
}

export function transactionsUnavailableMessage(production: boolean): string {
  return production
    ? "This could not be saved because of a problem with the platform's database setup. Nothing was changed. Please contact your platform administrator."
    : "SiteForge needs MongoDB running as a replica set, and this server is standalone. Nothing was changed. Start mongod with --replSet rs0, run rs.initiate() once, and add ?replicaSet=rs0 to MONGODB_URI. See docs/database-preparation.md.";
}

/**
 * A database missing a unique index the core records rest on (lib/core-indexes.ts). Nothing creates
 * one by itself, so the platform refuses to work rather than run without the protection. What is
 * missing goes to the server log, never to a visitor.
 */
export class DatabaseNotPreparedError extends Error {
  constructor() {
    super("The database has not been prepared. See docs/database-preparation.md.");
    this.name = "DatabaseNotPreparedError";
  }
}

export function databaseNotPreparedMessage(production: boolean): string {
  return production
    ? "The platform is not available right now. Nothing was changed. Please contact your platform administrator."
    : "This database is missing required indexes, and SiteForge does not create them on a shared database. Nothing was changed. The server log lists them, and docs/database-preparation.md shows how to create them.";
}
