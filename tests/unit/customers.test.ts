import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeRegex,
  isGroupableCustomerEmail,
  normalizeCustomerEmail,
} from "../../backend/lib/customers";
import { formatCustomerTotals } from "../../frontend/components/dashboard/CustomersManager";

/** Customer identity rules (pure). */

test("emails are normalised by trimming and lower-casing only", () => {
  assert.equal(normalizeCustomerEmail("  Ada@Example.COM "), "ada@example.com");
  // No provider-specific folding: these stay different customers.
  assert.equal(normalizeCustomerEmail("a.da+shop@gmail.com"), "a.da+shop@gmail.com");
  assert.equal(normalizeCustomerEmail(undefined), "");
  assert.equal(normalizeCustomerEmail(null), "");
  assert.equal(normalizeCustomerEmail(42), "");
});

test("normalisation matches the database pipeline: ASCII lower-casing, ordinary whitespace only", () => {
  // Non-ASCII letters are left as-is (MongoDB $toLower is ASCII-only), so JS
  // and the aggregation always produce the same key.
  assert.equal(normalizeCustomerEmail("ÄDA@Example.de"), "Äda@example.de");
  // A NUL or other control character is NOT trimmed and makes the email
  // ungroupable, so it can never be merged into another customer.
  const withNul = normalizeCustomerEmail("victim@example.com\u0000");
  assert.equal(withNul, "victim@example.com\u0000");
  assert.equal(isGroupableCustomerEmail(withNul), false);
  assert.equal(isGroupableCustomerEmail("vic\u001ftim@example.com"), false);
  assert.equal(normalizeCustomerEmail("\t ada@example.com \n"), "ada@example.com");
});

test("only well-formed emails can identify a customer", () => {
  assert.equal(isGroupableCustomerEmail("ada@example.com"), true);
  for (const bad of ["", "ada", "ada@", "@example.com", "ada@example", "a da@example.com", `${"a".repeat(250)}@x.co`]) {
    assert.equal(isGroupableCustomerEmail(bad), false, bad);
  }
});

test("search text is escaped for a literal match", () => {
  const pattern = new RegExp(escapeRegex("a.b(c)*"), "i");
  assert.equal(pattern.test("A.B(C)*"), true);
  assert.equal(pattern.test("axb(c)"), false);
  assert.doesNotThrow(() => new RegExp(escapeRegex("[(")));
});

test("totals are shown per currency and never summed across currencies", () => {
  assert.deepEqual(formatCustomerTotals([]), ["—"]);
  const lines = formatCustomerTotals([
    { currency: "EUR", paid: 10, pending: 0 },
    { currency: "USD", paid: 25, pending: 5 },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /10\.00 paid$/);
  assert.match(lines[1], /25\.00 paid · .*5\.00 awaiting payment/);
});
