import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getTestMongoUri,
  startIntegrationSuite,
  stopIntegrationSuite,
} from "./helpers/env";
import {
  clearAllCollections,
  connectTestDB,
  disconnectTestDB,
} from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser } from "./helpers/auth";
import {
  clearRequestCookies,
  setRequestCookiesFromHeader,
} from "./helpers/mock-next-headers-setup";
import { HttpError } from "@/lib/api";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";

// The test runner transpiles TSX to classic React.createElement calls. Make the
// runtime available globally before the page module (and its client component)
// is loaded in the `before` hook below.
(globalThis as unknown as { React?: typeof React }).React = React;

type MediaPageComponent = (props: {
  params: Promise<{ id: string }>;
}) => Promise<React.ReactElement>;

let BusinessMedia: MediaPageComponent;

before(async () => {
  await startIntegrationSuite();
  // Imported dynamically so the React global above is in place before the
  // client component's module-level JSX is evaluated.
  const pageModule = await import(
    "@/app/dashboard/businesses/[id]/media/page"
  );
  BusinessMedia = pageModule.default;

  const uri = getTestMongoUri();
  if (
    !uri.startsWith("mongodb://127.0.0.1:") &&
    !uri.startsWith("mongodb://localhost:")
  ) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
  clearRequestCookies();
});

async function setupBusiness(email: string, slug: string) {
  const owner = await createUser({ email, name: slug });
  const business = await Business.create({
    name: slug,
    slug,
    subdomain: slug,
    category: "retail",
    owner: owner._id,
    description: "A test business",
  });
  await Membership.create({
    business: business._id,
    user: owner._id,
    role: "owner",
    status: "active",
  });
  const headers = await createAuthHeadersForUser(
    String(owner._id),
    "user",
    owner.tokenVersion,
  );
  return { owner, business, headers };
}

async function renderMediaPage(businessId: string, cookie: string | null) {
  setRequestCookiesFromHeader(cookie);
  try {
    const element = await BusinessMedia({
      params: Promise.resolve({ id: businessId }),
    });
    return renderToStaticMarkup(element);
  } finally {
    clearRequestCookies();
  }
}

test("media page: unauthenticated visitors are rejected", async () => {
  const { business } = await setupBusiness("media-page-anon@test.com", "anon-shop");

  await assert.rejects(
    () => renderMediaPage(String(business._id), null),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
});

test("media page: users without a membership get 403", async () => {
  const { business } = await setupBusiness("media-page-owner@test.com", "owned-shop");
  const outsider = await createUser({ email: "media-page-outsider@test.com" });
  const outsiderHeaders = await createAuthHeadersForUser(
    String(outsider._id),
    "user",
    outsider.tokenVersion,
  );

  await assert.rejects(
    () => renderMediaPage(String(business._id), outsiderHeaders.cookie),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );
});

test("media page: members see the upload controls for their business", async () => {
  const { business, headers } = await setupBusiness(
    "media-page-member@test.com",
    "member-shop",
  );

  const html = await renderMediaPage(String(business._id), headers.cookie);

  assert.match(html, new RegExp(`data-business-id="${String(business._id)}"`));
  assert.match(html, /Upload images/);
  assert.match(html, /Drag images here or choose files/);
  assert.match(html, /Your images/);
  assert.match(
    html,
    /accept="image\/jpeg,image\/png,image\/webp,image\/gif"/,
  );
  assert.match(html, /Loading your images/);
  assert.doesNotMatch(html, /storageKey/i);
  assert.doesNotMatch(html, /AWS_(ACCESS|SECRET|REGION|S3)/);
});
