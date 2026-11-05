import { Schema, model, models, type Model } from "mongoose";
import { THEME_IDS, type ThemeId } from "@/lib/constants";

export interface PlanFeatures {
  productLimit: number;
  staffLimit: number;
  customDomain: boolean;
  removeBranding: boolean;
  /**
   * AI suggestions per calendar month (lib/ai-builder/usage.ts). Optional:
   * plans without it get DEFAULT_AI_REQUESTS_PER_MONTH (lib/billing.ts).
   */
  aiRequestsPerMonth?: number;
  /**
   * Storefront themes the plan includes (Super Admin plan manager).
   * Optional: plans without it use the default tier for their key
   * (lib/theme-tiers.ts `planThemes`).
   */
  themes?: ThemeId[];
  /** Pages besides the homepage. Unset or null = no limit. */
  pageLimit?: number | null;
  /** Media storage in MB. Unset or null = no limit. */
  storageMb?: number | null;
  /** Orders per calendar month. Unset or null = no limit. */
  monthlyOrderLimit?: number | null;
}

/** This plan at a billing provider. Provider plans have a fixed price, so a new price adds an entry. */
export interface ProviderPlan {
  provider: "razorpay";
  mode: "test" | "live";
  planId: string;
  amountMinor: number;
  currency: string;
  interval: "month" | "year";
  createdAt: Date;
}

export interface PlanDoc {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  interval: "month" | "year";
  features: PlanFeatures;
  active: boolean;
  sort: number;
  providerPlans?: ProviderPlan[];
}

const planSchema = new Schema<PlanDoc>(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    price: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    interval: { type: String, enum: ["month", "year"], default: "month" },
    features: {
      productLimit: { type: Number, default: 10, min: 0 },
      staffLimit: { type: Number, default: 1, min: 0 },
      customDomain: { type: Boolean, default: false },
      removeBranding: { type: Boolean, default: false },
      aiRequestsPerMonth: { type: Number, min: 0, max: 100_000, default: undefined },
      themes: { type: [{ type: String, enum: THEME_IDS }], default: undefined },
      pageLimit: { type: Number, min: 0, max: 100_000, default: undefined },
      storageMb: { type: Number, min: 0, max: 10_000_000, default: undefined },
      monthlyOrderLimit: { type: Number, min: 0, max: 10_000_000, default: undefined },
    },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
    providerPlans: {
      type: [
        new Schema<ProviderPlan>(
          {
            provider: { type: String, enum: ["razorpay"], required: true },
            mode: { type: String, enum: ["test", "live"], required: true },
            planId: { type: String, required: true },
            amountMinor: { type: Number, required: true, min: 1 },
            currency: { type: String, required: true },
            interval: { type: String, enum: ["month", "year"], required: true },
            createdAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
  },
  { timestamps: true, versionKey: false },
);

export const Plan: Model<PlanDoc> =
  (models.Plan as Model<PlanDoc>) || model<PlanDoc>("Plan", planSchema);
