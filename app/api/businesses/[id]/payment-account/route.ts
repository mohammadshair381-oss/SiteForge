import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { isOrderOnlinePaymentsEnabled, isOrderPaymentsLiveAllowed } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";
import { encryptCredential, isPaymentCredentialsKeyConfigured } from "@/lib/payments/credentials-crypto";
import { assertPaymentKeyForEncryption } from "@/lib/payments/key-check";
import { keyIdMatchesMode } from "@/lib/payments/razorpay";
import { BusinessPaymentAccount, type BusinessPaymentAccountDoc } from "@/models/BusinessPaymentAccount";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Owner-only management of the business's OWN Razorpay account.
 * Secrets are write-only: they are encrypted before storage and no response
 * ever contains them (not even masked).
 */
function publicView(account: Pick<BusinessPaymentAccountDoc, "provider" | "mode" | "status" | "keyId" | "connectedAt" | "rotatedAt"> | null) {
  return {
    featureEnabled: isOrderOnlinePaymentsEnabled(),
    encryptionConfigured: isPaymentCredentialsKeyConfigured(),
    liveAllowed: isOrderPaymentsLiveAllowed(),
    account:
      account && account.status === "active"
        ? {
            provider: account.provider,
            mode: account.mode,
            keyId: account.keyId,
            connectedAt: account.connectedAt,
            rotatedAt: account.rotatedAt ?? null,
          }
        : null,
  };
}

const connectSchema = z.object({
  mode: z.enum(["test", "live"]),
  keyId: z.string().trim().min(1).max(100),
  keySecret: z.string().trim().min(8).max(200),
  webhookSecret: z.string().trim().min(8).max(200),
});

export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { membership } = await requireBusinessRole(id, ["owner"]);
    await dbConnect();
    const account = await BusinessPaymentAccount.findOne({ business: membership.business, provider: "razorpay" }).lean();
    return ok(publicView(account), { headers: { "Cache-Control": "no-store" } });
  });
}

export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { membership } = await requireBusinessRole(id, ["owner"]);
    await requireVerifiedEmail();
    await dbConnect();
    await enforceRateLimit({ key: `payment-account:business:${id}`, limit: 10, windowMs: 60 * 60 * 1000 });

    if (!isOrderOnlinePaymentsEnabled()) {
      throw new HttpError(409, "Online payments are not enabled on this platform yet", "online_payments_disabled");
    }
    if (!isPaymentCredentialsKeyConfigured()) {
      throw new HttpError(503, "Payment credential storage is not configured", "payment_encryption_unconfigured");
    }
    const input = connectSchema.parse(await readJson(request));
    if (input.mode === "live" && !isOrderPaymentsLiveAllowed()) {
      throw new HttpError(403, "Live payments are not enabled on this platform", "live_payments_disabled");
    }
    if (!keyIdMatchesMode(input.keyId, input.mode)) {
      throw new HttpError(422, `The key id must be a Razorpay ${input.mode}-mode key (rzp_${input.mode}_…)`, "invalid_key_id");
    }
    // Last check before writing: secrets are encrypted only under a key proven to be the original
    // (or the first key ever used). Anything else answers 503 and the stored account is untouched.
    await assertPaymentKeyForEncryption();

    const now = new Date();
    const existing = await BusinessPaymentAccount.findOne({ business: membership.business, provider: "razorpay" }).select("_id");
    const account = await BusinessPaymentAccount.findOneAndUpdate(
      { business: membership.business, provider: "razorpay" },
      {
        $set: {
          mode: input.mode,
          status: "active",
          keyId: input.keyId,
          keySecretEnc: encryptCredential(input.keySecret),
          webhookSecretEnc: encryptCredential(input.webhookSecret),
          ...(existing ? { rotatedAt: now } : {}),
        },
        $setOnInsert: { connectedAt: now },
      },
      { upsert: true, new: true, runValidators: true },
    ).lean();
    return ok(publicView(account));
  });
}

/** Disconnect: the account is disabled and its encrypted secrets are removed. */
export async function DELETE(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { membership } = await requireBusinessRole(id, ["owner"]);
    await dbConnect();
    await BusinessPaymentAccount.updateOne(
      { business: membership.business, provider: "razorpay" },
      { $set: { status: "disabled" }, $unset: { keySecretEnc: "", webhookSecretEnc: "" } },
    );
    return ok(publicView(null));
  });
}
