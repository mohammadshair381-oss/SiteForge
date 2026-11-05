import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";

/** Whether this database can run transactions: `null` if it could not be asked. Reads only. */
export async function databaseSupportsTransactions(): Promise<boolean | null> {
  try {
    await dbConnect();
    const db = mongoose.connection.db;
    if (!db) return null;
    const hello = (await db.admin().command({ hello: 1 })) as { setName?: unknown; msg?: unknown };
    return Boolean(hello.setName) || hello.msg === "isdbgrid";
  } catch {
    return null;
  }
}
