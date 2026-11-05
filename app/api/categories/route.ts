import { dbConnect } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { Category } from "@/models/Category";

export async function GET() {
  return handle(async () => {
    await dbConnect();
    const categories = await Category.find({ active: true }).sort({ sort: 1 }).lean();
    return ok({ categories });
  });
}
