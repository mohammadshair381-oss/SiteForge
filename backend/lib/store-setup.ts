/**
 * Guided store setup (pure; no I/O): the wizard's steps, which of them are
 * done, and what still stands between the store and publishing.
 *
 * Completion comes from the store's REAL data wherever it can (a description
 * exists, products are active, the store is published). The stored progress
 * (`Business.setup`) only remembers the owner's own choices: the step they
 * were on, the steps they confirmed and the steps they chose to skip.
 * Publishing requirements mirror the publish route exactly (verified email,
 * active plan, not suspended); everything else is a recommendation.
 */

export const SETUP_STEPS = ["business", "brand", "structure", "products", "settings", "launch"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const SETUP_STEP_INFO: Record<SetupStep, { title: string; description: string; skippable: boolean }> = {
  business: { title: "Business details", description: "Your name, type of business, description and how customers reach you.", skippable: false },
  brand: { title: "Look and logo", description: "How your store looks: its design, colours, lettering and your logo.", skippable: false },
  structure: { title: "Homepage and pages", description: "A starting homepage layout for your type of business, and pages such as About and Contact.", skippable: false },
  products: { title: "Products", description: "Add what you sell. You can also do this later.", skippable: true },
  settings: { title: "Delivery and payments", description: "How you deliver, how customers pay, and your shop rules (returns and so on).", skippable: true },
  launch: { title: "Check and go live", description: "See your store on a phone, a tablet and a computer, then put it online.", skippable: false },
};

export interface SetupProgress {
  /** The step the owner was last on (resume point). */
  step: SetupStep | null;
  /** Steps the owner confirmed ("Save and continue"). */
  done: SetupStep[];
  /** Steps the owner chose to do later. */
  skipped: SetupStep[];
  /** When the owner finished the wizard (published or chose "Finish"). */
  completedAt: Date | null;
}

const isStep = (value: unknown): value is SetupStep => typeof value === "string" && (SETUP_STEPS as readonly string[]).includes(value);

/** Tolerant read of `Business.setup` (absent for businesses created before the wizard). */
export function readSetupProgress(value: unknown): SetupProgress {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const list = (items: unknown) => (Array.isArray(items) ? [...new Set(items.filter(isStep))] : []);
  const completedAt = v.completedAt instanceof Date ? v.completedAt : typeof v.completedAt === "string" && !Number.isNaN(Date.parse(v.completedAt)) ? new Date(v.completedAt) : null;
  return { step: isStep(v.step) ? v.step : null, done: list(v.done), skipped: list(v.skipped), completedAt };
}

/** Everything the wizard and the readiness check need to know about a store. */
export interface SetupFacts {
  name: string;
  description: string;
  contactEmail: string;
  phone: string;
  /** Optional, so older callers still work: unset counts as not added. */
  address?: string;
  serviceArea?: string;
  /** Pages besides the homepage. */
  otherPages?: number;
  logoUrl: string;
  activeProducts: number;
  activeProductsWithoutImage: number;
  /** Starter samples still to replace (lib/sample-products.ts). Optional: unset counts as none. */
  sampleProducts?: number;
  shippingConfigured: boolean;
  policies: { shipping: boolean; returns: boolean };
  codEnabled: boolean;
  guestCodEnabled?: boolean;
  accountsEnabled: boolean;
  onlinePaymentsConnected: boolean;
  emailVerified: boolean;
  planActive: boolean;
  suspended: boolean;
  published: boolean;
}

export interface ReadinessItem {
  key: string;
  label: string;
  detail: string;
  done: boolean;
  /** Required to publish (the publish route refuses otherwise). */
  required: boolean;
  step: SetupStep;
}

export interface Readiness {
  items: ReadinessItem[];
  canPublish: boolean;
  remainingRequired: number;
  remainingRecommended: number;
}

export function storeReadiness(f: SetupFacts): Readiness {
  const payments = (f.codEnabled && (f.accountsEnabled || f.guestCodEnabled === true)) || f.onlinePaymentsConnected;
  const items: ReadinessItem[] = [
    { key: "email", label: "Verify your email address", detail: "Publishing needs a verified email. Use the link we sent you, or resend it from your dashboard.", done: f.emailVerified, required: true, step: "launch" },
    { key: "plan", label: "An active plan", detail: "Publishing needs an active subscription. The store owner can manage it under Billing.", done: f.planActive, required: true, step: "launch" },
    ...(f.suspended ? [{ key: "suspended", label: "Store suspended", detail: "A platform administrator has suspended this store. Contact support.", done: false, required: true, step: "launch" as const }] : []),
    { key: "description", label: "Describe your business", detail: "A sentence or two shown on your homepage and in search results.", done: Boolean(f.description.trim()), required: false, step: "business" },
    { key: "contact", label: "Add a way to contact you", detail: "An email address or phone number for customers.", done: Boolean(f.contactEmail.trim() || f.phone.trim()), required: false, step: "business" },
    { key: "location", label: "Say where you are or who you serve", detail: "A shop address or a service area, shown in your store footer.", done: Boolean(f.address?.trim() || f.serviceArea?.trim()), required: false, step: "business" },
    { key: "logo", label: "Upload a logo", detail: "Shown in your store header. Your store name is shown until you add one.", done: Boolean(f.logoUrl), required: false, step: "brand" },
    { key: "pages", label: "Prepare your other pages", detail: "About, Contact and policy pages help customers trust your store. They stay drafts until you publish them.", done: (f.otherPages ?? 0) > 0, required: false, step: "structure" },
    ...((f.sampleProducts ?? 0) > 0
      ? [{ key: "samples", label: "Replace the sample products", detail: `${f.sampleProducts} sample product${f.sampleProducts === 1 ? " is" : "s are"} waiting. Shoppers never see them: open each one and put in your own name, price and photo, or remove them.`, done: false, required: false, step: "products" as const }]
      : []),
    { key: "products", label: "Add your first product", detail: "Customers need something to buy. Sections without products stay hidden.", done: f.activeProducts > 0, required: false, step: "products" },
    {
      key: "images",
      label: "Add product photos",
      detail: f.activeProductsWithoutImage > 0 ? `${f.activeProductsWithoutImage} active product${f.activeProductsWithoutImage === 1 ? " has" : "s have"} no photo yet.` : "Every active product has a photo.",
      done: f.activeProducts > 0 && f.activeProductsWithoutImage === 0,
      required: false,
      step: "products",
    },
    { key: "delivery", label: "Set up delivery", detail: "Delivery charges and whether checkout asks for an address.", done: f.shippingConfigured, required: false, step: "settings" },
    { key: "policies", label: "Add shipping and returns policies", detail: "Shown on your policies page so customers know what to expect.", done: f.policies.shipping && f.policies.returns, required: false, step: "settings" },
    {
      key: "payments",
      label: "Choose how customers pay",
      detail: payments ? "Customers can pay at checkout." : "No payment method is available yet: orders arrive unpaid and you arrange payment with each customer.",
      done: payments,
      required: false,
      step: "settings",
    },
  ];
  const remainingRequired = items.filter((i) => i.required && !i.done).length;
  return { items, canPublish: remainingRequired === 0, remainingRequired, remainingRecommended: items.filter((i) => !i.required && !i.done).length };
}

/** Whether a step is complete: real data where possible, the owner's confirmation otherwise. */
export function stepComplete(step: SetupStep, f: SetupFacts, progress: SetupProgress): boolean {
  switch (step) {
    case "business":
      return Boolean(f.name.trim() && f.description.trim() && (f.contactEmail.trim() || f.phone.trim()));
    case "products":
      return f.activeProducts > 0;
    case "launch":
      return f.published;
    default:
      return progress.done.includes(step);
  }
}

export type StepState = "complete" | "skipped" | "todo";

export function stepStates(f: SetupFacts, progress: SetupProgress): Record<SetupStep, StepState> {
  return Object.fromEntries(
    SETUP_STEPS.map((s) => [s, stepComplete(s, f, progress) ? "complete" : progress.skipped.includes(s) ? "skipped" : "todo"]),
  ) as Record<SetupStep, StepState>;
}

/** Where to resume: the saved step, else the first step neither complete nor skipped, else launch. */
export function resumeStep(f: SetupFacts, progress: SetupProgress): SetupStep {
  if (progress.step) return progress.step;
  const states = stepStates(f, progress);
  return SETUP_STEPS.find((s) => states[s] === "todo") ?? "launch";
}

export function nextStep(step: SetupStep): SetupStep | null {
  const i = SETUP_STEPS.indexOf(step);
  return i >= 0 && i < SETUP_STEPS.length - 1 ? SETUP_STEPS[i + 1] : null;
}

export function previousStep(step: SetupStep): SetupStep | null {
  const i = SETUP_STEPS.indexOf(step);
  return i > 0 ? SETUP_STEPS[i - 1] : null;
}
