import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

// Safe dummy configuration; no real secrets. Set before the first env() call so
// the cached parse sees the memory transport selected below.
process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "a".repeat(40);
(process.env as unknown as Record<string, string | undefined>).NODE_ENV = "test";
process.env.EMAIL_PROVIDER = "memory";
delete process.env.EMAIL_API_KEY;
delete process.env.EMAIL_FROM;
delete process.env.EMAIL_REPLY_TO;
delete process.env.APP_URL;

import { clearEmailOutbox, getEmailOutbox, sendEmail } from "../../lib/email";

beforeEach(() => clearEmailOutbox());

test("sendEmail uses the configured memory transport end to end", async () => {
  const result = await sendEmail({
    to: "user@example.com",
    subject: "Welcome",
    text: "plain body",
    html: "<p>html body</p>",
  });

  assert.equal(result.provider, "memory");
  assert.equal(result.id, null);

  const outbox = getEmailOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "user@example.com");
  assert.equal(outbox[0].subject, "Welcome");
});
