/**
 * Post-login destination for storefront customers (pure; safe in client and
 * server code). Only a same-site absolute path is accepted, so `?next=` can
 * never send a signed-in customer to another origin. Anything else is "/".
 */
export function safeStorefrontPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  // Never bounce back into the auth pages themselves.
  if (/^\/account\/(login|register)(\/|\?|#|$)/.test(value)) return "/";
  return value;
}
