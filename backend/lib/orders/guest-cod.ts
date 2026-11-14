import crypto from "node:crypto";
import { env } from "@/lib/env";

/**
 * Cash on delivery for a guest (server-only). There is no account to hold responsible, and
 * stock is held from the moment the order is placed, so this keeps limits on both: orders
 * open at once per person, and how long stock waits for the store to confirm.
 */

/** Open guest cash-on-delivery orders one phone number or email address may have per store. */
export const MAX_OPEN_COD_ORDERS_PER_GUEST = 2;
/** Stock is released after this unless the store confirms the order by starting to prepare it. */
export const GUEST_COD_RESERVATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keys for counting a guest's open orders, kept on the order instead of searching by the
 * values themselves. Keyed and bound to the store, so they mean nothing elsewhere.
 */
export function guestCodKeys(businessId: string, input: { email: string; phone: string }): string[] {
  const key = (kind: string, value: string) => `${kind}:${crypto.createHmac("sha256", env().SESSION_SECRET).update(`guest-cod:${businessId}:${kind}:${value}`).digest("hex")}`;
  const phone = input.phone.replace(/\D/g, "").slice(-10);
  return [key("email", input.email.trim().toLowerCase()), ...(phone.length >= 7 ? [key("phone", phone)] : [])];
}
