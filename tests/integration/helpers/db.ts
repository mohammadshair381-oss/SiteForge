import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { RateLimit } from "@/models/RateLimit";
import { DomainVerification } from "@/models/DomainVerification";
import { User } from "@/models/User";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Product } from "@/models/Product";
import { Category } from "@/models/Category";
import { Plan } from "@/models/Plan";
import { Subscription } from "@/models/Subscription";
import { Payment } from "@/models/Payment";
import { AuthToken } from "@/models/AuthToken";
import { Media } from "@/models/Media";
import { Order } from "@/models/Order";
import { Cart } from "@/models/Cart";
import { Page } from "@/models/Page";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { Customer } from "@/models/Customer";
import { CustomerActionToken } from "@/models/CustomerActionToken";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { OrderPayment } from "@/models/OrderPayment";
import { SecurityEvent } from "@/models/SecurityEvent";
import { PaymentDispute } from "@/models/PaymentDispute";
import { WebsiteProposal } from "@/models/WebsiteProposal";
import { AiUsage } from "@/models/AiUsage";
import { AiConsentEvent } from "@/models/AiConsentEvent";

const ALL_MODELS = [
  RateLimit,
  DomainVerification,
  User,
  Business,
  Membership,
  Product,
  Category,
  Plan,
  Subscription,
  Payment,
  AuthToken,
  Media,
  Order,
  Cart,
  Page,
  AdminAuditLog,
  Customer,
  CustomerActionToken,
  // autoIndex is off for these two; the test DB creates their documented
  // indexes explicitly, mirroring the approved production operation.
  BusinessPaymentAccount,
  OrderPayment,
  SecurityEvent,
  PaymentDispute,
  WebsiteProposal,
  AiUsage,
  AiConsentEvent,
];

export async function connectTestDB(): Promise<void> {
  await dbConnect();

  for (const model of ALL_MODELS) {
    await model.createIndexes();
  }
}

export async function clearAllCollections(): Promise<void> {
  for (const model of ALL_MODELS) {
    await model.collection.deleteMany({});
  }
}

export async function disconnectTestDB(): Promise<void> {
  await mongoose.connection.close();

  const cache = (globalThis as { _mongooseCache?: { conn: unknown; promise: unknown } })._mongooseCache;
  if (cache) {
    cache.conn = null;
    cache.promise = null;
  }
}

export async function ensureIndexesExist(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const [, collection] of Object.entries(collections)) {
    const indexes = await collection.indexes();
    const hasUniqueKeyIndex = indexes.some(
      (index) => index.unique === true && index.key?.key === 1,
    );
    if (!hasUniqueKeyIndex && collection.collectionName === "ratelimits") {
      throw new Error("RateLimit unique key index missing");
    }
  }
}

export {};