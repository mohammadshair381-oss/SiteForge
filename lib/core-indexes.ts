/**
 * The unique indexes the core records rest on (pure, apart from reading through the handle it is given).
 * With automatic index creation off (`automaticIndexesAllowed`, lib/db.ts), nothing else guarantees they
 * exist, and without them two stores could share an address or two accounts an email. So `dbConnect`
 * looks for them and refuses to work without them. It only looks: creating an index on a persistent
 * database is an approved operation (docs/database-preparation.md). This file imports no model and
 * nothing from lib/db.ts, which is what lets `dbConnect` use it.
 */
export interface UniqueIndexRule {
  key: Record<string, number>;
  /** Documented filter. A partial index with any other filter would not protect every record. */
  partial?: Record<string, unknown>;
  /**
   * The feature breaks without exactly this filter. Unset, a full unique index is as
   * protective, so it is accepted too (a store's older index must not switch a feature off).
   */
  partialRequired?: boolean;
}

export interface StoredIndex {
  key?: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

const sameKey = (a: Record<string, unknown>, b: Record<string, number>) => {
  const left = Object.entries(a);
  const right = Object.entries(b);
  return left.length === right.length && left.every(([key, value], index) => right[index][0] === key && right[index][1] === value);
};

/** Whether an index in the database gives the protection this rule asks for. */
export function matchesUniqueIndex(index: StoredIndex, rule: UniqueIndexRule): boolean {
  if (index.unique !== true || index.key === undefined || !sameKey(index.key, rule.key)) return false;
  if (index.partialFilterExpression) return JSON.stringify(index.partialFilterExpression) === JSON.stringify(rule.partial ?? null);
  return rule.partialRequired !== true;
}

export const NAMESPACE_NOT_FOUND = 26;

/** Keep in step with the models and with "Core indexes" in docs/database-preparation.md. */
export const CORE_UNIQUE_INDEXES: ReadonlyArray<UniqueIndexRule & { collection: string }> = [
  { collection: "users", key: { email: 1 } },
  { collection: "authtokens", key: { tokenHash: 1 } },
  { collection: "businesses", key: { slug: 1 } },
  { collection: "businesses", key: { subdomain: 1 } },
  { collection: "memberships", key: { business: 1, user: 1 } },
  { collection: "plans", key: { key: 1 } },
  { collection: "categories", key: { key: 1 } },
  { collection: "products", key: { business: 1, slug: 1 } },
  { collection: "pages", key: { business: 1, slug: 1 } },
  { collection: "pages", key: { business: 1, isHome: 1 }, partial: { isHome: true }, partialRequired: true },
  { collection: "media", key: { storageKey: 1 } },
  { collection: "orders", key: { orderNumber: 1 } },
  { collection: "orders", key: { business: 1, orderNumber: 1 } },
  { collection: "orders", key: { business: 1, idempotencyKey: 1 }, partial: { idempotencyKey: { $type: "string" } } },
  { collection: "payments", key: { providerEventId: 1 }, partial: { providerEventId: { $gt: "" } } },
  { collection: "subscriptions", key: { providerSubscriptionId: 1 }, partial: { providerSubscriptionId: { $gt: "" } } },
];

interface IndexReader {
  collection(name: string): { listIndexes(): { toArray(): Promise<unknown[]> } };
}

const describeRule = (rule: UniqueIndexRule & { collection: string }) => `${rule.collection} ${JSON.stringify(rule.key)}${rule.partial ? ` where ${JSON.stringify(rule.partial)}` : ""}`;

/**
 * What is really missing, and whether the database could not say. "Could not say" proves nothing either way,
 * so it never counts as missing: a passing network problem must not take a store down.
 */
export async function findMissingCoreIndexes(db: IndexReader): Promise<{ missing: string[]; uncertain: boolean }> {
  const collections = [...new Set(CORE_UNIQUE_INDEXES.map((rule) => rule.collection))];
  let uncertain = false;
  const found = new Map<string, StoredIndex[]>();
  await Promise.all(
    collections.map(async (name) => {
      try {
        found.set(name, (await db.collection(name).listIndexes().toArray()) as StoredIndex[]);
      } catch (error) {
        // The collection does not exist yet, which means no index either.
        if (error && typeof error === "object" && (error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) found.set(name, []);
        else uncertain = true;
      }
    }),
  );
  const missing = CORE_UNIQUE_INDEXES.filter((rule) => {
    const indexes = found.get(rule.collection);
    return indexes !== undefined && !indexes.some((index) => matchesUniqueIndex(index, rule));
  }).map(describeRule);
  return { missing, uncertain };
}
