import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  grantsAccess,
  reduceSubscription,
  verifyTimestampedSignature,
  type NormalizedBillingEvent,
  type PlanPrice,
  type SubscriptionState,
} from "@/lib/billing-lifecycle";

const plans = new Map<string, PlanPrice>([
  ["pro", { key: "pro", amountMinor: 99900, currency: "INR" }],
  ["max", { key: "max", amountMinor: 199900, currency: "INR" }],
]);
const t = (day: number) => new Date(Date.UTC(2026, 10, day));
const empty: SubscriptionState = {
  status: "incomplete", planKey: null, providerSubscriptionId: null, currentPeriodStart: null, currentPeriodEnd: null,
  cancelAtPeriodEnd: false, graceUntil: null, lastEventAt: null, appliedEventIds: [],
};
let n = 0;
const ev = (type: NormalizedBillingEvent["type"], day: number, extra: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent => ({
  provider: "test", eventId: `evt_${++n}`, type, occurredAt: t(day), providerSubscriptionId: "sub_1", ...extra,
});
const paid = (type: "subscription.activated" | "subscription.renewed", day: number, extra: Partial<NormalizedBillingEvent> = {}) =>
  ev(type, day, { planKey: "pro", amountMinor: 99900, currency: "INR", periodStart: t(day), periodEnd: t(day + 30), ...extra });

function run(events: NormalizedBillingEvent[], now = t(1), start = empty) {
  let state = start;
  const effects: string[] = [];
  for (const e of events) {
    const out = reduceSubscription(state, e, plans, { now });
    effects.push(out.effect === "applied" ? "applied" : `${out.effect}:${out.reason}`);
    state = out.state;
  }
  return { state, effects };
}

test("activation and renewal need the exact plan amount, currency and a valid period", () => {
  const ok = run([paid("subscription.activated", 1)]);
  assert.deepEqual(ok.effects, ["applied"]);
  assert.equal(ok.state.status, "active");
  assert.equal(ok.state.planKey, "pro");
  assert.ok(grantsAccess(ok.state, t(10)));
  assert.equal(grantsAccess(ok.state, t(40)), false, "access ends with the period");

  assert.deepEqual(run([paid("subscription.activated", 1, { amountMinor: 100 })]).effects, ["rejected:amount_mismatch"]);
  assert.deepEqual(run([paid("subscription.activated", 1, { currency: "USD" })]).effects, ["rejected:amount_mismatch"]);
  assert.deepEqual(run([paid("subscription.activated", 1, { planKey: "ghost" })]).effects, ["rejected:unknown_plan"]);
  assert.deepEqual(run([paid("subscription.activated", 1, { periodEnd: t(1) })]).effects, ["rejected:missing_period"]);
  assert.equal(run([paid("subscription.activated", 1, { amountMinor: 0 })]).state.status, "incomplete", "a rejected event changes nothing");
});

test("duplicates and out-of-order events never undo newer state", () => {
  const activation = paid("subscription.activated", 1);
  const renewal = paid("subscription.renewed", 31);
  const lateFailure = ev("payment.failed", 30);
  const { state, effects } = run([activation, activation, renewal, lateFailure]);
  assert.deepEqual(effects, ["applied", "ignored:duplicate", "applied", "ignored:out_of_order"]);
  assert.equal(state.status, "active");
  assert.equal(state.currentPeriodEnd?.getTime(), t(61).getTime());
});

test("a failed renewal gives a grace period, then a renewal restores access", () => {
  const { state } = run([paid("subscription.activated", 1), ev("payment.failed", 31)], t(31));
  assert.equal(state.status, "past_due");
  assert.ok(grantsAccess(state, t(32)), "inside the 3-day grace period");
  assert.equal(grantsAccess(state, t(35)), false, "after the grace period");
  const recovered = run([paid("subscription.renewed", 32)], t(32), state);
  assert.equal(recovered.state.status, "active");
  assert.equal(recovered.state.graceUntil, null);
});

test("cancellation: scheduled keeps access to the period end; immediate ends it", () => {
  const scheduled = run([paid("subscription.activated", 1), ev("subscription.cancel_scheduled", 5)]);
  assert.equal(scheduled.state.status, "active");
  assert.equal(scheduled.state.cancelAtPeriodEnd, true);
  assert.ok(grantsAccess(scheduled.state, t(20)));
  const ended = run([ev("subscription.canceled", 31)], t(31), scheduled.state);
  assert.equal(ended.state.status, "canceled");
  assert.equal(grantsAccess(ended.state, t(31)), false);
  assert.deepEqual(run([ev("payment.failed", 32)], t(32), ended.state).effects, ["ignored:no_change"]);
});

test("plan changes need a known plan; refunds never grant access; another subscription id is rejected", () => {
  const base = run([paid("subscription.activated", 1)]).state;
  assert.equal(run([ev("subscription.plan_changed", 2, { planKey: "max" })], t(2), base).state.planKey, "max");
  assert.deepEqual(run([ev("subscription.plan_changed", 2, { planKey: "ghost" })], t(2), base).effects, ["rejected:unknown_plan"]);
  const refunded = run([ev("payment.refunded", 3, { amountMinor: 99900, currency: "INR" })], t(3), base).state;
  assert.equal(refunded.status, "active", "a refund alone does not change access");
  assert.deepEqual(run([paid("subscription.renewed", 4, { providerSubscriptionId: "sub_other" })], t(4), base).effects, ["rejected:subscription_mismatch"]);
});

test("timestamped signatures: valid, tampered, stale, future, malformed", () => {
  const secret = "whsec_test";
  const now = new Date("2026-11-01T00:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = JSON.stringify({ id: "evt_1" });
  const sign = (timestamp: string, raw: string) => crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");

  assert.deepEqual(verifyTimestampedSignature({ rawBody: body, timestamp: ts, signature: sign(ts, body), secret, now }), { ok: true });
  assert.deepEqual(verifyTimestampedSignature({ rawBody: body + " ", timestamp: ts, signature: sign(ts, body), secret, now }), { ok: false, reason: "mismatch" });
  const old = String(Number(ts) - 301);
  assert.deepEqual(verifyTimestampedSignature({ rawBody: body, timestamp: old, signature: sign(old, body), secret, now }), { ok: false, reason: "outside_window" }, "replay of an old delivery");
  const future = String(Number(ts) + 301);
  assert.deepEqual(verifyTimestampedSignature({ rawBody: body, timestamp: future, signature: sign(future, body), secret, now }), { ok: false, reason: "outside_window" });
  assert.deepEqual(verifyTimestampedSignature({ rawBody: body, timestamp: "abc", signature: sign(ts, body), secret, now }), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyTimestampedSignature({ rawBody: body, timestamp: null, signature: null, secret, now }), { ok: false, reason: "missing" });
  // The timestamp is part of the signed payload: moving it invalidates the signature.
  const shifted = String(Number(ts) - 10);
  assert.deepEqual(verifyTimestampedSignature({ rawBody: body, timestamp: shifted, signature: sign(ts, body), secret, now }), { ok: false, reason: "mismatch" });
});
