import { dbConnect } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { Plan } from "@/models/Plan";

export async function GET() {
  return handle(async () => {
    await dbConnect();
    const plans = await Plan.find({ active: true }).sort({ sort: 1 }).lean();
    return ok({ plans });
  });
}
