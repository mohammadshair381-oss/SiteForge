import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderLoginCodeEmail } from "../../backend/lib/email-templates";

const PURPOSES = ["login", "signup", "reset"] as const;
const render = (purpose: (typeof PURPOSES)[number], name: string | null = "Ada") => renderLoginCodeEmail({ name, code: "042042", expiresInMinutes: 5, purpose });

test("escapeHtml neutralizes HTML-significant characters", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>&'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
});

test("each code email says what the code is for, with its own subject", () => {
  const subjects = PURPOSES.map((purpose) => render(purpose).subject);
  assert.deepEqual(subjects, ["Your SiteForge sign-in code", "Your SiteForge confirmation code", "Your SiteForge password reset code"]);
  assert.match(render("signup").text, /confirm your email/i);
  assert.match(render("reset").text, /new password/i);
  assert.match(render("login").text, /finish logging in/i);
  assert.equal(renderLoginCodeEmail({ code: "042042", expiresInMinutes: 5 }).subject, subjects[0], "login is the default");
});

test("code emails carry the code, its expiry, and no link", () => {
  for (const purpose of PURPOSES) {
    const rendered = render(purpose);
    assert.match(rendered.text, /^ {4}042042$/m, "the code keeps its leading zero");
    assert.match(rendered.text, /expires in 5 minutes and can be used once/);
    assert.ok(!/https?:\/\//.test(rendered.text), `${purpose}: no link in the text`);
  }
  assert.throws(() => renderLoginCodeEmail({ code: "12345", expiresInMinutes: 5 }));
});

test("code emails escape a user-controlled name", () => {
  const rendered = render("signup", `<b>Ada</b> & "co"`);
  assert.ok(!rendered.html.includes("<b>Ada</b>"));
  assert.ok(rendered.html.includes("&lt;b&gt;Ada&lt;/b&gt; &amp; &quot;co&quot;"));
});

test("templates ship a plain-text alternative alongside HTML", () => {
  for (const purpose of PURPOSES) {
    const rendered = render(purpose);
    assert.equal(typeof rendered.text, "string");
    assert.ok(rendered.text.length > 0);
    assert.ok(!rendered.text.includes("<"));
    assert.ok(rendered.html.length > 0);
  }
});

test("templates avoid tracking pixels, scripts and external assets", () => {
  for (const purpose of PURPOSES) {
    const { html } = render(purpose);
    assert.ok(!/<img/i.test(html));
    assert.ok(!/background-image/i.test(html));
    assert.ok(!/<link[^>]+stylesheet/i.test(html));
    assert.ok(!/<script/i.test(html));
  }
});
