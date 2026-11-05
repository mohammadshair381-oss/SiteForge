import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../../lib/api";
import { assertObjectId, isValidObjectId } from "../../lib/ids";

test("isValidObjectId accepts 24-char hex strings only", () => {
  assert.equal(isValidObjectId("507f1f77bcf86cd799439011"), true);
  assert.equal(isValidObjectId("507F1F77BCF86CD799439011"), true);
  assert.equal(isValidObjectId("507f1f77bcf86cd79943901"), false);
  assert.equal(isValidObjectId("507f1f77bcf86cd799439011a"), false);
  assert.equal(isValidObjectId("zzzzzzzzzzzzzzzzzzzzzzzz"), false);
  assert.equal(isValidObjectId(""), false);
  assert.equal(isValidObjectId(undefined), false);
  assert.equal(isValidObjectId(null), false);
  assert.equal(isValidObjectId(123), false);
});

test("assertObjectId returns a valid id unchanged", () => {
  const id = "507f1f77bcf86cd799439011";
  assert.equal(assertObjectId(id), id);
});

test("assertObjectId throws a 400 invalid_id HttpError for malformed ids", () => {
  assert.throws(
    () => assertObjectId("nope", "business id"),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_id");
      assert.equal(error.message, "Invalid business id");
      return true;
    },
  );
});
