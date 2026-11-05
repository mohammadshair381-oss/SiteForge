import { NextResponse } from "next/server";
import { isProduction } from "@/lib/env";
import { resolveBusinessByHost } from "@/lib/tenant";
import { enforceOrderReadRateLimit } from "@/lib/storefront-rate-limit";
import { verifyPaymentLinkCallbackSignature, RazorpayApiError } from "@/lib/payments/razorpay";
import { confirmPaymentLink, keySecretOf } from "@/lib/payments/order-payments";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { OrderPayment } from "@/models/OrderPayment";

export const runtime = "nodejs";

/**
 * `GET /api/storefront/payments/razorpay/return` — where Razorpay sends the
 * shopper after the hosted payment page.
 *
 * The query string is shopper-controlled. Its signature is verified with the
 * business's key secret, and even then the payment is applied only after
 * `confirmPaymentLink` re-reads the link from the Razorpay API. Whatever
 * happens, the shopper is redirected to the order page on the same store; no
 * error detail is shown and nothing is logged from the query string.
 */
export async function GET(request: Request) {
  const host = request.headers.get("host");
  const origin = host ? `${isProduction() ? "https" : "http"}://${host}` : null;
  const params = new URL(request.url).searchParams;
  const linkId = params.get("razorpay_payment_link_id") ?? "";
  const referenceId = params.get("razorpay_payment_link_reference_id") ?? "";
  const status = params.get("razorpay_payment_link_status") ?? "";
  const paymentId = params.get("razorpay_payment_id") ?? "";
  const signature = params.get("razorpay_signature") ?? "";

  const business = await resolveBusinessByHost(host);
  if (!business || !origin) return new NextResponse("Not found", { status: 404 });
  const businessId = String(business._id);

  const redirectTo = (orderId: string | null, result: string) => {
    const target = orderId ? `/order/${orderId}?payment=${result}` : "/";
    const response = NextResponse.redirect(new URL(target, origin), 303);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };

  try {
    await enforceOrderReadRateLimit(request, businessId);
  } catch {
    return redirectTo(null, "pending");
  }

  if (!/^plink_[A-Za-z0-9]+$/.test(linkId)) return redirectTo(null, "pending");
  const payment = await OrderPayment.findOne({ business: business._id, providerLinkId: linkId }).select("order").lean();
  // The reference must be the order this business recorded for this link.
  if (!payment || String(payment.order) !== referenceId) return redirectTo(null, "pending");
  const orderId = String(payment.order);

  const account = await BusinessPaymentAccount.findOne({ business: business._id, provider: "razorpay" })
    .select("+keySecretEnc +webhookSecretEnc")
    .lean();
  if (!account?.keySecretEnc) return redirectTo(orderId, "pending");

  let valid = false;
  try {
    valid = verifyPaymentLinkCallbackSignature(keySecretOf(account as Parameters<typeof keySecretOf>[0]), {
      linkId,
      referenceId,
      status,
      paymentId,
      signature,
    });
  } catch {
    valid = false;
  }
  if (!valid) return redirectTo(orderId, "pending");

  try {
    const { outcome } = await confirmPaymentLink({ businessId, linkId });
    if (outcome === "applied" || outcome === "already_applied") return redirectTo(orderId, "success");
    if (outcome === "needs_review") return redirectTo(orderId, "review");
    return redirectTo(orderId, status === "paid" ? "pending" : "failed");
  } catch (error) {
    if (!(error instanceof RazorpayApiError)) console.error("[payments] return handler failed", { operation: "return" });
    // The webhook will still confirm the payment later.
    return redirectTo(orderId, "pending");
  }
}
