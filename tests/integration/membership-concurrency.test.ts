/**
 * Phase 4.8.11 — concurrency regression tests for membership mutations.
 *
 * `runSerializedMembershipMutation` serializes role-affecting membership
 * changes per business by writing the business document inside the same
 * transaction. This file exercises that mechanism directly, at the database
 * level, because the shared `next/headers` cookie mock is process-global: two
 * concurrent `callHandler` calls would clobber/clear each other's session, so a
 * faithful concurrent HTTP-level test is not possible without reworking the
 * mock (out of scope here).
 *
 * Both tests therefore call the real production code (`lib/membership-transaction`):
 *  - the mechanism test drives the real conflict-creating write;
 *  - the invariant test drives `runSerializedMembershipMutation` itself
 *    (actor re-read, retry, and commit) with the route's demotion/removal logic.
 *
 * If the shared write is reverted to a no-op, the mechanism test fails
 * (no retry) and the invariant test fails (both operations commit, leaving zero
 * active owners).
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import {
  runSerializedMembershipMutation,
  touchBusinessForSerialization,
} from "@/lib/membership-transaction";
import { HttpError } from "@/lib/api";
import { Business, Membership } from "@/models";
import type { Types } from "mongoose";

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A business whose `owner` has no membership, so the two active owner
 * memberships added by `addOwnerMembership` are the only guards and the
 * "at least one active owner" rule is decided solely by the serialization
 * mechanism (not by the immutable-primary-owner rule).
 */
async function createBusiness() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await createUser();
  const business = await Business.create({
    name: `Concurrency-${suffix}`,
    slug: `concurrency-${suffix}`,
    subdomain: `concurrency-${suffix}`,
    category: "services",
    owner,
  });
  return { owner, business };
}

async function addOwnerMembership(businessId: Types.ObjectId) {
  const user = await createUser();
  const membership = await Membership.create({
    business: businessId,
    user,
    role: "owner",
    status: "active",
  });
  return { user, membership };
}

async function activeOwnerCount(businessId: Types.ObjectId): Promise<number> {
  return Membership.countDocuments({
    business: businessId,
    role: "owner",
    status: "active",
  });
}

// -------------------------------------------------------
// Mechanism: the shared write must create a real conflict
// -------------------------------------------------------

test("serialization write creates a write conflict between concurrent transactions", async () => {
  const { business } = await createBusiness();

  const attempts = { a: 0, b: 0 };
  const s1 = await mongoose.connection.startSession();
  const s2 = await mongoose.connection.startSession();
  try {
    await Promise.all([
      s1.withTransaction(async () => {
        attempts.a += 1;
        await touchBusinessForSerialization(business._id, s1);
        // Hold the transaction open so the two writers genuinely overlap.
        await delay(400);
      }),
      s2.withTransaction(async () => {
        attempts.b += 1;
        await touchBusinessForSerialization(business._id, s2);
        await delay(400);
      }),
    ]);
  } finally {
    await s1.endSession();
    await s2.endSession();
  }

  // With a real (modifying) write, one transaction must conflict and be retried
  // by `withTransaction`, so the callback runs more than once per session in
  // total. A no-op write produces no conflict, leaving the total at exactly 2.
  assert.ok(
    attempts.a + attempts.b > 2,
    `expected at least one retry from a real conflict, got attempts=${JSON.stringify(attempts)}`,
  );
});

// -------------------------------------------------------
// Invariant: two owners cannot concurrently remove all owners
// -------------------------------------------------------

/** Mirrors the route's PATCH `work`: demote the target, guarded by last-owner. */
function demoteWork(businessId: Types.ObjectId, targetId: Types.ObjectId) {
  return async (session: mongoose.ClientSession) => {
    // Force the two transactions to overlap if they are not already serialized.
    await delay(250);

    const current = await Membership.findOne({ _id: targetId, business: businessId }).session(
      session,
    );
    if (!current) throw new HttpError(404, "Member not found", "not_found");

    if (current.role === "owner" && current.status === "active") {
      const owners = await Membership.countDocuments({
        business: businessId,
        role: "owner",
        status: "active",
      }).session(session);
      if (owners <= 1) {
        throw new HttpError(
          409,
          "A business must always have at least one active owner",
          "last_owner",
        );
      }
    }

    current.role = "staff";
    await current.save({ session });
    return current;
  };
}

/** Mirrors the route's DELETE `work`: remove the target, guarded by last-owner. */
function removeWork(businessId: Types.ObjectId, targetId: Types.ObjectId) {
  return async (session: mongoose.ClientSession) => {
    await delay(250);

    const current = await Membership.findOne({ _id: targetId, business: businessId }).session(
      session,
    );
    if (!current) throw new HttpError(404, "Member not found", "not_found");

    if (current.role === "owner" && current.status === "active") {
      const owners = await Membership.countDocuments({
        business: businessId,
        role: "owner",
        status: "active",
      }).session(session);
      if (owners <= 1) {
        throw new HttpError(
          409,
          "A business must always have at least one active owner",
          "last_owner",
        );
      }
    }

    await Membership.deleteOne({ _id: targetId, business: businessId }, { session });
  };
}

interface Outcome {
  committed: number;
  forbidden: number;
  unexpected: unknown[];
}

async function runConcurrent(
  businessId: Types.ObjectId,
  actorA: Types.ObjectId,
  actorB: Types.ObjectId,
  work: (
    businessId: Types.ObjectId,
    targetId: Types.ObjectId,
  ) => (session: mongoose.ClientSession) => Promise<unknown>,
): Promise<Outcome> {
  const outcome: Outcome = { committed: 0, forbidden: 0, unexpected: [] };

  const run = (actorId: Types.ObjectId, targetId: Types.ObjectId) =>
    runSerializedMembershipMutation(businessId, actorId, work(businessId, targetId)).then(
      () => {
        outcome.committed += 1;
      },
      (error: unknown) => {
        if (error instanceof HttpError && error.status === 403 && error.code === "forbidden") {
          outcome.forbidden += 1;
        } else {
          outcome.unexpected.push(error);
        }
      },
    );

  // Owner A demotes/removes B at the same time owner B demotes/removes A.
  await Promise.all([run(actorA, actorB), run(actorB, actorA)]);
  return outcome;
}

test("two owners demoting each other concurrently keep at least one active owner", async () => {
  const { business } = await createBusiness();
  const a = await addOwnerMembership(business._id);
  const b = await addOwnerMembership(business._id);
  assert.equal(await activeOwnerCount(business._id), 2);

  const outcome = await runConcurrent(business._id, a.membership._id, b.membership._id, demoteWork);

  assert.deepEqual(outcome.unexpected, []);
  // Exactly one demotion commits; the other is rejected because its acting
  // owner membership was demoted by the committed transaction (re-read on
  // retry inside the transaction).
  assert.equal(outcome.committed, 1);
  assert.equal(outcome.forbidden, 1);

  const owners = await activeOwnerCount(business._id);
  assert.equal(owners, 1);
});

test("two owners removing each other concurrently keep at least one active owner", async () => {
  const { business } = await createBusiness();
  const a = await addOwnerMembership(business._id);
  const b = await addOwnerMembership(business._id);
  assert.equal(await activeOwnerCount(business._id), 2);

  const outcome = await runConcurrent(business._id, a.membership._id, b.membership._id, removeWork);

  assert.deepEqual(outcome.unexpected, []);
  assert.equal(outcome.committed, 1);
  assert.equal(outcome.forbidden, 1);

  const owners = await activeOwnerCount(business._id);
  assert.equal(owners, 1);
});
