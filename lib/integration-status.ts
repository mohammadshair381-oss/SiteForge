/**
 * Whether each external integration has what it needs (server-only). Yes or no only:
 * never a value, key or address. "Configured" means the settings are present. It does
 * not mean the provider has been reached or that the integration works.
 */
export interface IntegrationStatus {
  key: string;
  label: string;
  configured: boolean;
  note: string;
}

const has = (...names: string[]) => names.every((name) => Boolean(process.env[name]?.trim()));
// Same rule as lib/scheduler-auth.ts: a secret this short is refused there.
const hasSchedulerSecret = (name: string) => (process.env[name]?.trim().length ?? 0) >= 32;

export function integrationStatuses(): IntegrationStatus[] {
  const billingKey = process.env.RAZORPAY_BILLING_KEY_ID?.trim() ?? "";
  return [
    {
      key: "razorpay_billing",
      label: "Razorpay subscriptions",
      configured: process.env.PAYMENT_PROVIDER === "razorpay" && has("RAZORPAY_BILLING_KEY_ID", "RAZORPAY_BILLING_KEY_SECRET", "RAZORPAY_BILLING_WEBHOOK_SECRET"),
      note: billingKey.startsWith("rzp_live_") ? (process.env.BILLING_LIVE_ALLOWED === "true" ? "Live keys, live billing allowed." : "Live keys are present and refused: live billing is not allowed.") : "Test keys only until live billing is approved.",
    },
    {
      key: "billing_reconcile",
      label: "Scheduled billing reconciliation",
      configured: hasSchedulerSecret("BILLING_RECONCILE_SECRET"),
      note: "Its secret is present. A scheduler still has to call the endpoint, and none is set up by SiteForge (docs/scheduled-jobs.md).",
    },
    {
      key: "domain_health",
      label: "Scheduled custom domain checks",
      configured: hasSchedulerSecret("DOMAIN_HEALTH_SECRET"),
      note: "Its secret is present. A scheduler still has to call the endpoint, and none is set up by SiteForge (docs/scheduled-jobs.md).",
    },
    {
      key: "cart_cleanup",
      label: "Scheduled expired cart cleanup",
      configured: hasSchedulerSecret("CART_CLEANUP_SECRET"),
      note: "Its secret is present. A scheduler still has to call the endpoint, and none is set up by SiteForge (docs/scheduled-jobs.md).",
    },
    {
      key: "media_cleanup",
      label: "Scheduled media storage cleanup",
      configured: hasSchedulerSecret("MEDIA_CLEANUP_SECRET"),
      note: "Its secret is present. Stores also tidy up their own uploads when their library opens. A scheduler still has to call the endpoint, and none is set up by SiteForge (docs/scheduled-jobs.md).",
    },
    {
      key: "conversation_cleanup",
      label: "Scheduled AI conversation cleanup",
      configured: hasSchedulerSecret("CONVERSATION_CLEANUP_SECRET"),
      note: "Its secret is present. Without it, run-out conversations are still deleted when they are found. A scheduler still has to call the endpoint, and none is set up by SiteForge (docs/scheduled-jobs.md).",
    },
    {
      key: "email",
      label: "Resend email",
      configured: process.env.EMAIL_PROVIDER === "resend" && has("EMAIL_API_KEY", "EMAIL_FROM", "APP_URL"),
      note: "Without it, production emails are refused rather than faked.",
    },
    {
      key: "storage",
      label: "S3 storage",
      configured: has("S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PUBLIC_URL"),
      note: "Without it, media uploads are refused in production.",
    },
    {
      key: "domain_routing",
      label: "Custom domain routing",
      configured: has("CUSTOM_DOMAIN_CNAME_TARGET") || has("CUSTOM_DOMAIN_A_RECORDS"),
      note: "Names the address domains must point at. Ingress itself is set up outside SiteForge.",
    },
    {
      key: "domain_tls",
      label: "Custom domain certificates",
      configured: has("CUSTOM_DOMAIN_CERT_PROVIDER"),
      note: "Without an integration, no new custom domain can become active. tls_probe only inspects certificates: it does not issue or renew them.",
    },
  ];
}
