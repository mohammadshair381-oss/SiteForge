import mongoose from "mongoose";
import { dbConnect } from "../db";
import { HttpError } from "../api";
import { isCustomerAccountsEnabled } from "../env";
import { resolveBusinessByHost } from "../tenant";
import { readCustomerSessionCookie, verifyCustomerSession } from "./customer-session";
import { recordRevokedCustomerSession } from "../security-events";
import { Customer } from "@/models/Customer";
import type { BusinessDoc } from "@/models/Business";

/**
 * Storefront customer authorization. Never reads the platform session cookie,
 * never grants platform or business-membership privileges, and is never
 * accepted by `requireUser` / `requireBusinessRole` / `requireSuperAdmin`.
 *
 * The business is resolved ONLY from the request Host (the storefront), never
 * from a client-supplied id. A session is accepted only when:
 *   1. the `sf_customer` token verifies (key, alg, iss, aud, typ, expiry);
 *   2. the token's business equals the host's business;
 *   3. a Customer exists with that id IN that business and is active;
 *   4. the token version matches the customer's current tokenVersion.
 * Every failure is the same 401, so callers learn nothing about which check
 * failed or whether an account exists.
 */

export interface CustomerContext {
  business: BusinessDoc;
  customer: {
    id: string;
    businessId: string;
    name: string;
    email: string;
    emailVerified: boolean;
  };
}

function unauthenticated(): HttpError {
  return new HttpError(401, "Please sign in to continue", "customer_unauthenticated");
}

export async function requireCustomer(
  request: Request,
  options: { requireVerifiedEmail?: boolean } = {},
): Promise<CustomerContext> {
  // Feature gate (default off): the same 404 as an unavailable store.
  if (!isCustomerAccountsEnabled()) {
    throw new HttpError(404, "This store is not available", "not_found");
  }
  const claims = await verifyCustomerSession(readCustomerSessionCookie(request));
  if (!claims) throw unauthenticated();

  await dbConnect();
  const business = await resolveBusinessByHost(request.headers.get("host"));
  if (!business || String(business._id) !== claims.businessId) throw unauthenticated();

  const customer = await Customer.findOne({
    _id: new mongoose.Types.ObjectId(claims.customerId),
    business: business._id,
  })
    .select("name email tokenVersion emailVerifiedAt business active")
    .lean();
  // A correctly signed session for this store whose account is gone,
  // deactivated or revoked: recorded (throttled, after the response), and the
  // same 401 as every other failure.
  if (!customer || !customer.active || (customer.tokenVersion ?? 0) !== claims.tokenVersion) {
    recordRevokedCustomerSession({
      request,
      businessId: business._id,
      customerId: claims.customerId,
      reason: !customer ? "account_missing" : !customer.active ? "inactive_account" : "token_version_mismatch",
    });
    throw unauthenticated();
  }

  const emailVerified = customer.emailVerifiedAt instanceof Date;
  if (options.requireVerifiedEmail && !emailVerified) {
    throw new HttpError(403, "Verify your email address to continue", "customer_email_unverified");
  }

  return {
    business,
    customer: {
      id: String(customer._id),
      businessId: String(customer.business),
      name: customer.name,
      email: customer.email,
      emailVerified,
    },
  };
}

/**
 * Who is checking out, for the storefront checkout (Phase 4B).
 *
 * Unlike `requireCustomer`, this never throws the feature-gate 404, so guest
 * checkout keeps working while customer accounts are off. `business` must be
 * the store the CALLER already resolved from the Host through the commerce
 * gate (`resolveCommerceBusiness`); a URL id never decides it. The customer
 * comes only from the verified session cookie plus the database record.
 *
 * - `disabled`: customer accounts are off (guest checkout only);
 * - `none`: no session cookie (guest);
 * - `invalid`: bad signature, expired, revoked (token version) or unknown;
 * - `other_store`: a valid session of another business;
 * - `inactive` / `unverified`: the account cannot use authenticated checkout;
 * - `customer`: a verified, active customer of THIS business.
 */
export type CheckoutCustomerResolution =
  | { status: "disabled" | "none" | "invalid" | "other_store" | "inactive" | "unverified" }
  | { status: "customer"; customer: { id: string; name: string; email: string } };

export async function resolveCheckoutCustomer(
  request: Request,
  business: Pick<BusinessDoc, "_id">,
): Promise<CheckoutCustomerResolution> {
  if (!isCustomerAccountsEnabled()) return { status: "disabled" };
  const token = readCustomerSessionCookie(request);
  if (!token) return { status: "none" };
  const claims = await verifyCustomerSession(token);
  if (!claims) return { status: "invalid" };
  if (claims.businessId !== String(business._id)) return { status: "other_store" };

  await dbConnect();
  const customer = await Customer.findOne({
    _id: new mongoose.Types.ObjectId(claims.customerId),
    business: business._id,
  })
    .select("name email tokenVersion emailVerifiedAt active")
    .lean();
  if (!customer || (customer.tokenVersion ?? 0) !== claims.tokenVersion) {
    recordRevokedCustomerSession({
      request,
      businessId: business._id,
      customerId: claims.customerId,
      reason: customer ? "token_version_mismatch" : "account_missing",
    });
    return { status: "invalid" };
  }
  if (!customer.active) {
    recordRevokedCustomerSession({ request, businessId: business._id, customerId: claims.customerId, reason: "inactive_account" });
    return { status: "inactive" };
  }
  if (!(customer.emailVerifiedAt instanceof Date)) return { status: "unverified" };
  return {
    status: "customer",
    customer: { id: String(customer._id), name: customer.name, email: customer.email },
  };
}

/** Non-throwing variant for pages that render differently when signed out. */
export async function getCustomer(request: Request): Promise<CustomerContext | null> {
  try {
    return await requireCustomer(request);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Revokes every session of one customer (logout everywhere / password reset).
 * Scoped to the business so an id from another tenant changes nothing.
 */
export async function revokeCustomerSessions(businessId: string, customerId: string): Promise<boolean> {
  if (!mongoose.isValidObjectId(customerId) || !mongoose.isValidObjectId(businessId)) return false;
  await dbConnect();
  const result = await Customer.updateOne(
    { _id: customerId, business: businessId },
    { $inc: { tokenVersion: 1 } },
  );
  return result.matchedCount === 1;
}
