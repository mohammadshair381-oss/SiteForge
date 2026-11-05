import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeHtml,
  renderEmailVerificationEmail,
  renderPasswordResetEmail,
} from "../../lib/email-templates";

const RESET_URL = "https://app.example.com/reset-password?token=abc123";
const VERIFY_URL = "https://app.example.com/verify-email?token=xyz789";

test("escapeHtml neutralizes HTML-significant characters", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script> & 'y'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
  );
});

test("password reset template escapes a user-controlled name", () => {
  const rendered = renderPasswordResetEmail({
    name: "<img src=x onerror=alert(1)>",
    resetUrl: RESET_URL,
    expiresInMinutes: 30,
  });

  assert.ok(!rendered.html.includes("<img src=x"));
  assert.ok(rendered.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("password reset template links to the action and avoids premature success claims", () => {
  const rendered = renderPasswordResetEmail({
    resetUrl: RESET_URL,
    expiresInMinutes: 45,
  });

  assert.match(rendered.subject, /Reset your SiteForge password/);
  assert.ok(rendered.html.includes(RESET_URL));
  assert.ok(rendered.text.includes(RESET_URL));
  assert.match(rendered.text, /45 minutes/);
  assert.ok(!/has been reset/i.test(rendered.html));
  assert.ok(!/has been reset/i.test(rendered.text));
});

test("verification template links to the action and states the expiry", () => {
  const rendered = renderEmailVerificationEmail({
    name: "Dana",
    verifyUrl: VERIFY_URL,
    expiresInHours: 24,
  });

  assert.match(rendered.subject, /Confirm your SiteForge email address/);
  assert.ok(rendered.html.includes(VERIFY_URL));
  assert.ok(rendered.text.includes(VERIFY_URL));
  assert.match(rendered.text, /24 hours/);
  assert.ok(!/successfully verified/i.test(rendered.html));
  assert.ok(!/successfully verified/i.test(rendered.text));
});

test("templates ship a plain-text alternative alongside HTML", () => {
  const reset = renderPasswordResetEmail({
    resetUrl: RESET_URL,
    expiresInMinutes: 10,
  });
  const verify = renderEmailVerificationEmail({
    verifyUrl: VERIFY_URL,
    expiresInHours: 1,
  });

  for (const rendered of [reset, verify]) {
    assert.equal(typeof rendered.text, "string");
    assert.ok(rendered.text.length > 0);
    assert.ok(!rendered.text.includes("<"));
    assert.equal(typeof rendered.html, "string");
    assert.ok(rendered.html.length > 0);
  }
});

test("templates avoid tracking pixels, scripts and external assets", () => {
  const reset = renderPasswordResetEmail({
    resetUrl: RESET_URL,
    expiresInMinutes: 10,
  });
  const verify = renderEmailVerificationEmail({
    verifyUrl: VERIFY_URL,
    expiresInHours: 1,
  });

  for (const rendered of [reset, verify]) {
    assert.ok(!/<img/i.test(rendered.html));
    assert.ok(!/background-image/i.test(rendered.html));
    assert.ok(!/<link[^>]+stylesheet/i.test(rendered.html));
    assert.ok(!/<script/i.test(rendered.html));
  }
});
