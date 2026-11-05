import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok, created, readJson, HttpError } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import {
  ADMIN_REASON_MAX,
  ADMIN_REASON_MIN,
  changedFields,
  runAuditedAdminAction,
} from "@/lib/admin-audit";
import { Plan, type PlanDoc } from "@/models/Plan";
import { THEME_IDS } from "@/lib/constants";
import { normalizeThemeList } from "@/lib/theme-tiers";

const keySchema = z.string().trim().toLowerCase().min(1).max(40);

/** Empty strings and null mean "not provided", never 0 (a cleared field must not make a plan free). */
const blankToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);
const requiredNumber = (min: number, max?: number) =>
  z.preprocess(blankToUndefined, max === undefined ? z.coerce.number().min(min) : z.coerce.number().min(min).max(max));
/** At most two decimal places (9.99): stored as entered, and compared exactly to payment amounts. */
const hasTwoDecimalsAtMost = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const PRICE_MESSAGE = "Price can have at most two decimal places";
const requiredPrice = z.preprocess(blankToUndefined, z.coerce.number().min(0).max(1_000_000).refine(hasTwoDecimalsAtMost, PRICE_MESSAGE));
const optionalPrice = z.preprocess(blankToUndefined, z.coerce.number().min(0).max(1_000_000).refine(hasTwoDecimalsAtMost, PRICE_MESSAGE).optional());
const optionalNumber = (min: number, max?: number) =>
  z.preprocess(
    blankToUndefined,
    (max === undefined ? z.coerce.number().min(min) : z.coerce.number().min(min).max(max)).optional(),
  );
const optionalInt = (min?: number) =>
  z.preprocess(
    blankToUndefined,
    (min === undefined ? z.coerce.number().int() : z.coerce.number().int().min(min)).optional(),
  );

/** A limit a plan may leave open: a blank field means no limit, and clears a stored one. */
const nullableLimit = (max: number) =>
  z.preprocess((value) => (value === "" ? null : value), z.coerce.number().int().min(0).max(max).nullable().optional());

/**
 * Themes a plan includes: known ids only, no duplicates, at least one (a plan
 * without any theme could not render a store). Stored in catalogue order.
 */
const themesSchema = z
  .array(z.enum(THEME_IDS, { error: "Unknown theme" }))
  .min(1, "Choose at least one theme for this plan")
  .max(THEME_IDS.length)
  .refine((list) => new Set(list).size === list.length, "Each theme can be listed only once")
  .transform((list) => normalizeThemeList(list));

const common = {
  key: keySchema,
  /** Explicit intent. Omitted = legacy behaviour (create if new, else update). */
  mode: z.enum(["create", "update"]).optional(),
  reason: z.string().trim().max(ADMIN_REASON_MAX).optional(),
};

/** Full schema with defaults: used only when CREATING a plan. */
const createSchema = z.object({
  ...common,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  price: requiredPrice,
  currency: z.string().trim().length(3).toUpperCase().prefault("USD"),
  interval: z.enum(["month", "year"]).prefault("month"),
  features: z
    .object({
      productLimit: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).prefault(10)),
      staffLimit: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).prefault(1)),
      customDomain: z.boolean().prefault(false),
      removeBranding: z.boolean().prefault(false),
      /** AI suggestions per month; omitted = the platform default. */
      aiRequestsPerMonth: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(100_000).optional()),
      /** Themes the plan includes; omitted = the default tier for the key (lib/theme-tiers.ts). */
      themes: themesSchema.optional(),
      pageLimit: nullableLimit(100_000),
      storageMb: nullableLimit(10_000_000),
      monthlyOrderLimit: nullableLimit(10_000_000),
    })
    .prefault({}),
  active: z.boolean().prefault(true),
  sort: z.preprocess(blankToUndefined, z.coerce.number().int().prefault(0)),
});

/**
 * Partial schema with NO defaults: used when UPDATING an existing plan, so a
 * field (or feature) the caller omits keeps its stored value. Previously the
 * create defaults were applied to updates too, which silently reset currency
 * to USD, sort to 0 and re-activated deactivated plans.
 */
const updateSchema = z.object({
  ...common,
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(400).optional(),
  price: optionalPrice,
  currency: z.string().trim().length(3).toUpperCase().optional(),
  interval: z.enum(["month", "year"]).optional(),
  features: z
    .object({
      productLimit: optionalInt(0),
      staffLimit: optionalInt(0),
      customDomain: z.boolean().optional(),
      removeBranding: z.boolean().optional(),
      aiRequestsPerMonth: optionalInt(0),
      themes: themesSchema.optional(),
      pageLimit: nullableLimit(100_000),
      storageMb: nullableLimit(10_000_000),
      monthlyOrderLimit: nullableLimit(10_000_000),
    })
    .optional(),
  active: z.boolean().optional(),
  sort: optionalInt(),
});

type PlanSnapshot = {
  name: string;
  description: string;
  price: number;
  currency: string;
  interval: PlanDoc["interval"];
  active: boolean;
  sort: number;
  features: PlanDoc["features"];
};

/** Plain, comparable view of a plan. Tolerates legacy documents without `features`. */
function snapshot(plan: Partial<PlanDoc>): PlanSnapshot {
  const features = (plan.features ?? {}) as Partial<PlanDoc["features"]>;
  return {
    name: plan.name ?? "",
    description: plan.description ?? "",
    price: plan.price ?? 0,
    currency: plan.currency ?? "USD",
    interval: plan.interval ?? "month",
    active: plan.active ?? true,
    sort: plan.sort ?? 0,
    features: {
      productLimit: features.productLimit ?? 10,
      staffLimit: features.staffLimit ?? 1,
      customDomain: features.customDomain ?? false,
      removeBranding: features.removeBranding ?? false,
      // Only when set: plans without it use the platform default.
      ...(typeof features.aiRequestsPerMonth === "number" ? { aiRequestsPerMonth: features.aiRequestsPerMonth } : {}),
      // Only when set: plans without it use the default tier for their key.
      ...(Array.isArray(features.themes) && features.themes.length > 0 ? { themes: normalizeThemeList(features.themes) } : {}),
      // Only when set: no value means no limit.
      ...(typeof features.pageLimit === "number" ? { pageLimit: features.pageLimit } : {}),
      ...(typeof features.storageMb === "number" ? { storageMb: features.storageMb } : {}),
      ...(typeof features.monthlyOrderLimit === "number" ? { monthlyOrderLimit: features.monthlyOrderLimit } : {}),
    },
  };
}

export async function GET() {
  return handle(async () => {
    await requireSuperAdmin();
    await dbConnect();
    const plans = await Plan.find().sort({ sort: 1 }).lean();
    return ok({ plans });
  });
}

/**
 * `POST /api/admin/plans`
 *
 * - `mode: "create"`: creates the plan (documented defaults apply) -> 201;
 *   409 `plan_exists` if the key is taken (never overwrites).
 * - `mode: "update"`: updates ONLY the fields present in the body (individual
 *   `features.*` too) -> 200; 404 if the key is unknown. Omitted fields keep
 *   their stored values; empty/null numbers count as omitted.
 * - No `mode` (legacy callers): create if the key is new, otherwise update.
 * - `{ key, active }` is the explicit activation control. Deactivating requires
 *   a reason: a deactivated plan is hidden from the public plan list and
 *   refused for new checkouts and webhook renewals (existing subscribers'
 *   current entitlements are not changed by this route).
 *
 * Every successful change is recorded in the admin audit log in the same
 * transaction. A no-op update writes nothing and records nothing.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const admin = await requireSuperAdmin();
    const raw = await readJson(request);
    const { key, mode } = z
      .object({ key: keySchema, mode: common.mode })
      .passthrough()
      .parse(raw);
    await dbConnect();

    const exists = Boolean(await Plan.exists({ key }));
    if (mode === "create" && exists) {
      throw new HttpError(409, `A plan with key "${key}" already exists. Edit it instead.`, "plan_exists");
    }
    if (mode === "update" && !exists) {
      throw new HttpError(404, "Plan not found", "not_found");
    }

    if (!exists) {
      const { reason, mode: _mode, ...body } = createSchema.parse(raw);
      const plan = await runAuditedAdminAction(async (session) => {
        const [doc] = await Plan.create([body], { session });
        return {
          result: doc,
          audit: {
            actorId: String(admin._id),
            action: "plan.create",
            targetType: "plan",
            targetId: doc.key,
            targetLabel: doc.name,
            reason: reason ?? "",
            before: null,
            after: snapshot(doc.toObject() as PlanDoc),
          },
        };
      });
      return created({ plan: plan.toJSON() });
    }

    const { reason, key: _key, mode: _mode, features, ...fields } = updateSchema.parse(raw);

    const result = await runAuditedAdminAction(
      async (session) => {
        // Read the current state INSIDE the transaction so the audit diff and
        // the no-op check describe exactly what this request changed.
        const current = await Plan.findOne({ key }).session(session).lean<PlanDoc>();
        if (!current) throw new HttpError(404, "Plan not found", "not_found");
        const before = snapshot(current);

        const proposed: PlanSnapshot = {
          ...before,
          ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
          features: {
            ...before.features,
            ...Object.fromEntries(
              Object.entries(features ?? {}).filter(([, value]) => value !== undefined),
            ),
          },
        } as PlanSnapshot;
        const diff = changedFields(
          before as unknown as Record<string, unknown>,
          proposed as unknown as Record<string, unknown>,
        );
        const changedKeys = Object.keys(diff.after);
        if (changedKeys.length === 0) {
          return {
            result: { plan: current, changed: false },
            audit: {
              actorId: String(admin._id),
              action: "plan.update",
              targetType: "plan",
              targetId: key,
            },
          };
        }

        const onlyActive = changedKeys.length === 1 && changedKeys[0] === "active";
        const deactivating = before.active && proposed.active === false;
        if (deactivating && (reason ?? "").length < ADMIN_REASON_MIN) {
          throw new HttpError(
            422,
            `Deactivating a plan blocks new checkouts and renewals. Give a reason of at least ${ADMIN_REASON_MIN} characters.`,
            "reason_required",
          );
        }

        const set: Record<string, unknown> = {};
        for (const field of changedKeys) {
          if (field === "features") {
            for (const [feature, value] of Object.entries(proposed.features)) {
              // Arrays (themes) compare by value, not by reference.
              if (JSON.stringify(value) !== JSON.stringify(before.features[feature as keyof PlanDoc["features"]])) {
                set[`features.${feature}`] = value;
              }
            }
          } else {
            set[field] = proposed[field as keyof PlanSnapshot];
          }
        }

        const updated = await Plan.findOneAndUpdate(
          { key },
          { $set: set },
          { new: true, session, runValidators: true },
        ).lean<PlanDoc>();

        return {
          result: { plan: updated, changed: true },
          audit: {
            actorId: String(admin._id),
            action: onlyActive
              ? proposed.active
                ? "plan.activate"
                : "plan.deactivate"
              : "plan.update",
            targetType: "plan",
            targetId: key,
            targetLabel: proposed.name,
            reason: reason ?? "",
            before: diff.before,
            after: diff.after,
          },
        };
      },
      { skipAuditWhen: (outcome) => !outcome.changed },
    );

    return ok({ plan: result.plan, changed: result.changed });
  });
}
