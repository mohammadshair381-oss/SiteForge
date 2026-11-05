import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSINESS_ADMIN_ROLES,
  CONTENT_MANAGEMENT_ROLES,
  MEMBERSHIP_ROLES,
  PLATFORM_ROLES,
  PRODUCT_OPERATION_ROLES,
} from "../../lib/constants";
import {
  membershipInviteSchema,
  membershipRoleUpdateSchema,
} from "../../lib/validation";

test("membership roles: owner and staff remain supported", () => {
  assert.deepEqual([...MEMBERSHIP_ROLES], ["owner", "staff", "manager"]);
  assert.equal(MEMBERSHIP_ROLES.includes("owner"), true);
  assert.equal(MEMBERSHIP_ROLES.includes("staff"), true);
});

test("membership roles: manager is a supported business membership role", () => {
  assert.equal(MEMBERSHIP_ROLES.includes("manager"), true);
  assert.equal(
    membershipInviteSchema.safeParse({ email: "person@example.com", role: "manager" }).success,
    true,
  );
  assert.equal(
    membershipRoleUpdateSchema.safeParse({ role: "manager" }).success,
    true,
  );
});

test("membership roles: invalid roles are rejected", () => {
  assert.equal(MEMBERSHIP_ROLES.includes("administrator" as never), false);
  assert.equal(
    membershipInviteSchema.safeParse({ email: "person@example.com", role: "administrator" }).success,
    false,
  );
  assert.equal(
    membershipRoleUpdateSchema.safeParse({ role: "super_admin" }).success,
    false,
  );
});

test("platform and business roles stay separate", () => {
  assert.deepEqual([...PLATFORM_ROLES], ["user", "super_admin"]);
  assert.equal(PLATFORM_ROLES.includes("manager" as never), false);
  assert.equal(PLATFORM_ROLES.includes("owner" as never), false);
  assert.equal(PLATFORM_ROLES.includes("staff" as never), false);
  assert.equal(MEMBERSHIP_ROLES.includes("super_admin" as never), false);
  assert.equal(MEMBERSHIP_ROLES.includes("user" as never), false);
});

test("role groups: describe intended future permissions without changing current roles", () => {
  assert.deepEqual([...BUSINESS_ADMIN_ROLES], ["owner"]);
  assert.deepEqual([...CONTENT_MANAGEMENT_ROLES], ["owner", "manager"]);
  assert.deepEqual([...PRODUCT_OPERATION_ROLES], ["owner", "manager", "staff"]);
  for (const role of CONTENT_MANAGEMENT_ROLES) {
    assert.equal(MEMBERSHIP_ROLES.includes(role), true);
  }
  for (const role of PRODUCT_OPERATION_ROLES) {
    assert.equal(MEMBERSHIP_ROLES.includes(role), true);
  }
});

test("existing owner and staff compatibility is preserved", () => {
  assert.equal(
    membershipInviteSchema.safeParse({ email: "owner@example.com", role: "owner" }).success,
    true,
  );
  assert.equal(
    membershipInviteSchema.safeParse({ email: "staff@example.com", role: "staff" }).success,
    true,
  );
  assert.equal(
    membershipRoleUpdateSchema.safeParse({ role: "owner" }).success,
    true,
  );
  assert.equal(
    membershipRoleUpdateSchema.safeParse({ role: "staff" }).success,
    true,
  );
});