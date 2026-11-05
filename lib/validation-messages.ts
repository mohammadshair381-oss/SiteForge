import { z, type ZodError } from "zod";

/**
 * Readable validation messages, used by the API and by client-side checks.
 *
 * A message written in a schema is a complete sentence and is shown as it is. The
 * defaults below are fragments starting in lower case ("is required"), which
 * `formatValidationError` completes with the field's name.
 */
type LocaleIssue = {
  code?: string;
  input?: unknown;
  expected?: unknown;
  origin?: unknown;
  format?: unknown;
  minimum?: unknown;
  maximum?: unknown;
};

function sizeText(origin: unknown, limit: unknown): string {
  if (origin === "string") return `${limit} character${limit === 1 ? "" : "s"}`;
  if (origin === "array" || origin === "set") return `${limit} item${limit === 1 ? "" : "s"}`;
  return String(limit);
}

function fragmentFor(issue: LocaleIssue): string {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined || issue.input === null) return "is required";
      if (issue.expected === "number" || issue.expected === "int") return "must be a number";
      if (issue.expected === "boolean") return "must be on or off";
      if (issue.expected === "date") return "must be a date";
      if (issue.expected === "array") return "must be a list";
      return "is not in the right format";
    case "too_small":
      if (issue.origin === "string" && issue.minimum === 1) return "is required";
      if (issue.origin === "array" || issue.origin === "set") return `needs at least ${sizeText(issue.origin, issue.minimum)}`;
      return `must be at least ${sizeText(issue.origin, issue.minimum)}`;
    case "too_big":
      if (issue.origin === "array" || issue.origin === "set") return `can have at most ${sizeText(issue.origin, issue.maximum)}`;
      return `must be at most ${sizeText(issue.origin, issue.maximum)}`;
    case "invalid_format":
      if (issue.format === "email") return "must be a valid email address";
      if (issue.format === "url") return "must be a valid web address";
      return "is not in the right format";
    case "invalid_value":
      return "is not one of the available choices";
    case "unrecognized_keys":
      return "contains something that cannot be changed here";
    case "not_multiple_of":
      return "is not a valid amount";
    default:
      return "is not valid";
  }
}

z.config({ localeError: (issue) => fragmentFor(issue as unknown as LocaleIssue) });

/** Names people use for fields whose names in the code would not read well. */
const FIELD_LABELS: Record<string, string> = {
  line1: "Address",
  line2: "Apartment or suite",
  postalCode: "Postal code",
  region: "State or region",
  customerName: "Name",
  customerEmail: "Email",
  shippingAddress: "Delivery address",
  compareAtPrice: "Original price",
  lowStockThreshold: "Low-stock level",
  imageUrl: "Image",
  imageAlt: "Image description",
  seoTitle: "Search title",
  seoDescription: "Search description",
  sku: "SKU",
  planKey: "Plan",
  themeId: "Theme",
  primaryColor: "Main colour",
  accentColor: "Accent colour",
  contactEmail: "Contact email",
  logoUrl: "Logo",
  subdomain: "Store address",
  serviceArea: "Service area",
  supportEmail: "Support email",
  maintenanceMessage: "Maintenance message",
  freeOver: "Free shipping amount",
  flatRate: "Shipping rate",
  minOrder: "Minimum order",
  codMaxOrder: "Largest cash-on-delivery order",
  minSubtotal: "Minimum order",
  maxDiscount: "Largest discount",
  perCustomerLimit: "Limit per customer",
  usageLimit: "Total uses",
  couponCode: "Discount code",
  keyId: "Key ID",
  keySecret: "Key secret",
  webhookSecret: "Webhook secret",
  currentPassword: "Current password",
  newPassword: "New password",
  confirmNewPassword: "Password confirmation",
  ctaText: "Button text",
  ctaHref: "Button link",
  buttonText: "Button text",
  buttonHref: "Button link",
};

function labelFor(path: ReadonlyArray<PropertyKey>): string {
  // The last named part; list positions say nothing a person would recognise.
  const key = [...path].reverse().find((part): part is string => typeof part === "string");
  if (!key) return "This";
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One sentence for one issue, with no code names in it. */
export function validationMessage(issue: { path: ReadonlyArray<PropertyKey>; message: string }): string {
  const text = issue.message.trim();
  const sentence = /^[a-z]/.test(text) ? `${labelFor(issue.path)} ${text}` : text;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export interface FormattedValidationError {
  /** Up to three different problems, as sentences. */
  message: string;
  /** Per field, keyed by path ("shippingAddress.postalCode"), so a form can mark each one. */
  fields: Record<string, string>;
}

export function formatValidationError(error: ZodError): FormattedValidationError {
  const fields: Record<string, string> = {};
  const sentences: string[] = [];
  for (const issue of error.issues) {
    const sentence = validationMessage(issue);
    if (!sentences.includes(sentence)) sentences.push(sentence);
    const key = issue.path.map(String).join(".");
    if (key && !fields[key]) fields[key] = sentence;
  }
  return { message: sentences.slice(0, 3).join(" ") || "Please check what you entered.", fields };
}
