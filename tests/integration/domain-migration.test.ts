import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { DomainVerification } from "@/models/DomainVerification";
import {
  applyLegacyDomainMigration,
  planLegacyDomainMigration,
} from "@/lib/domain-migration";

/**
 * Legacy-record normalization. Documents are inserted through the raw driver
 * so they genuinely lack the new lifecycle fields (no schema defaults).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

before(async () => {
  await startIntegrationSuite();
  await connectTestDB();
});
after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  await clearAllCollections();
});

function legacy(domain: string, fields: Record<string, unknown>) {
  return DomainVerification.collection.insertOne({
    business: new mongoose.Types.ObjectId(),
    domain,
    tokenHash: "a".repeat(64),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
}

async function seed() {
  const past = new Date(Date.now() - 3 * DAY_MS);
  await legacy("verified-old.example.com", {
    verifiedAt: past,
    usedAt: past,
    expiresAt: new Date(Date.now() - 2 * DAY_MS),
  });
  await legacy("verified-live.example.com", {
    verifiedAt: new Date(),
    usedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + DAY_MS),
  });
  await legacy("removed.example.com", {
    verifiedAt: past,
    usedAt: new Date(past.getTime() + 1000),
    expiresAt: new Date(Date.now() - DAY_MS),
  });
  await legacy("pending.example.com", {
    verifiedAt: null,
    usedAt: null,
    expiresAt: new Date(Date.now() + DAY_MS),
  });
  await legacy("consumed.example.com", {
    verifiedAt: null,
    usedAt: new Date(),
    expiresAt: new Date(Date.now() + DAY_MS),
  });
  await legacy("new-lifecycle.example.com", {
    status: "verified",
    verifiedAt: past,
    expiresAt: null,
  });
}

const get = (domain: string) => DomainVerification.collection.findOne({ domain });

test("dry run counts only legacy verified and removed records and writes nothing", async () => {
  await seed();
  const snapshot = await DomainVerification.collection.find().toArray();
  const plan = await planLegacyDomainMigration();
  assert.deepEqual(plan, { verified: 2, verifiedExpiredAtRisk: 1, revoked: 1 });
  assert.deepEqual(await DomainVerification.collection.find().toArray(), snapshot);
});

test("apply is scoped, idempotent and leaves unrelated records untouched", async () => {
  await seed();
  const pendingBefore = await get("pending.example.com");
  const consumedBefore = await get("consumed.example.com");
  const newBefore = await get("new-lifecycle.example.com");

  assert.deepEqual(await applyLegacyDomainMigration(), { verified: 2, revoked: 1 });

  const old = await get("verified-old.example.com");
  assert.equal(old?.status, "verified");
  assert.equal(old?.expiresAt, null);
  assert.ok(old?.ownershipCheckedAt instanceof Date);
  assert.equal((await get("verified-live.example.com"))?.status, "verified");
  const removed = await get("removed.example.com");
  assert.equal(removed?.status, "revoked");
  assert.equal(removed?.expiresAt, null);
  assert.ok(removed?.revokedAt instanceof Date);

  // Pending, consumed-unverified and already-migrated records are untouched.
  assert.deepEqual(await get("pending.example.com"), pendingBefore);
  assert.deepEqual(await get("consumed.example.com"), consumedBefore);
  assert.deepEqual(await get("new-lifecycle.example.com"), newBefore);

  // Safe to rerun.
  assert.deepEqual(await applyLegacyDomainMigration(), { verified: 0, revoked: 0 });
  assert.deepEqual(await planLegacyDomainMigration(), {
    verified: 0,
    verifiedExpiredAtRisk: 0,
    revoked: 0,
  });
});
