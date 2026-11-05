import mongoose from "mongoose";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { shippingAddressSchema, type ShippingAddress } from "@/lib/checkout-pricing";
import { dbConnect } from "@/lib/db";
import { Customer, type CustomerAddress } from "@/models/Customer";

/**
 * A signed-in customer's saved delivery addresses (server-only). Callers pass the business
 * and customer from `requireCustomer`, never from the client, and every query filters by
 * both, so nobody can reach another customer's addresses. They live on the account, so
 * they are never shared between stores.
 */
export const MAX_SAVED_ADDRESSES = 10;

export const customerAddressInputSchema = shippingAddressSchema.extend({
  label: z.string().trim().max(40, "Keep the label under 40 characters").refine((v) => !/[<>\u0000-\u001f]/.test(v), "Use plain text").prefault(""),
  isDefault: z.boolean().prefault(false),
});
export type CustomerAddressInput = z.infer<typeof customerAddressInputSchema>;

export interface CustomerAddressView extends ShippingAddress {
  id: string;
  label: string;
  isDefault: boolean;
}

function toView(address: CustomerAddress): CustomerAddressView {
  return {
    id: String(address._id),
    label: address.label ?? "",
    name: address.name,
    line1: address.line1,
    line2: address.line2 ?? "",
    city: address.city,
    region: address.region ?? "",
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? "",
    isDefault: address.isDefault === true,
  };
}

const scope = (businessId: unknown, customerId: string) => ({ _id: new mongoose.Types.ObjectId(customerId), business: new mongoose.Types.ObjectId(String(businessId)), active: true });

async function load(businessId: unknown, customerId: string): Promise<CustomerAddress[] | null> {
  if (!mongoose.isValidObjectId(customerId) || !mongoose.isValidObjectId(String(businessId))) return null;
  await dbConnect();
  const customer = await Customer.findOne(scope(businessId, customerId)).select("addresses").lean<{ addresses?: CustomerAddress[] }>();
  return customer ? customer.addresses ?? [] : null;
}

/** Exactly one default whenever any exist. The default is listed first. */
function normalized(addresses: CustomerAddress[], preferred?: string): CustomerAddress[] {
  const chosen = preferred ?? String(addresses.find((a) => a.isDefault)?._id ?? addresses[0]?._id ?? "");
  return addresses.map((a) => ({ ...a, isDefault: String(a._id) === chosen })).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

async function save(businessId: unknown, customerId: string, addresses: CustomerAddress[]): Promise<CustomerAddressView[]> {
  const result = await Customer.updateOne(scope(businessId, customerId), { $set: { addresses } });
  if (result.matchedCount !== 1) throw new HttpError(401, "Please sign in to continue", "customer_unauthenticated");
  return addresses.map(toView);
}

const notFound = () => new HttpError(404, "That address was not found", "not_found");

export async function listCustomerAddresses(businessId: unknown, customerId: string): Promise<CustomerAddressView[]> {
  return ((await load(businessId, customerId)) ?? []).map(toView);
}

export async function addCustomerAddress(businessId: unknown, customerId: string, input: CustomerAddressInput): Promise<CustomerAddressView[]> {
  const current = await load(businessId, customerId);
  if (!current) throw new HttpError(401, "Please sign in to continue", "customer_unauthenticated");
  if (current.length >= MAX_SAVED_ADDRESSES) throw new HttpError(409, `You can save up to ${MAX_SAVED_ADDRESSES} addresses. Delete one to add another.`, "address_limit");
  const id = new mongoose.Types.ObjectId();
  const next = [...current, { ...input, _id: id }];
  return save(businessId, customerId, normalized(next, input.isDefault ? String(id) : undefined));
}

export async function updateCustomerAddress(businessId: unknown, customerId: string, addressId: string, input: CustomerAddressInput): Promise<CustomerAddressView[]> {
  const current = await load(businessId, customerId);
  if (!current) throw new HttpError(401, "Please sign in to continue", "customer_unauthenticated");
  if (!current.some((a) => String(a._id) === addressId)) throw notFound();
  const next = current.map((a) => (String(a._id) === addressId ? { ...input, _id: a._id, isDefault: a.isDefault } : a));
  return save(businessId, customerId, normalized(next, input.isDefault ? addressId : undefined));
}

export async function setDefaultCustomerAddress(businessId: unknown, customerId: string, addressId: string): Promise<CustomerAddressView[]> {
  const current = await load(businessId, customerId);
  if (!current) throw new HttpError(401, "Please sign in to continue", "customer_unauthenticated");
  if (!current.some((a) => String(a._id) === addressId)) throw notFound();
  return save(businessId, customerId, normalized(current, addressId));
}

export async function deleteCustomerAddress(businessId: unknown, customerId: string, addressId: string): Promise<CustomerAddressView[]> {
  const current = await load(businessId, customerId);
  if (!current) throw new HttpError(401, "Please sign in to continue", "customer_unauthenticated");
  if (!current.some((a) => String(a._id) === addressId)) throw notFound();
  return save(businessId, customerId, normalized(current.filter((a) => String(a._id) !== addressId)));
}

const comparable = (a: Partial<ShippingAddress>) => [a.line1, a.line2, a.city, a.postalCode, a.country].map((part) => (part ?? "").trim().toLowerCase().replace(/\s+/g, " ")).join("|");

/**
 * After an order, if the shopper ticked "save this address". Best-effort: a problem here
 * must never affect the order, and an address already saved is not added twice.
 */
export async function saveAddressFromOrder(businessId: unknown, customerId: string, address: ShippingAddress): Promise<void> {
  try {
    const current = await load(businessId, customerId);
    if (!current || current.length >= MAX_SAVED_ADDRESSES) return;
    if (current.some((a) => comparable(a) === comparable(address))) return;
    await save(businessId, customerId, normalized([...current, { ...address, label: "", isDefault: false, _id: new mongoose.Types.ObjectId() }]));
  } catch {
    console.error("[customer-address] an address from an order could not be saved");
  }
}
