import crypto from "node:crypto";
import mongoose from "mongoose";
import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError } from "@/lib/api";
import { assertObjectId } from "@/lib/ids";
import { env } from "@/lib/env";
import { Payment, type PaymentDomain } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";
import { Plan, type PlanDoc } from "@/models/Plan";

export const runtime = "nodejs";

function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({
    businessId: z.string().min(1),
    planKey: z.string().optional(),
    amount: z.coerce.number().min(0).optional(),
    currency: z.string().length(3).optional(),
    providerPaymentId: z.string().optional(),
  }),
});

/**
 * True when an error is a MongoDB duplicate-key violation (E11000). The unique
 * partial index on `Payment.providerEventId` is the authoritative idempotency
 * guard, so this is the expected result when two deliveries of the same event
 * race: the losing delivery aborts and re-applies nothing.
 */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * True when an error reflects a retryable transaction conflict that
 * `withTransaction` already retried until its budget was exhausted. Mirrors the
 * convention in app/api/businesses/[id]/members/[memberId]/route.ts.
 */
function isTransactionalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) {
    return true;
  }
  return (error as { code?: unknown }).code === 112; // WriteConflict
}

/**
 * Provider-contract notes (Phase 4.7)
 * -----------------------------------
 * A `payment.succeeded` event is applied only when its `amount` and `currency`
 * match the plan it pays for. The intended plan is the event's `planKey` when
 * present, otherwise the plan already attached to the business's subscription.
 *
 * `amount` is compared to `Plan.price` with strict equality and NO currency
 * conversion. In this platform `Plan.price` and `Payment.amount` are stored in
 * the same unit (the manual billing route copies one straight into the other and
 * the UI formats both the same way), so identity is the only reconciliation that
 * cannot invent a conversion rule. Whether an external provider quotes major or
 * minor units is NOT documented anywhere in this repository; a provider that
 * uses a different unit would fail this check and its conversion must be
 * configured explicitly rather than guessed here. `currency` is compared
 * case-insensitively.
 *
 * Amount and currency are therefore required on a succeeded event. A rejected
 * event writes nothing and grants no entitlement.
 */
function assertPaymentMatchesPlan(
  plan: PlanDoc,
  amount: number | undefined,
  currency: string | undefined,
): void {
  if (amount === undefined) {
    throw new HttpError(422, "The payment event is missing an amount", "amount_required");
  }
  if (currency === undefined) {
    throw new HttpError(422, "The payment event is missing a currency", "currency_required");
  }
  if (amount !== plan.price) {
    throw new HttpError(
      409,
      `The payment amount does not match the "${plan.key}" plan price`,
      "amount_mismatch",
    );
  }
  if (currency.toUpperCase() !== plan.currency.toUpperCase()) {
    throw new HttpError(
      409,
      `The payment currency does not match the "${plan.key}" plan currency`,
      "currency_mismatch",
    );
  }
}

/**
 * This generic webhook has no provider API to re-read, so it can only believe its payload. It therefore
 * never runs alongside Razorpay billing, whose rule is that access changes only from a webhook followed
 * by an API re-read (lib/billing-razorpay.ts). In production it also has to be asked for by name.
 */
function legacyWebhookAvailable(config: ReturnType<typeof env>): boolean {
  if (!config.PAYMENT_WEBHOOK_SECRET || config.PAYMENT_PROVIDER === "razorpay") return false;
  return config.NODE_ENV !== "production" || config.LEGACY_PAYMENT_WEBHOOK_ENABLED;
}

/** Billed through Razorpay, or about to be. Left to that integration, whatever this payload says. */
function managedByBillingProvider(subscription: { provider?: string | null; providerSubscriptionId?: string | null; pendingCheckout?: { providerSubscriptionId?: string | null } | null } | null): boolean {
  return Boolean(subscription && (subscription.provider === "razorpay" || subscription.providerSubscriptionId || subscription.pendingCheckout?.providerSubscriptionId));
}

export async function POST(request: Request) {
  return handle(async () => {
    const config = env();
    const secret = config.PAYMENT_WEBHOOK_SECRET;
    // `legacyWebhookAvailable` already refuses a missing secret; checking it here as well lets
    // TypeScript see that `secret` is a string below.
    if (!secret || !legacyWebhookAvailable(config)) {
      throw new HttpError(400, "Payment webhooks are not configured", "not_configured");
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-signature");
    if (!verifySignature(rawBody, signature, secret)) {
      throw new HttpError(401, "Invalid webhook signature", "invalid_signature");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new HttpError(400, "Invalid JSON payload", "bad_request");
    }
    const event = eventSchema.parse(json);

    const businessId = assertObjectId(event.data.businessId, "business id");

    // Only the two billing events have a defined effect. Any other signed event
    // (e.g. `invoice.created`) is acknowledged without a write; recording it as
    // a "failed" payment used to show false failures in the owner's history.
    if (event.type !== "payment.succeeded" && event.type !== "payment.failed") {
      return ok({ received: true, ignored: true });
    }

    await dbConnect();

    // Idempotency fast path: an already-recorded event is acknowledged without
    // opening a transaction.
    const alreadyProcessed = await Payment.exists({ providerEventId: event.id });
    if (alreadyProcessed) {
      return ok({ received: true, duplicate: true });
    }

    const session = await mongoose.connection.startSession();
    try {
      let duplicate = false;
      let providerManaged = false;
      try {
        await session.withTransaction(async () => {
          providerManaged = false;
          // Resolve the target subscription up front (read only) so the Payment
          // row can carry its link. No mutation happens yet.
          const subscription = await Subscription.findOne({ business: businessId })
        .sort({ createdAt: -1 })
        .session(session);

          // Read inside the transaction, so a Razorpay activation at the same moment
          // conflicts with any write below and this is decided again.
          if (managedByBillingProvider(subscription)) {
            providerManaged = true;
            return;
          }

          if (event.type === "payment.succeeded") {
            // H2: a successful payment must attach to an existing subscription.
            // We never fabricate one with arbitrary defaults; reject explicitly
            // so nothing is recorded or granted.
            if (!subscription) {
              throw new HttpError(
                409,
                "No subscription exists for this business, so a successful payment cannot be applied",
                "subscription_missing",
              );
            }

            // The intended plan: an explicit (active) planKey, else the active
            // plan already attached to the subscription. `subscription.plan` is
            // guarded so an unset ref can never match an arbitrary active plan.
            const intendedPlan = event.data.planKey
              ? await Plan.findOne({ key: event.data.planKey, active: true }).session(session)
              : subscription.plan
                ? await Plan.findOne({ _id: subscription.plan, active: true }).session(session)
                : null;

            if (!intendedPlan) {
              throw new HttpError(
                422,
                "The payment does not reference a known, active plan",
                "invalid_plan",
              );
            }

            // H3: verify the payment against that plan before writing anything.
            // An unverified payment must never grant a paid entitlement.
            assertPaymentMatchesPlan(intendedPlan, event.data.amount, event.data.currency);

            // Reserve the event first (before any subscription mutation) using the
            // Payment model. The paymentDomain distinguishes order payments
            // (subscription: null) from subscription payments (subscription set).
            // In this implementation, all webhook-processed payments are
            // subscription-type since they attach to a business subscription.
            const paymentDomain = "subscription";

            await new Payment({
              business: businessId,
              subscription: subscription._id,
              amount: event.data.amount ?? 0,
              currency: intendedPlan.currency,
              status: "succeeded",
              provider: env().PAYMENT_PROVIDER,
              providerEventId: event.id,
              providerPaymentId: event.data.providerPaymentId ?? "",
              description: event.type,
              paidAt: new Date(),
              paymentDomain,
            }).save({ session });

            // Apply subscription side effects on the same session so the Payment
            // row and the subscription change commit or roll back together.
            const now = new Date();
            const periodEnd = new Date(now);
            if (intendedPlan.interval === "year") {
              periodEnd.setFullYear(periodEnd.getFullYear() + 1);
            } else {
              periodEnd.setMonth(periodEnd.getMonth() + 1);
            }
            subscription.plan = intendedPlan._id;
            subscription.status = "active";
            subscription.provider = env().PAYMENT_PROVIDER;
            subscription.currentPeriodStart = now;
            subscription.currentPeriodEnd = periodEnd;
            await subscription.save({ session });
          } else {
            // `payment.failed` is recorded and never grants an entitlement.
            const paymentDomain = "subscription";

            await new Payment({
              business: businessId,
              subscription: subscription?._id ?? null,
              amount: event.data.amount ?? 0,
              currency: event.data.currency ?? "USD",
              status: "failed",
              provider: env().PAYMENT_PROVIDER,
              providerEventId: event.id,
              providerPaymentId: event.data.providerPaymentId ?? "",
              description: event.type,
              paidAt: null,
              paymentDomain,
            }).save({ session });

            if (subscription) {
              // A free plan has nothing to bill, so a stray failure event must
              // not suspend it (and take the storefront down).
              const plan = subscription.plan
                ? await Plan.findById(subscription.plan).session(session)
                : null;
              if (!plan || plan.price > 0) {
                subscription.status = "past_due";
                await subscription.save({ session });
              }
            }
          }
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          duplicate = true;
        } else if (isTransactionalConflict(error)) {
          throw new HttpError(
            409,
            "The event conflicted with a concurrent update. Please retry.",
            "conflict",
          );
        } else {
          throw error;
        }
      }
      if (providerManaged) {
        // Acknowledged so it is not delivered again. Nothing is written, not even a Payment.
        console.warn("[payments] legacy webhook ignored for a subscription billed through a provider", { operation: "legacy_webhook" });
        return ok({ received: true, ignored: true });
      }
      return duplicate
        ? ok({ received: true, duplicate: true })
        : ok({ received: true });
    } finally {
      await session.endSession();
    }
  });
}