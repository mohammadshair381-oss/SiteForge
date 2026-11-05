import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { POST as applyPlan } from "@/app/api/businesses/[id]/planning/apply/route";
import { Page } from "@/models/Page";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { createBusinessWithOwner } from "./helpers/tenant";

before(async () => {
  await startIntegrationSuite();
  assert.match(getTestMongoUri(), /^mongodb:\/\/(127\.0\.0\.1|localhost):/);
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(clearAllCollections);

test("a plan can no longer be written straight to pages: it must become a proposal", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "draft" });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const plan = { siteName: "Shop", pages: [{ title: "About", slug: "about", isHome: false, sections: [] }] };
  const res = await callHandler(applyPlan, new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(plan) }));
  assert.equal(res.status, 410);
  assert.equal((await res.json()).code, "use_proposal_workflow");
  assert.equal(await Page.countDocuments({ business: business._id }), 0);
});
