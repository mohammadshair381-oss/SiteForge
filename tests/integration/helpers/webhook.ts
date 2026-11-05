import crypto from "node:crypto";

import { createUser } from "./fixtures";
import { Business } from "@/models/Business";
import { Plan } from "@/models/Plan";
import { Subscription } from "@/models/Subscription";

export const WEBHOOK_URL = "http://localhost/api/webhooks/payments";

/**
 * Computes the HMAC-SHA256 hex digest the payments webhook expects, matching
 * app/api/webhooks/payments/route.ts. Signatures are always generated here so
 * tests never hardcode a digest.
 */
export function signBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Builds a POST request to the payments webhook. When `signature` is null the
 * `x-signature` header is omitted entirely, to model the missing-signature case.
 */
export function webhookRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) {
    headers["x-signature"] = signature;
  }
  return new Request(WEBHOOK_URL, { method: "POST", headers, body });
}

/**
 * Creates a business with an `incomplete` subscription so webhook side effects
 * (activation, period timestamps) are observable. The subscription is left
 * non-active on purpose so tests can prove a rejected request did not mutate it.
 */
export async function createBusinessWithSubscription() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await createUser({ email: `webhook-${suffix}@example.com` });

  const business = await Business.create({
    name: "Webhook Test Business",
    slug: `webhook-biz-${suffix}`,
    subdomain: `webhook-biz-${suffix}`,
    category: "services",
    owner: user._id,
  });

  const plan = await Plan.create({
    key: `testplan-webhook-${suffix}`,
    name: "Webhook Test Plan",
    description: "Plan for webhook integration tests",
    // 2900 is the amount every webhook test signs (Phase 4.7 validates
    // event.amount against plan.price, so the fixture must agree).
    price: 2900,
    currency: "USD",
    features: {
      productLimit: 5,
      staffLimit: 2,
      customDomain: false,
      removeBranding: false,
    },
    active: true,
  });

  const subscription = await Subscription.create({
    business: business._id,
    plan: plan._id,
    status: "incomplete",
    provider: "manual",
  });

  return { user, business, plan, subscription };
}
