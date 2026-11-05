import dns from "node:dns";
import mongoose, { type ConnectOptions } from "mongoose";
import { findMissingCoreIndexes } from "./core-indexes";
import { DatabaseNotPreparedError } from "./db-errors";
import { env, type Env } from "./env";

/** Idle pooled connections are closed after this long (ms). */
export const MONGODB_MAX_IDLE_TIME_MS = 60_000;

/**
 * Connection options for `mongoose.connect`. Pure so it can be unit-tested.
 *
 * - `bufferCommands: false` (unchanged): fail fast instead of queueing queries
 *   while disconnected.
 * - `maxPoolSize`: per-instance cap (default 10, `MONGODB_MAX_POOL_SIZE` 1-50).
 *   The driver default of 100 per instance would let a handful of serverless
 *   instances exhaust a small cluster's connection limit.
 * - `maxIdleTimeMS`: return idle connections so quiet instances do not hold
 *   connections indefinitely.
 *
 * Index behaviour is decided separately by `automaticIndexOptions`.
 */
export function buildMongooseOptions(
  config: Pick<Env, "MONGODB_MAX_POOL_SIZE">,
): ConnectOptions {
  return {
    bufferCommands: false,
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
    maxIdleTimeMS: MONGODB_MAX_IDLE_TIME_MS,
  };
}

const isLoopbackHost = (host: string) => /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host);

/**
 * Whether Mongoose may create collections and indexes by itself when a model loads. Only for a
 * development or test database on this same machine (the in-memory test server, or a local
 * `mongod`), where nothing else depends on it. Never in production, and never for any database
 * reached over a network, whatever `NODE_ENV` says: a development machine pointed at a shared cluster
 * must not change it. There is deliberately no setting to turn this on: a persistent database
 * gets its indexes through an approved operation (docs/database-preparation.md).
 */
export function automaticIndexesAllowed(config: Pick<Env, "NODE_ENV" | "MONGODB_URI">): boolean {
  if (config.NODE_ENV === "production") return false;
  const hosts = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/.exec(config.MONGODB_URI)?.[1];
  return Boolean(hosts) && (hosts as string).split(",").every(isLoopbackHost);
}

/** A model's own `autoIndex: false` or `autoCreate: false` still wins over these. */
export function automaticIndexOptions(config: Pick<Env, "NODE_ENV" | "MONGODB_URI">): Pick<ConnectOptions, "autoIndex" | "autoCreate"> {
  const allowed = automaticIndexesAllowed(config);
  return { autoIndex: allowed, autoCreate: allowed };
}

const PUBLIC_DNS_SERVERS = ["8.8.8.8", "1.1.1.1"];

/** The DNS name a `mongodb+srv://` address is looked up by; null for any other address. */
export function srvLookupName(uri: string): string | null {
  const host = /^mongodb\+srv:\/\/(?:[^@/]*@)?([^/?,:]+)/.exec(uri)?.[1];
  return host ? `_mongodb._tcp.${host}` : null;
}

/** Node is only asking a DNS server on this machine (it may not be running one). */
export function usesOnlyLoopbackDns(servers: string[]): boolean {
  return servers.length > 0 && servers.every((server) => /^(127\.|\[?::1\]?)/.test(server));
}

/**
 * Atlas addresses need an SRV lookup, which goes through Node's own DNS client
 * rather than the operating system. On some Windows machines that client ends
 * up asking 127.0.0.1, where nothing listens, so the connection fails with
 * `querySrv ECONNREFUSED` while the rest of the network works. Only in that
 * exact case, switch to public DNS. A local DNS server that answers is left alone.
 */
async function repairSrvDns(uri: string): Promise<void> {
  const name = srvLookupName(uri);
  if (!name || !usesOnlyLoopbackDns(dns.getServers())) return;
  try {
    await dns.promises.resolveSrv(name);
  } catch (error) {
    if ((error as { code?: string }).code !== "ECONNREFUSED") return;
    dns.setServers(PUBLIC_DNS_SERVERS);
    console.warn("[db] The local DNS server refused the database lookup; using public DNS instead.");
  }
}

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  /** The core unique indexes were found, or this database builds its own. Stays true for the process. */
  prepared?: boolean;
  /** Indexes found missing, and when to look again, so an operator's fix works without a restart. */
  notPreparedUntil?: number;
}

const globalWithMongoose = globalThis as unknown as {
  _mongooseCache?: MongooseCache;
};

const cache: MongooseCache =
  globalWithMongoose._mongooseCache ??
  (globalWithMongoose._mongooseCache = { conn: null, promise: null });

const NOT_PREPARED_RECHECK_MS = 60_000;

/**
 * Where nothing builds indexes automatically, the core unique indexes must already exist, or the
 * platform refuses to work: running without them would silently give up what they guarantee. It only
 * looks and never creates one. Asked once per process; a missing index is looked for again each minute.
 */
async function assertDatabasePrepared(connection: typeof mongoose): Promise<void> {
  if (cache.prepared) return;
  const config = env();
  if (config.NODE_ENV === "test" || automaticIndexesAllowed(config)) {
    cache.prepared = true;
    return;
  }
  if (cache.notPreparedUntil && Date.now() < cache.notPreparedUntil) throw new DatabaseNotPreparedError();
  const db = connection.connection.db;
  if (!db) return;
  const { missing, uncertain } = await findMissingCoreIndexes(db);
  if (missing.length > 0) {
    cache.notPreparedUntil = Date.now() + NOT_PREPARED_RECHECK_MS;
    console.error(JSON.stringify({ event: "database_not_prepared", missing, fix: "docs/database-preparation.md" }));
    throw new DatabaseNotPreparedError();
  }
  cache.notPreparedUntil = undefined;
  if (!uncertain) cache.prepared = true;
}

/**
 * Returns a cached Mongoose connection. Safe to call from any server route.
 * Never call this from middleware or edge code.
 */
export async function dbConnect(): Promise<typeof mongoose> {
  if (cache.conn) {
    await assertDatabasePrepared(cache.conn);
    return cache.conn;
  }

  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    const config = env();
    cache.promise = repairSrvDns(config.MONGODB_URI).then(() => mongoose.connect(config.MONGODB_URI, { ...buildMongooseOptions(config), ...automaticIndexOptions(config) }));
  }

  try {
    cache.conn = await cache.promise;
  } catch (error) {
    cache.promise = null;
    throw error;
  }

  await assertDatabasePrepared(cache.conn);
  return cache.conn;
}
