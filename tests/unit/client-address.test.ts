import assert from "node:assert/strict";
import test from "node:test";

import { parseIPv6, rateLimitSourceKey } from "../../lib/client-address";

test("IPv4 addresses are one source each; a port is ignored", () => {
  assert.equal(rateLimitSourceKey("203.0.113.7"), "ipv4:203.0.113.7");
  assert.equal(rateLimitSourceKey(" 203.0.113.7 "), "ipv4:203.0.113.7");
  assert.equal(rateLimitSourceKey("203.0.113.7:51234"), "ipv4:203.0.113.7");
  assert.notEqual(rateLimitSourceKey("203.0.113.7"), rateLimitSourceKey("203.0.113.8"));
  assert.equal(rateLimitSourceKey("0.0.0.0"), "ipv4:0.0.0.0");
  assert.equal(rateLimitSourceKey("255.255.255.255"), "ipv4:255.255.255.255");
});

test("IPv6 addresses are grouped by /64 regardless of spelling", () => {
  const key = "ipv6/64:2001:db8:1:2";
  for (const address of [
    "2001:db8:1:2::1",
    "2001:db8:1:2:ffff:ffff:ffff:ffff",
    "2001:0DB8:0001:0002:0000:0000:0000:0042",
    "[2001:db8:1:2::9]",
    "[2001:db8:1:2::9]:443",
    "2001:db8:1:2::7%eth0",
  ]) {
    assert.equal(rateLimitSourceKey(address), key, address);
  }
  assert.equal(rateLimitSourceKey("2001:db8:1:3::1"), "ipv6/64:2001:db8:1:3", "neighbouring /64 is another source");
  assert.equal(rateLimitSourceKey("::1"), "ipv6/64:0:0:0:0");
  assert.equal(rateLimitSourceKey("fe80::1"), "ipv6/64:fe80:0:0:0");
});

test("IPv4 embedded in IPv6 (mapped, NAT64) is keyed as the IPv4 address", () => {
  assert.equal(rateLimitSourceKey("::ffff:203.0.113.7"), "ipv4:203.0.113.7");
  assert.equal(rateLimitSourceKey("::ffff:cb00:7107"), "ipv4:203.0.113.7");
  assert.equal(rateLimitSourceKey("[::ffff:203.0.113.7]:80"), "ipv4:203.0.113.7");
  assert.equal(rateLimitSourceKey("64:ff9b::203.0.113.7"), "ipv4:203.0.113.7");
  // A different NAT64 client is a different source (not one shared /64).
  assert.equal(rateLimitSourceKey("64:ff9b::198.51.100.1"), "ipv4:198.51.100.1");
});

test("missing, unknown and malformed values map to shared buckets, never fresh sources", () => {
  assert.equal(rateLimitSourceKey(undefined), "missing");
  assert.equal(rateLimitSourceKey(null), "missing");
  assert.equal(rateLimitSourceKey(""), "missing");
  assert.equal(rateLimitSourceKey("   "), "missing");
  assert.equal(rateLimitSourceKey("unknown"), "unknown");
  for (const bad of [
    "not-an-ip",
    "garbage-2",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "01.2.3.4",
    "1.2.3.4:",
    "1.2.3.4:999999",
    ":::",
    "1:::2",
    ":1",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "2001:db8::g",
    "12345::1",
    "::ffff:300.1.1.1",
    "[2001:db8::1",
    "x".repeat(200),
    "203.0.113.7, 198.51.100.1",
  ]) {
    assert.equal(rateLimitSourceKey(bad), "unparseable", bad);
  }
});

test("parseIPv6 expands every valid spelling to eight hextets", () => {
  assert.deepEqual(parseIPv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseIPv6("1::"), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseIPv6("::2"), [0, 0, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:1.2.3.4"), [1, 2, 3, 4, 5, 6, 0x102, 0x304]);
  assert.equal(parseIPv6("1:2:3:4:5:6:7::8"), null, ":: must stand for at least one group");
  assert.equal(parseIPv6("1.2.3.4"), null);
});
