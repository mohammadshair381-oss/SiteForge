import assert from "node:assert/strict";
import test, { before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// TSX in this test runner compiles to classic React.createElement calls.
(globalThis as unknown as { React?: typeof React }).React = React;

type Forms = typeof import("../../components/storefront/account/AccountForms");
let ChangePasswordForm: Forms["ChangePasswordForm"];
let ForgotPasswordForm: Forms["ForgotPasswordForm"];
let LoginForm: Forms["LoginForm"];
let RegisterForm: Forms["RegisterForm"];
let ResetPasswordForm: Forms["ResetPasswordForm"];
let SuccessBox: Forms["SuccessBox"];
let VerifyEmailForm: Forms["VerifyEmailForm"];

before(async () => {
  ({ ChangePasswordForm, ForgotPasswordForm, LoginForm, RegisterForm, ResetPasswordForm, SuccessBox, VerifyEmailForm } = await import(
    "../../components/storefront/account/AccountForms"
  ));
});

/**
 * Static markup checks for the storefront account forms. Focus movement runs
 * in a browser effect and is not exercised here (no DOM library is installed);
 * the SuccessBox contract it relies on (focusable, no duplicate live role) is.
 */

const html = (element: React.ReactElement) => renderToStaticMarkup(element);
const count = (markup: string, pattern: RegExp) => (markup.match(pattern) ?? []).length;

test("every input has a stable name and the right autocomplete", () => {
  const register = html(React.createElement(RegisterForm));
  for (const [name, autocomplete] of [
    ["name", "name"],
    ["email", "email"],
    ["password", "new-password"],
    ["confirmPassword", "new-password"],
  ]) {
    const input = register.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
    assert.match(input, new RegExp(`autocomplete="${autocomplete}"`, "i"), name);
  }
  const login = html(React.createElement(LoginForm, { next: "/" }));
  assert.match(login, /name="email"/);
  assert.match(login.match(/<input[^>]*name="password"[^>]*>/)?.[0] ?? "", /autocomplete="current-password"/i);
  const reset = html(React.createElement(ResetPasswordForm, { token: "t".repeat(43) }));
  assert.match(reset, /name="newPassword"/);
  assert.match(reset, /name="confirmNewPassword"/);
  assert.match(html(React.createElement(ForgotPasswordForm)), /name="email"/);
  assert.match(html(React.createElement(VerifyEmailForm, { token: "t".repeat(43) })), /name="password"/);
});

test("every input is labelled", () => {
  const markup = html(React.createElement(RegisterForm));
  const ids = [...markup.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 4);
  for (const id of ids) assert.match(markup, new RegExp(`<label[^>]*for="${id.replace(/[:]/g, "\\:")}"`));
});

test("password toggles name the field and the action, without a conflicting pressed state", () => {
  const markup = html(React.createElement(RegisterForm));
  assert.match(markup, /aria-label="Show password"/);
  assert.match(markup, /aria-label="Show confirm password"/);
  assert.doesNotMatch(markup, /aria-pressed/);
  // The accessible name contains the visible text ("Show").
  assert.match(markup, /aria-label="Show password"[^>]*>Show</);
});

test("one persistent alert region per form and no nested live regions", () => {
  for (const markup of [
    html(React.createElement(RegisterForm)),
    html(React.createElement(LoginForm, { next: "/" })),
    html(React.createElement(ForgotPasswordForm)),
    html(React.createElement(ResetPasswordForm, { token: "t".repeat(43) })),
  ]) {
    assert.equal(count(markup, /role="alert"/g), 1, "exactly one alert region, mounted while empty");
    assert.doesNotMatch(markup, /aria-live=/, "no extra live region wrapped around the alert");
  }
  // Login keeps a polite status region for the inline "link sent" message.
  assert.equal(count(html(React.createElement(LoginForm, { next: "/" })), /role="status"/g), 1);
});

test("the success message that replaces a form is focusable and not a second live region", () => {
  const markup = html(React.createElement(SuccessBox, { text: "Check your inbox." }));
  assert.match(markup, /tabindex="-1"/i);
  assert.doesNotMatch(markup, /role=/);
  assert.match(markup, /Check your inbox\./);
});

test("changing a password asks for the current one, with the right autocomplete hints", () => {
  const markup = html(React.createElement(ChangePasswordForm));
  // Both attributes on the same input, in either order.
  assert.match(markup, /<input(?=[^>]*name="currentPassword")(?=[^>]*autocomplete="current-password")/i);
  assert.match(markup, /<input(?=[^>]*name="newPassword")(?=[^>]*autocomplete="new-password")/i);
  assert.match(markup, /<input(?=[^>]*name="confirmNewPassword")(?=[^>]*autocomplete="new-password")/i);
  assert.equal(count(markup, /role="alert"/g), 1);
});

test("forms take their look from the theme tokens, not fixed light colours", () => {
  for (const markup of [html(React.createElement(LoginForm, { next: "/" })), html(React.createElement(ChangePasswordForm))]) {
    assert.match(markup, /sf-acc-input/);
    assert.doesNotMatch(markup, /(?:bg-white|text-slate-|border-slate-)/);
  }
});

test("buttons take their text colour from the contrast-checked theme variable", () => {
  const markup = html(React.createElement(LoginForm, { next: "/" }));
  assert.match(markup, /<button type="submit"[^>]*style="background:var\(--sf-accent, #4f46e5\);color:var\(--sf-accent-text, #ffffff\)"/);
  assert.doesNotMatch(markup, /type="submit"[^>]*text-white/);
});
