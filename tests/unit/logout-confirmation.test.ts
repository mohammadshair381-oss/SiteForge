import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  logoutDialogReducer,
  runLogoutOnce,
  type LogoutDialogState,
} from "../../lib/logout-confirmation";

test("clicking Sign Out opens the confirmation dialog", () => {
  assert.equal(logoutDialogReducer("closed", "OPEN"), "open");
});

test("Cancel closes the dialog without calling the logout action", () => {
  const state = logoutDialogReducer("open", "CANCEL");
  let logoutRequests = 0;

  assert.equal(state, "closed");
  assert.equal(logoutRequests, 0);
});

test("Escape closes the dialog without calling the logout action", () => {
  const state = logoutDialogReducer("open", "ESCAPE");
  let logoutRequests = 0;

  assert.equal(state, "closed");
  assert.equal(logoutRequests, 0);
});

test("confirming Sign Out runs the existing logout flow once", async () => {
  const lock = { current: false };
  let logoutRequests = 0;
  let redirects = 0;
  const completed = await runLogoutOnce(
    lock,
    async () => {
      logoutRequests += 1;
    },
    () => {
      redirects += 1;
    },
  );

  assert.equal(completed, true);
  assert.equal(logoutRequests, 1);
  assert.equal(redirects, 1);
  assert.equal(lock.current, false);
});

test("repeated confirmation clicks cannot issue duplicate logout requests", async () => {
  const lock = { current: false };
  let logoutRequests = 0;
  let releaseRequest: (() => void) | undefined;
  const request = () =>
    new Promise<void>((resolveRequest) => {
      logoutRequests += 1;
      releaseRequest = resolveRequest;
    });
  const onSuccess = () => {};

  const first = runLogoutOnce(lock, request, onSuccess);
  const second = await runLogoutOnce(lock, request, onSuccess);
  assert.equal(second, false);
  assert.equal(logoutRequests, 1);

  releaseRequest?.();
  assert.equal(await first, true);
  assert.equal(lock.current, false);
});

test("desktop and mobile sign-out placements both use the shared confirmation button", () => {
  const root = process.cwd();
  const dashboardShell = readFileSync(
    resolve(root, "components/dashboard/DashboardShell.tsx"),
    "utf8",
  );
  const mobileNavigation = readFileSync(
    resolve(root, "components/dashboard/MobileNav.tsx"),
    "utf8",
  );
  const logoutButton = readFileSync(
    resolve(root, "components/dashboard/LogoutButton.tsx"),
    "utf8",
  );

  assert.match(dashboardShell, /import LogoutButton from "\.\/LogoutButton"/);
  assert.match(dashboardShell, /<LogoutButton\s*\/>/);
  assert.match(mobileNavigation, /import LogoutButton from "\.\/LogoutButton"/);
  assert.match(mobileNavigation, /<LogoutButton\s*\/>/);
  assert.match(logoutButton, /Are you sure you want to sign out of your account\?/);
  assert.match(logoutButton, /dispatch\("ESCAPE"\)/);
});

test("sign-out dialog is portaled above navigation and sized for the mobile viewport", () => {
  const logoutButton = readFileSync(
    resolve(process.cwd(), "components/dashboard/LogoutButton.tsx"),
    "utf8",
  );

  assert.match(logoutButton, /createPortal\([\s\S]*document\.body/);
  assert.match(logoutButton, /fixed inset-0 z-\[70\][^"]*items-center/);
  assert.match(logoutButton, /min-h-\[100dvh\]/);
  assert.match(logoutButton, /overflow-y-auto/);
  assert.match(logoutButton, /max-h-\[calc\(100dvh-2rem\)\]/);
  assert.match(logoutButton, /env\(safe-area-inset-top\)/);
  assert.match(logoutButton, /env\(safe-area-inset-bottom\)/);
  assert.match(logoutButton, /min-h-11/);
  assert.match(logoutButton, /document\.body\.style\.overflow = "hidden"/);
});

test("a failed logout request returns the dialog to the open state for retry", () => {
  let state: LogoutDialogState = "open";
  state = logoutDialogReducer(state, "CONFIRM");
  state = logoutDialogReducer(state, "FAILURE");

  assert.equal(state, "open");
});
