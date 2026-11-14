import assert from "node:assert/strict";
import test from "node:test";

import { buildMongooseOptions, MONGODB_MAX_IDLE_TIME_MS, srvLookupName, usesOnlyLoopbackDns } from "../../backend/lib/db";
import { DEFAULT_MONGODB_MAX_POOL_SIZE, envSchema } from "../../backend/lib/env";

// Pure: parses plain objects with the real env schema; never reads or mutates
// process.env and never connects to MongoDB. Values are safe dummies.
const BASE = {
  MONGODB_URI: "mongodb://127.0.0.1:27017/saas_test_options?replicaSet=rs0",
  SESSION_SECRET: "x".repeat(48),
};

function poolSizeFor(value: string | undefined): number {
  const parsed = envSchema.parse(value === undefined ? BASE : { ...BASE, MONGODB_MAX_POOL_SIZE: value });
  return parsed.MONGODB_MAX_POOL_SIZE;
}

test("options keep bufferCommands off and set the pool and idle timeout", () => {
  assert.deepEqual(buildMongooseOptions({ MONGODB_MAX_POOL_SIZE: 10 }), {
    bufferCommands: false,
    maxPoolSize: 10,
    maxIdleTimeMS: 60_000,
  });
  assert.equal(MONGODB_MAX_IDLE_TIME_MS, 60_000);
});

test("pool size defaults to 10 when unset or blank", () => {
  assert.equal(DEFAULT_MONGODB_MAX_POOL_SIZE, 10);
  assert.equal(poolSizeFor(undefined), 10);
  assert.equal(poolSizeFor(""), 10);
  assert.equal(poolSizeFor("   "), 10);
});

test("valid overrides from 1 to 50 are applied", () => {
  assert.equal(poolSizeFor("1"), 1);
  assert.equal(poolSizeFor(" 25 "), 25);
  assert.equal(poolSizeFor("50"), 50);
  assert.equal(buildMongooseOptions({ MONGODB_MAX_POOL_SIZE: poolSizeFor("50") }).maxPoolSize, 50);
});

test("out-of-range or non-integer pool sizes are rejected, naming only the variable", () => {
  for (const value of ["0", "51", "-1", "2.5", "ten", "100"]) {
    const result = envSchema.safeParse({ ...BASE, MONGODB_MAX_POOL_SIZE: value });
    assert.equal(result.success, false, `"${value}" must be rejected`);
    if (!result.success) {
      const message = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      assert.match(message, /MONGODB_MAX_POOL_SIZE/);
      assert.equal(message.includes(BASE.SESSION_SECRET), false);
      assert.equal(message.includes(BASE.MONGODB_URI), false);
    }
  }
});

test("srvLookupName: only for mongodb+srv addresses, never including credentials", () => {
  assert.equal(srvLookupName("mongodb+srv://user:secret@cluster.example.net/db?x=1"), "_mongodb._tcp.cluster.example.net");
  assert.equal(srvLookupName("mongodb+srv://cluster.example.net"), "_mongodb._tcp.cluster.example.net");
  assert.equal(srvLookupName("mongodb://127.0.0.1:27017/db?replicaSet=rs0"), null);
});

test("usesOnlyLoopbackDns: a real DNS server is never overridden", () => {
  assert.equal(usesOnlyLoopbackDns(["127.0.0.1"]), true);
  assert.equal(usesOnlyLoopbackDns(["::1", "127.0.0.53"]), true);
  assert.equal(usesOnlyLoopbackDns(["127.0.0.1", "8.8.8.8"]), false);
  assert.equal(usesOnlyLoopbackDns(["192.168.1.1"]), false);
  assert.equal(usesOnlyLoopbackDns([]), false);
});
