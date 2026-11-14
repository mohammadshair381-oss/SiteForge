import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { HttpError, handle } from "../../backend/lib/api";
import { canonicalEmail, couponIdentityKeys } from "../../backend/lib/coupons";
import { designDraftChangesSchema } from "../../backend/lib/design-settings";
import { rolesInviterMayGrant } from "../../backend/lib/team-invitations";
import { formatValidationError } from "../../backend/lib/validation-messages";
import { loginSchema, productUpdateSchema, registerSchema } from "../../backend/lib/validation";

async function failure(fn: () => unknown) {
  const res = await handle(async () => {
    fn();
    throw new HttpError(500, "did not fail");
  });
  return { status: res.status, body: await res.json() };
}

test("error messages use plain words, with no field names from the code", async () => {
  const schema = z.object({ postalCode: z.string().min(3), customerEmail: z.string().email(), compareAtPrice: z.number(), quantity: z.number().min(2), line1: z.string() });
  const { status, body } = await failure(() => schema.parse({ postalCode: "1", customerEmail: "nope", compareAtPrice: "x", quantity: 1 }));
  assert.equal(status, 422);
  assert.equal(body.code, "validation_error");
  assert.match(body.fields.postalCode, /^Postal code must be at least 3 characters\.$/);
  assert.match(body.fields.customerEmail, /^Email must be a valid email address\.$/);
  assert.match(body.fields.compareAtPrice, /^Original price must be a number\.$/);
  assert.match(body.fields.line1, /^Address is required\.$/);
  assert.doesNotMatch(body.error, /postalCode|customerEmail|compareAtPrice|invalid_|expected/);
});

test("a message written in a schema is used as it is", async () => {
  const { body } = await failure(() => registerSchema.parse({ name: "A", email: "a@example.test", password: "x" }));
  assert.match(body.error, /Name is too short\./);
  assert.match(body.error, /Password must be at least 8 characters/);
  assert.doesNotMatch(body.error, /^name:|password:/);
});

test("repeated problems are listed once, and at most three", () => {
  const schema = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() });
  const parsed = schema.safeParse({});
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.equal(formatValidationError(parsed.error).message.split(". ").length, 3);
    assert.equal(Object.keys(formatValidationError(parsed.error).fields).length, 4);
  }
  assert.ok(loginSchema.safeParse({ email: "a@example.test", password: "x" }).success);
});

// Zod 4 applies a default inside `.partial()`, which would overwrite stored values.
test("partial updates add nothing the request did not send", () => {
  assert.deepEqual(productUpdateSchema.parse({}), {});
  assert.deepEqual(productUpdateSchema.parse({ name: "Mug" }), { name: "Mug" });
  assert.deepEqual(designDraftChangesSchema.parse({}), {});
  assert.deepEqual(designDraftChangesSchema.parse({ themeId: "volt" }), { themeId: "volt" });
  assert.equal(designDraftChangesSchema.safeParse({ nonsense: 1 }).success, false);
});

test("coupon identity: aliases count as one mailbox", () => {
  assert.equal(canonicalEmail(" Ada.Lovelace+shop@GoogleMail.com "), "adalovelace@gmail.com");
  assert.equal(canonicalEmail("a.b+x@example.com"), "a.b@example.com");
});

test("coupon identity: keyed, bound to one coupon, and only when needed", () => {
  const coupon = { couponId: "c1", perCustomerLimit: 1, onePerAddress: true };
  const address = { phone: "+91 98765 43210", line1: "1 Test Road", line2: "", postalCode: "560 001", country: "India" };
  const keys = couponIdentityKeys(coupon, address);
  assert.ok(keys.phoneKey?.startsWith("phone:"));
  assert.ok(keys.addressKey?.startsWith("address:"));
  assert.equal(JSON.stringify(keys).includes("9876543210"), false, "no phone number in the key");

  // The same person formatted differently is the same key.
  assert.deepEqual(couponIdentityKeys(coupon, { ...address, phone: "98765 43210", line1: "1 test road.", postalCode: "560001" }), keys);
  // Another coupon gets unrelated keys, so redemptions cannot be linked across coupons.
  assert.notEqual(couponIdentityKeys({ ...coupon, couponId: "c2" }, address).phoneKey, keys.phoneKey);
  // A household is only one customer if the owner says so.
  assert.equal(couponIdentityKeys({ ...coupon, onePerAddress: false }, address).addressKey, undefined);
  // Without a per-customer limit nothing is derived at all.
  assert.deepEqual(couponIdentityKeys({ ...coupon, perCustomerLimit: null }, address), {});
  assert.deepEqual(couponIdentityKeys(coupon, null), {});
});

test("who may invite to which role", () => {
  assert.deepEqual(rolesInviterMayGrant("owner", false), ["owner", "manager", "staff"]);
  assert.deepEqual(rolesInviterMayGrant("manager", false), []);
  assert.deepEqual(rolesInviterMayGrant("manager", true), ["staff"]);
  assert.deepEqual(rolesInviterMayGrant("staff", true), []);
});
