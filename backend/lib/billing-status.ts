/**
 * What a subscription's state means, in words (pure; shared by the owner's billing
 * page and the Super Admin view). This describes the state and never decides access:
 * that stays with `reduceSubscription` and `getEntitlements`.
 */
export type BillingStateKey = "active" | "ending" | "past_due" | "halted" | "paused" | "cancelled" | "completed" | "expired" | "none";
export type BillingStateTone = "success" | "warning" | "danger" | "neutral";

export interface BillingStateInput {
  status: string;
  providerStatus?: string | null;
  cancelAtPeriodEnd?: boolean;
  graceUntil?: Date | string | null;
  currentPeriodEnd?: Date | string | null;
  now?: Date;
}

export interface BillingStateView {
  key: BillingStateKey;
  label: string;
  tone: BillingStateTone;
  /** Whether a store keeps its paid features because of a grace period. */
  inGrace: boolean;
  summary: string;
  /** What the owner can do, in order. Empty when nothing is needed. */
  recovery: string[];
}

const dateText = (value: Date | string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" }) : null;

export function describeBillingState(input: BillingStateInput): BillingStateView {
  const now = input.now ?? new Date();
  const graceEnd = input.graceUntil ? new Date(input.graceUntil) : null;
  const inGrace = input.status === "past_due" && graceEnd !== null && graceEnd.getTime() > now.getTime();
  const graceText = inGrace
    ? `Your store keeps its paid features until ${dateText(graceEnd)}.`
    : "Paid features have stopped until a payment succeeds.";
  const periodEnd = dateText(input.currentPeriodEnd);
  const provider = input.providerStatus ?? null;

  if (provider === "completed") {
    return { key: "completed", label: "Completed", tone: "neutral", inGrace: false, summary: "This subscription reached the end of its billing cycles.", recovery: ["Choose a plan to subscribe again."] };
  }
  if (provider === "expired") {
    return { key: "expired", label: "Expired", tone: "neutral", inGrace: false, summary: "The payment page for this subscription expired before it was completed. Nothing was charged.", recovery: ["Choose a plan to start again."] };
  }
  if (input.status === "canceled" || provider === "cancelled") {
    return { key: "cancelled", label: "Cancelled", tone: "neutral", inGrace: false, summary: "This subscription has ended and cannot be restarted.", recovery: ["Choose a plan to subscribe again."] };
  }
  if (provider === "halted") {
    return {
      key: "halted",
      label: "Payment retries ended",
      tone: "danger",
      inGrace,
      summary: `Razorpay has stopped retrying the failed payment. Invoices keep being created, but nothing is charged automatically. ${graceText}`,
      recovery: [
        "Check the email Razorpay sent you about the failed payment. It explains how to pay or change your card.",
        "If you have an unpaid invoice below, open it at Razorpay. Razorpay decides whether it can still be paid.",
        "If you cannot complete a payment, cancel this subscription and choose a plan again.",
      ],
    };
  }
  if (provider === "paused") {
    return { key: "paused", label: "Paused", tone: "warning", inGrace, summary: `This subscription was paused at Razorpay, so nothing is being charged. ${graceText}`, recovery: ["Contact support to have it resumed."] };
  }
  if (input.status === "past_due") {
    return {
      key: "past_due",
      label: "Payment failed",
      tone: "warning",
      inGrace,
      summary: `Your last payment did not go through, and Razorpay is retrying it. ${graceText}`,
      recovery: [
        "Make sure your card or payment method can be charged. Razorpay retries by itself.",
        "Check the email Razorpay sent you, which explains how to pay or change your card.",
        "If you have an unpaid invoice below, you can open it at Razorpay. Razorpay decides whether it can still be paid.",
      ],
    };
  }
  if ((input.status === "active" || input.status === "trialing") && input.cancelAtPeriodEnd) {
    return { key: "ending", label: "Ending", tone: "warning", inGrace: false, summary: periodEnd ? `This subscription ends on ${periodEnd}. Nothing more will be charged.` : "This subscription ends when the current period ends.", recovery: [] };
  }
  if (input.status === "active" || input.status === "trialing") {
    return { key: "active", label: "Active", tone: "success", inGrace: false, summary: periodEnd ? `Paid until ${periodEnd}.` : "Your plan is active.", recovery: [] };
  }
  return { key: "none", label: "No subscription", tone: "neutral", inGrace: false, summary: "This store has no active subscription.", recovery: ["Choose a plan to get started."] };
}
