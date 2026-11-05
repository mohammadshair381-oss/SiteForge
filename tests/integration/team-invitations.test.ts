import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { createUser } from "./helpers/fixtures";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { clearEmailOutbox, getEmailOutbox } from "@/lib/email";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { TeamInvitation } from "@/models/TeamInvitation";
import { User } from "@/models/User";
import { POST as invitePOST } from "@/app/api/businesses/[id]/members/route";
import { GET as invitationsGET } from "@/app/api/businesses/[id]/invitations/route";
import { DELETE as invitationDELETE, POST as invitationResendPOST } from "@/app/api/businesses/[id]/invitations/[invitationId]/route";
import { POST as acceptPOST } from "@/app/api/invitations/accept/route";
import { POST as inspectPOST } from "@/app/api/invitations/inspect/route";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});

after(async () => {
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await drainAfterResponseTasks();
  await clearAllCollections();
  clearEmailOutbox();
  resetMockCookieStore();
});

async function setup(staffLimit = 5) {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 0, staffLimit });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  return { owner, business, id: String(business._id), headers: await headersFor(owner) };
}

const headersFor = (user: { _id: unknown; tokenVersion?: number }) => createAuthHeadersForUser(String(user._id), "user", user.tokenVersion ?? 0);
const req = (method: string, body: unknown, headers: unknown = {}) =>
  new Request("http://localhost/x", { method, headers: { "Content-Type": "application/json", ...(headers as Record<string, string>) }, body: method === "GET" ? undefined : JSON.stringify(body) });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

async function invite(id: string, headers: unknown, email: string, role = "staff") {
  const res = await callHandler(invitePOST, req("POST", { email, role }, headers), ctx({ id }));
  await drainAfterResponseTasks();
  return res;
}
const lastToken = () => {
  const message = getEmailOutbox().at(-1);
  const match = /invitations\/accept#token=([A-Za-z0-9_-]+)/.exec(message?.text ?? "");
  assert.ok(match, "the email holds a link with the token after #");
  return match[1];
};
const accept = (token: string, headers: unknown) => callHandler(acceptPOST, req("POST", { token }, headers));

test("inviting answers the same for any address, adds nobody, and stores only a hash", async () => {
  const { id, headers } = await setup();
  const known = await createUser({ email: "known@example.test" });
  const first = await invite(id, headers, known.email);
  const second = await invite(id, headers, "nobody@example.test");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const shape = (body: { invitation: Record<string, unknown> }) => Object.keys(body.invitation).sort();
  assert.deepEqual(shape(await first.json()), shape(await second.json()));
  assert.equal(await Membership.countDocuments({ business: id, user: known._id }), 0, "not a member until accepted");
  const stored = await TeamInvitation.findOne({ email: known.email }).select("+tokenHash").lean();
  assert.match(stored?.tokenHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(getEmailOutbox().some((m) => m.text.includes(stored?.tokenHash ?? "none")), false);
});

test("accepting adds the member once, only for the invited address", async () => {
  const { id, headers } = await setup();
  const invited = await createUser({ email: "invited@example.test" });
  const other = await createUser({ email: "other@example.test" });
  await invite(id, headers, invited.email, "manager");
  const token = lastToken();

  const view = await callHandler(inspectPOST, req("POST", { token }, await headersFor(invited)));
  assert.equal(view.status, 200);
  assert.equal((await view.json()).sameAccount, true);

  assert.equal((await accept(token, {})).status, 401);
  const wrong = await accept(token, await headersFor(other));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).code, "wrong_account");

  assert.equal((await accept(token, await headersFor(invited))).status, 200);
  const member = await Membership.findOne({ business: id, user: invited._id }).lean();
  assert.equal(member?.role, "manager");
  assert.equal(member?.status, "active");
  assert.equal((await accept(token, await headersFor(invited))).status, 400, "single use");
  assert.equal(await Membership.countDocuments({ business: id, user: invited._id }), 1);
});

test("concurrent accepts create one membership", async () => {
  const { id, headers } = await setup();
  const invited = await createUser({ email: "race@example.test" });
  await invite(id, headers, invited.email);
  const token = lastToken();
  const auth = await headersFor(invited);
  const results = await Promise.all([1, 2, 3, 4].map(() => accept(token, auth)));
  assert.equal(results.filter((res) => res.status === 200).length, 1);
  assert.equal(await Membership.countDocuments({ business: id, user: invited._id }), 1);
});

test("an unconfirmed account cannot accept", async () => {
  const { id, headers } = await setup();
  const invited = await createUser({ email: "new@example.test" });
  await User.updateOne({ _id: invited._id }, { $set: { emailVerifiedAt: null } });
  await invite(id, headers, invited.email);
  assert.equal((await accept(lastToken(), await headersFor(invited))).status, 403);
});

test("expired and revoked invitations stop working, and resend retires the old link", async () => {
  const { id, headers } = await setup();
  const invited = await createUser({ email: "person@example.test" });
  const auth = await headersFor(invited);

  await invite(id, headers, invited.email);
  const expiredToken = lastToken();
  await TeamInvitation.updateOne({ email: invited.email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await accept(expiredToken, auth)).status, 400);

  const body = await (await invite(id, headers, invited.email)).json();
  const oldToken = lastToken();
  assert.equal(await TeamInvitation.countDocuments({ email: invited.email, status: "pending" }), 1, "one live invitation per person");
  assert.equal((await callHandler(invitationResendPOST, req("POST", {}, headers), ctx({ id, invitationId: body.invitation.id }))).status, 200);
  await drainAfterResponseTasks();
  const newToken = lastToken();
  assert.notEqual(newToken, oldToken);
  assert.equal((await accept(oldToken, auth)).status, 400);

  assert.equal((await callHandler(invitationDELETE, req("DELETE", {}, headers), ctx({ id, invitationId: body.invitation.id }))).status, 200);
  assert.equal((await accept(newToken, auth)).status, 400);
  assert.equal(await Membership.countDocuments({ business: id, user: invited._id }), 0);
});

test("the inviter, the store and the plan are checked again when accepting", async () => {
  const { id, headers, owner, business } = await setup();
  const invited = await createUser({ email: "later@example.test" });
  const auth = await headersFor(invited);

  // A manager who has since lost the right to invite.
  const manager = await createUser({ email: "manager@example.test" });
  await createMembership(business._id, manager._id, "manager");
  await Business.updateOne({ _id: id }, { $set: { managersCanInvite: true } });
  await invite(id, await headersFor(manager), invited.email, "staff");
  const managerToken = lastToken();
  await Business.updateOne({ _id: id }, { $set: { managersCanInvite: false } });
  assert.equal((await accept(managerToken, auth)).status, 400);

  // A suspended store.
  await invite(id, headers, invited.email, "staff");
  const suspendedToken = lastToken();
  await Business.updateOne({ _id: id }, { $set: { status: "suspended" } });
  assert.equal((await accept(suspendedToken, auth)).status, 400);
  await Business.updateOne({ _id: id }, { $set: { status: "published" } });

  // A plan that has run out of places since.
  await Business.updateOne({ _id: id }, { $set: { owner: owner._id } });
  const tight = await setup(0);
  await invite(tight.id, tight.headers, invited.email, "staff").catch(() => undefined);
  assert.equal(await Membership.countDocuments({ business: tight.id, user: invited._id }), 0);
});

test("managers invite staff only, only if allowed; staff and other stores cannot", async () => {
  const { id, business, headers } = await setup();
  const manager = await createUser({ email: "m@example.test" });
  const staff = await createUser({ email: "s@example.test" });
  await createMembership(business._id, manager._id, "manager");
  await createMembership(business._id, staff._id, "staff");
  const managerAuth = await headersFor(manager);

  assert.equal((await invite(id, managerAuth, "a@example.test", "staff")).status, 403);
  await Business.updateOne({ _id: id }, { $set: { managersCanInvite: true } });
  assert.equal((await invite(id, managerAuth, "a@example.test", "staff")).status, 201);
  assert.equal((await invite(id, managerAuth, "b@example.test", "manager")).status, 403);
  assert.equal((await invite(id, managerAuth, "c@example.test", "owner")).status, 403);
  assert.equal((await invite(id, await headersFor(staff), "d@example.test", "staff")).status, 403);

  const body = await (await invite(id, headers, "owner-made@example.test", "manager")).json();
  assert.equal((await callHandler(invitationDELETE, req("DELETE", {}, managerAuth), ctx({ id, invitationId: body.invitation.id }))).status, 404, "a manager cannot cancel an invitation above them");

  const other = await setup();
  assert.equal((await callHandler(invitationDELETE, req("DELETE", {}, other.headers), ctx({ id: other.id, invitationId: body.invitation.id }))).status, 404, "another store's invitation");
  assert.equal((await callHandler(invitationsGET, req("GET", null, other.headers), ctx({ id }))).status, 403);
});

test("a current member keeps their role when accepting", async () => {
  const { id, business, headers } = await setup();
  const manager = await createUser({ email: "existing@example.test" });
  await createMembership(business._id, manager._id, "manager");
  await invite(id, headers, manager.email, "staff");
  const res = await accept(lastToken(), await headersFor(manager));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).alreadyMember, true);
  assert.equal((await Membership.findOne({ business: id, user: manager._id }).lean())?.role, "manager");
});
