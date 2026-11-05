import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { Plan } from "@/models/Plan";

/**
 * Guards the test harness capability, not application behavior: the payments
 * webhook and the members route both rely on multi-document transactions, which
 * require a MongoDB replica set. This test fails loudly if the harness is ever
 * changed back to a standalone MongoDB instance, rather than letting every
 * transactional route fail at runtime.
 */

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

function planDoc(id: mongoose.Types.ObjectId, key: string) {
  return {
    _id: id,
    key,
    name: "Transaction Smoke Plan",
    description: "",
    price: 1,
    currency: "USD",
    features: {
      productLimit: 1,
      staffLimit: 1,
      customDomain: false,
      removeBranding: false,
    },
    active: true,
  };
}

test("the integration harness runs a replica set that supports transactions", async () => {
  const committed = new mongoose.Types.ObjectId();
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await Plan.create([planDoc(committed, `tx-commit-${Date.now()}`)], { session });
    });
  } finally {
    await session.endSession();
  }
  assert.equal(await Plan.countDocuments({ _id: committed }), 1, "committed write must persist");
});

test("an aborted transaction rolls back its writes", async () => {
  const rolledBack = new mongoose.Types.ObjectId();
  const session = await mongoose.connection.startSession();
  try {
    await assert.rejects(
      session.withTransaction(async () => {
        await Plan.create([planDoc(rolledBack, `tx-rollback-${Date.now()}`)], { session });
        throw new Error("simulated failure after the write");
      }),
    );
  } finally {
    await session.endSession();
  }
  assert.equal(
    await Plan.countDocuments({ _id: rolledBack }),
    0,
    "aborted transaction must roll back the insert",
  );
});
