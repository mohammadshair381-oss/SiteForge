/**
 * Reusable, branded email templates for SiteForge.
 *
 * Pure module: it never reads configuration, never sends anything and has no
 * dependencies, so it is safe to import from anywhere and easy to unit-test.
 *
 * Design notes:
 * - Table-based layout with inline styles only (email-client safe), a single
 *   column, max-width 600px and a system font stack. No external assets, no
 *   tracking pixels, no web fonts and no images.
 * - Brand colour matches the app (`brand-600` / `brand-700` in
 *   `tailwind.config.ts`); body text uses accessible slate tones.
 * - Every user-controlled value is HTML-escaped before interpolation.
 * - Wording is imperative ("reset your password" / "confirm your address") and
 *   never claims an action already succeeded, since the token has not been
 *   verified when the email is sent.
 * - No company address, legal claims, support address or domain are invented.
 *
 * `lib/email.ts` deliberately logs neither the body nor the links, so tokens
 * never appear in logs.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const BRAND_NAME = "SiteForge";
const BRAND_COLOR = "#4f46e5";
const BRAND_COLOR_DARK = "#4338ca";
const HEADING_COLOR = "#0f172a";
const BODY_COLOR = "#334155";
const MUTED_COLOR = "#64748b";
const BORDER_COLOR = "#e2e8f0";
const PAGE_BG = "#f1f5f9";
const CARD_BG = "#ffffff";
const FOOTER_BG = "#f8fafc";
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Escapes text for safe interpolation into HTML (text and attributes). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapses whitespace so a display name cannot break the plain-text layout. */
function normalizeName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim();
}

interface LayoutOptions {
  previewText: string;
  heading: string;
  paragraphsHtml: string[];
  /** Absent for emails with nothing to click, such as order updates. */
  ctaLabel?: string;
  ctaUrl?: string;
  afterCtaHtml: string[];
  /** Pre-built, already-escaped HTML placed after the paragraphs. */
  bodyHtml?: string;
  brandName?: string;
}

function renderLayout(options: LayoutOptions): string {
  const safeUrl = options.ctaUrl ? escapeHtml(options.ctaUrl) : "";
  const brand = options.brandName ? escapeHtml(options.brandName) : BRAND_NAME;
  const year = new Date().getFullYear();

  const paragraphs = options.paragraphsHtml
    .map(
      (html) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BODY_COLOR};">${html}</p>`,
    )
    .join("");

  const afterCta = options.afterCtaHtml
    .map(
      (html) =>
        `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:${MUTED_COLOR};">${html}</p>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(options.previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:24px 12px;">
<tr>
<td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${CARD_BG};border-radius:12px;overflow:hidden;border:1px solid ${BORDER_COLOR};font-family:${FONT_STACK};">
<tr>
<td style="padding:22px 32px;border-bottom:1px solid ${BORDER_COLOR};">
<span style="font-size:18px;font-weight:800;letter-spacing:-0.01em;color:${BRAND_COLOR};">${brand}</span>
</td>
</tr>
<tr>
<td style="padding:32px;">
<h1 style="margin:0 0 18px;font-size:20px;line-height:1.3;color:${HEADING_COLOR};">${escapeHtml(options.heading)}</h1>
${paragraphs}
${options.bodyHtml ?? ""}
${!safeUrl ? "" : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
<tr>
<td style="border-radius:8px;background:${BRAND_COLOR};">
<a href="${safeUrl}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(options.ctaLabel ?? "")}</a>
</td>
</tr>
</table>
<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${MUTED_COLOR};">If the button does not work, copy and paste this link into your browser:</p>
<p style="margin:0 0 20px;font-size:13px;line-height:1.6;word-break:break-all;"><a href="${safeUrl}" style="color:${BRAND_COLOR_DARK};text-decoration:underline;">${safeUrl}</a></p>`}
${afterCta}
</td>
</tr>
<tr>
<td style="padding:20px 32px;background:${FOOTER_BG};border-top:1px solid ${BORDER_COLOR};">
<p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED_COLOR};">&copy; ${year} ${BRAND_NAME}</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

export interface PasswordResetEmailInput {
  /** Recipient display name, if known. User-controlled: escaped for HTML. */
  name?: string | null;
  resetUrl: string;
  expiresInMinutes: number;
}

export function renderPasswordResetEmail(
  input: PasswordResetEmailInput,
): RenderedEmail {
  const name = normalizeName(input.name);
  const greetingHtml = name ? `Hi ${escapeHtml(name)},` : "Hi,";
  const greetingText = name ? `Hi ${name},` : "Hi,";
  const minutes = Math.max(1, Math.trunc(input.expiresInMinutes));

  const subject = "Reset your SiteForge password";

  const text = [
    greetingText,
    "",
    "We received a request to reset the password for your SiteForge account. Open the link below to choose a new password:",
    "",
    input.resetUrl,
    "",
    `This link expires in ${minutes} minute${minutes === 1 ? "" : "s"} and can be used once. If you did not request a password reset, you can safely ignore this email and your password will not change.`,
    "",
    `— ${BRAND_NAME}`,
  ].join("\n");

  const html = renderLayout({
    previewText: "Choose a new password for your SiteForge account.",
    heading: "Reset your password",
    paragraphsHtml: [
      greetingHtml,
      "We received a request to reset the password for your SiteForge account. Choose a new password using the button below.",
    ],
    ctaLabel: "Reset password",
    ctaUrl: input.resetUrl,
    afterCtaHtml: [
      `This link expires in ${minutes} minute${minutes === 1 ? "" : "s"} and can be used once.`,
      "If you did not request a password reset, you can safely ignore this email and your password will not change.",
    ],
  });

  return { subject, text, html };
}

export interface EmailVerificationEmailInput {
  /** Recipient display name, if known. User-controlled: escaped for HTML. */
  name?: string | null;
  verifyUrl: string;
  expiresInHours: number;
}

export function renderEmailVerificationEmail(
  input: EmailVerificationEmailInput,
): RenderedEmail {
  const name = normalizeName(input.name);
  const greetingHtml = name ? `Hi ${escapeHtml(name)},` : "Hi,";
  const greetingText = name ? `Hi ${name},` : "Hi,";
  const hours = Math.max(1, Math.trunc(input.expiresInHours));

  const subject = "Confirm your SiteForge email address";

  const text = [
    greetingText,
    "",
    "Confirm this email address to finish setting up your SiteForge account. Open the link below to verify it:",
    "",
    input.verifyUrl,
    "",
    `This link expires in ${hours} hour${hours === 1 ? "" : "s"} and can be used once. If you did not create a SiteForge account, you can safely ignore this email.`,
    "",
    `— ${BRAND_NAME}`,
  ].join("\n");

  const html = renderLayout({
    previewText: "Confirm your email address to finish setting up SiteForge.",
    heading: "Confirm your email address",
    paragraphsHtml: [
      greetingHtml,
      "Confirm this email address to finish setting up your SiteForge account. Use the button below to verify it.",
    ],
    ctaLabel: "Verify email address",
    ctaUrl: input.verifyUrl,
    afterCtaHtml: [
      `This link expires in ${hours} hour${hours === 1 ? "" : "s"} and can be used once.`,
      "If you did not create a SiteForge account, you can safely ignore this email.",
    ],
  });

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Storefront customer accounts (business-scoped). The store name is
// owner-controlled: whitespace is collapsed and it is escaped for HTML.
// ---------------------------------------------------------------------------

export interface CustomerVerificationEmailInput {
  storeName: string;
  name?: string | null;
  verifyUrl: string;
  expiresInHours: number;
}

/** Sent instead of creating an account when the address already has one. */
export function renderPlatformAccountExistsEmail(input: { name?: string | null; loginUrl: string; resetUrl: string }): RenderedEmail {
  const name = normalizeName(input.name);
  const subject = "Someone tried to create a SiteForge account with your email";
  const lead = "Someone, possibly you, tried to create a SiteForge account with this email address. It already has an account, so nothing was changed.";
  const text = [
    name ? `Hi ${name},` : "Hi,",
    "",
    lead,
    "",
    `Log in: ${input.loginUrl}`,
    `Forgot your password? ${input.resetUrl}`,
    "",
    "If this was not you, you can ignore this email.",
    "",
    `— ${BRAND_NAME}`,
  ].join("\n");
  const html = renderLayout({
    previewText: "This email address already has a SiteForge account.",
    heading: "You already have an account",
    paragraphsHtml: [name ? `Hi ${escapeHtml(name)},` : "Hi,", escapeHtml(lead)],
    ctaLabel: "Log in",
    ctaUrl: input.loginUrl,
    afterCtaHtml: [`Forgot your password? <a href="${escapeHtml(input.resetUrl)}">Choose a new one</a>. If this was not you, you can ignore this email.`],
  });
  return { subject, text, html };
}

/** An invitation to a store's team. Text from the store is escaped. */
export function renderTeamInvitationEmail(input: { businessName: string; inviterName: string; roleLabel: string; acceptUrl: string; expiresInDays: number }): RenderedEmail {
  const subject = `Join ${input.businessName} on SiteForge`;
  const lead = `${input.inviterName} invited you to join ${input.businessName} on SiteForge as ${input.roleLabel}.`;
  const after = `The invitation expires in ${input.expiresInDays} days and can be used once. You will need to log in, or create an account, with this email address. If you were not expecting it, you can ignore this email.`;
  const text = [lead, "", input.acceptUrl, "", after, "", `— ${BRAND_NAME}`].join("\n");
  const html = renderLayout({
    previewText: `You have been invited to ${input.businessName}.`,
    heading: "You have been invited",
    paragraphsHtml: [escapeHtml(lead)],
    ctaLabel: "View the invitation",
    ctaUrl: input.acceptUrl,
    afterCtaHtml: [escapeHtml(after)],
  });
  return { subject, text, html };
}

export function renderCustomerVerificationEmail(
  input: CustomerVerificationEmailInput,
): RenderedEmail {
  const store = normalizeName(input.storeName) || "the store";
  const name = normalizeName(input.name);
  const hours = Math.max(1, Math.trunc(input.expiresInHours));
  const subject = `Confirm your email for ${store}`;
  const text = [
    name ? `Hi ${name},` : "Hi,",
    "",
    `Confirm this email address to finish creating your account at ${store}. Open the link below:`,
    "",
    input.verifyUrl,
    "",
    `This link expires in ${hours} hour${hours === 1 ? "" : "s"} and can be used once. If you did not create an account at ${store}, you can ignore this email.`,
  ].join("\n");
  const html = renderLayout({
    previewText: `Confirm your email to finish creating your account at ${store}.`,
    heading: "Confirm your email address",
    paragraphsHtml: [
      name ? `Hi ${escapeHtml(name)},` : "Hi,",
      `Confirm this email address to finish creating your account at ${escapeHtml(store)}.`,
    ],
    ctaLabel: "Verify email address",
    ctaUrl: input.verifyUrl,
    afterCtaHtml: [
      `This link expires in ${hours} hour${hours === 1 ? "" : "s"} and can be used once.`,
      `If you did not create an account at ${escapeHtml(store)}, you can ignore this email.`,
    ],
  });
  return { subject, text, html };
}

export interface CustomerPasswordResetEmailInput {
  storeName: string;
  name?: string | null;
  resetUrl: string;
  expiresInMinutes: number;
}

export function renderCustomerPasswordResetEmail(
  input: CustomerPasswordResetEmailInput,
): RenderedEmail {
  const store = normalizeName(input.storeName) || "the store";
  const name = normalizeName(input.name);
  const minutes = Math.max(1, Math.trunc(input.expiresInMinutes));
  const subject = `Reset your password for ${store}`;
  const text = [
    name ? `Hi ${name},` : "Hi,",
    "",
    `We received a request to reset the password for your account at ${store}. Open the link below to choose a new password:`,
    "",
    input.resetUrl,
    "",
    `This link expires in ${minutes} minute${minutes === 1 ? "" : "s"} and can be used once. If you did not ask for this, ignore this email and your password will not change.`,
  ].join("\n");
  const html = renderLayout({
    previewText: `Choose a new password for your account at ${store}.`,
    heading: "Reset your password",
    paragraphsHtml: [
      name ? `Hi ${escapeHtml(name)},` : "Hi,",
      `We received a request to reset the password for your account at ${escapeHtml(store)}.`,
    ],
    ctaLabel: "Reset password",
    ctaUrl: input.resetUrl,
    afterCtaHtml: [
      `This link expires in ${minutes} minute${minutes === 1 ? "" : "s"} and can be used once.`,
      "If you did not ask for this, ignore this email and your password will not change.",
    ],
  });
  return { subject, text, html };
}

const PENDING_VERIFICATION_TEXT =
  "Your email address is not confirmed yet. Sign in with your password to request a new confirmation link, or reset your password if you do not know it.";

export interface CustomerAccountExistsEmailInput {
  storeName: string;
  name?: string | null;
  loginUrl: string;
  forgotPasswordUrl: string;
  /** The existing account has not confirmed its email yet. */
  pendingVerification?: boolean;
}

/**
 * Sent when someone tries to register with an email that already has a
 * verified account, so the public registration response stays identical
 * without leaving the real owner uninformed.
 */
export function renderCustomerAccountExistsEmail(
  input: CustomerAccountExistsEmailInput,
): RenderedEmail {
  const store = normalizeName(input.storeName) || "the store";
  const name = normalizeName(input.name);
  const subject = `You already have an account at ${store}`;
  const text = [
    name ? `Hi ${name},` : "Hi,",
    "",
    `Someone tried to create an account at ${store} with this email address, but you already have one.`,
    ...(input.pendingVerification ? ["", PENDING_VERIFICATION_TEXT] : []),
    "",
    `Sign in: ${input.loginUrl}`,
    `Forgot your password? ${input.forgotPasswordUrl}`,
    "",
    "If this was not you, you can ignore this email. Nothing about your account was changed.",
  ].join("\n");
  const html = renderLayout({
    previewText: `You already have an account at ${store}.`,
    heading: "You already have an account",
    paragraphsHtml: [
      name ? `Hi ${escapeHtml(name)},` : "Hi,",
      `Someone tried to create an account at ${escapeHtml(store)} with this email address, but you already have one.`,
      ...(input.pendingVerification ? [escapeHtml(PENDING_VERIFICATION_TEXT)] : []),
    ],
    ctaLabel: "Sign in",
    ctaUrl: input.loginUrl,
    afterCtaHtml: [
      `Forgot your password? <a href="${escapeHtml(input.forgotPasswordUrl)}">Reset it here</a>.`,
      "If this was not you, you can ignore this email. Nothing about your account was changed.",
    ],
  });
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Order emails. Sent on behalf of a store, so the store's name is the heading.
// ---------------------------------------------------------------------------

export type OrderEmailKind = "placed" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded" | "owner_new_order";

export interface OrderEmailDetails {
  storeName: string;
  orderNumber: string;
  customerName: string;
  currency: string;
  items: Array<{ name: string; variant: string; quantity: number; lineTotal: number }>;
  subtotal: number;
  discount: number;
  shipping: number | null;
  tax: number;
  taxLabel: string;
  taxInclusive: boolean;
  total: number;
  paymentMethod: "online" | "cod" | null;
  trackingCarrier: string;
  trackingNumber: string;
  /** Owner-entered; only an https address is ever turned into a link. */
  trackingUrl: string;
  refundedTotal: number;
}

const money = (value: number, currency: string) => `${currency} ${value.toFixed(2)}`;

function orderEmailCopy(kind: OrderEmailKind, order: OrderEmailDetails): { subject: string; heading: string; intro: string[] } {
  const number = `#${order.orderNumber}`;
  switch (kind) {
    case "placed":
      return {
        subject: `Order ${number} received by ${order.storeName}`,
        heading: "We received your order",
        intro: [order.paymentMethod === "cod" ? "You pay in cash when it is delivered. We will let you know when it ships." : `${order.storeName} will be in touch about payment and delivery.`],
      };
    case "paid":
      return { subject: `Payment received for order ${number}`, heading: "Payment received", intro: ["Thank you. We will let you know when your order ships."] };
    case "shipped":
      return { subject: `Order ${number} has shipped`, heading: "Your order is on its way", intro: [] };
    case "delivered":
      return { subject: `Order ${number} was delivered`, heading: "Your order was delivered", intro: [`Thank you for shopping with ${order.storeName}.`] };
    case "cancelled":
      return { subject: `Order ${number} was cancelled`, heading: "Your order was cancelled", intro: ["You have not been charged for this order. If you think this is a mistake, please contact the store."] };
    case "refunded":
      return { subject: `Refund for order ${number}`, heading: "Your refund", intro: [`${order.storeName} has refunded ${money(order.refundedTotal || order.total, order.currency)} for this order. It can take a few days to reach you.`] };
    case "owner_new_order":
      return { subject: `New order ${number} on ${order.storeName}`, heading: "You have a new order", intro: [`${order.customerName} placed an order. Open Orders in your dashboard to see the details and delivery address.`] };
  }
}

/** Order update emails. Every store and shopper value is escaped. */
export function renderOrderEmail(kind: OrderEmailKind, order: OrderEmailDetails): RenderedEmail {
  const copy = orderEmailCopy(kind, order);
  const name = normalizeName(order.customerName);
  const greeting = kind === "owner_new_order" || !name ? [] : [`Hi ${name},`];
  const hasTracking = kind === "shipped" && Boolean(order.trackingNumber || order.trackingUrl);
  const safeTracking = /^https:\/\//i.test(order.trackingUrl) ? order.trackingUrl : "";
  const trackingLine = hasTracking ? `Tracking: ${[order.trackingCarrier, order.trackingNumber].filter(Boolean).join(" ")}` : "";

  const totals: Array<[string, string]> = [
    ["Subtotal", money(order.subtotal, order.currency)],
    ...(order.discount > 0 ? [["Discount", `-${money(order.discount, order.currency)}`] as [string, string]] : []),
    ...(order.shipping !== null ? [["Shipping", order.shipping === 0 ? "Free" : money(order.shipping, order.currency)] as [string, string]] : []),
    ...(order.tax > 0 ? [[order.taxInclusive ? `Includes ${order.taxLabel}` : order.taxLabel, money(order.tax, order.currency)] as [string, string]] : []),
    ["Total", money(order.total, order.currency)],
  ];
  const itemLines = order.items.map((item) => `${item.quantity} x ${item.name}${item.variant ? ` (${item.variant})` : ""}: ${money(item.lineTotal, order.currency)}`);

  const text = [
    ...greeting,
    ...(greeting.length ? [""] : []),
    copy.heading,
    ...copy.intro,
    ...(trackingLine ? [trackingLine] : []),
    ...(safeTracking ? [safeTracking] : []),
    "",
    `Order #${order.orderNumber}`,
    ...itemLines,
    "",
    ...totals.map(([label, value]) => `${label}: ${value}`),
    "",
    `— ${order.storeName}`,
  ].join("\n");

  const cell = `padding:6px 0;font-size:14px;color:${BODY_COLOR};border-top:1px solid ${BORDER_COLOR};`;
  const bodyHtml = `<p style="margin:0 0 8px;font-size:14px;font-weight:600;color:${HEADING_COLOR};">Order #${escapeHtml(order.orderNumber)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${order.items
    .map((item) => `<tr><td style="${cell}">${item.quantity} &times; ${escapeHtml(item.name)}${item.variant ? ` (${escapeHtml(item.variant)})` : ""}</td><td align="right" style="${cell}white-space:nowrap;">${escapeHtml(money(item.lineTotal, order.currency))}</td></tr>`)
    .join("")}${totals
    .map(([label, value], index) => `<tr><td style="${cell}${index === totals.length - 1 ? "font-weight:700;" : ""}">${escapeHtml(label)}</td><td align="right" style="${cell}white-space:nowrap;${index === totals.length - 1 ? "font-weight:700;" : ""}">${escapeHtml(value)}</td></tr>`)
    .join("")}</table>`;

  const html = renderLayout({
    previewText: copy.heading,
    heading: copy.heading,
    brandName: order.storeName,
    paragraphsHtml: [...greeting.map(escapeHtml), ...copy.intro.map(escapeHtml), ...(trackingLine ? [escapeHtml(trackingLine)] : [])],
    bodyHtml,
    ...(safeTracking ? { ctaLabel: "Track your order", ctaUrl: safeTracking } : {}),
    afterCtaHtml: [],
  });
  return { subject: copy.subject, text, html };
}
