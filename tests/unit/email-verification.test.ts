import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { isEmailVerified } from "../../backend/lib/auth/guards";

// Addresses are confirmed by entering an emailed code (tests/integration/signup-code.test.ts);
// the verification state itself is unchanged.

test("isEmailVerified: null is unverified; Date and legacy undefined are verified", () => {
  assert.equal(isEmailVerified({ emailVerifiedAt: null }), false);
  assert.equal(isEmailVerified({ emailVerifiedAt: new Date() }), true);
  assert.equal(isEmailVerified({ emailVerifiedAt: undefined }), true);
  assert.equal(isEmailVerified({}), true, "legacy accounts (field absent) stay verified");
});
