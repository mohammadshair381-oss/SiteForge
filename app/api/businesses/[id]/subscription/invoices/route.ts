import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { listInvoices } from "@/lib/billing-razorpay";
import { RazorpayApiError } from "@/lib/payments/razorpay";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — this store's invoices, read from Razorpay. Owner only, like all billing. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner"]);
    try {
      return ok({ invoices: await listInvoices({ businessId: id }), unavailable: false }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof RazorpayApiError) return ok({ invoices: [], unavailable: true }, { headers: { "Cache-Control": "no-store" } });
      throw error;
    }
  });
}
