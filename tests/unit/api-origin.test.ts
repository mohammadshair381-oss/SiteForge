import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedApiOrigin } from "../../lib/host";

test("API writes: same address only, and server callers without an Origin", () => {
  assert.equal(isAllowedApiOrigin(null, "shop.example.com", true), true, "webhooks send no Origin");
  assert.equal(isAllowedApiOrigin("https://shop.example.com", "shop.example.com", true), true);
  assert.equal(isAllowedApiOrigin("https://SHOP.example.com", "shop.example.com", true), true);
  assert.equal(isAllowedApiOrigin("https://evil.example", "shop.example.com", true), false);
  assert.equal(isAllowedApiOrigin("https://other.example.com", "shop.example.com", true), false, "a sibling store is another site here");
  assert.equal(isAllowedApiOrigin("null", "shop.example.com", true), false);
  assert.equal(isAllowedApiOrigin("https://shop.example.com", null, true), false);
  assert.equal(isAllowedApiOrigin("http://shop.example.com", "shop.example.com", true), false, "production is https only");
  assert.equal(isAllowedApiOrigin("http://localhost:3000", "localhost:3000", false), true);
});
