/**
 * The three separate questions about a store (pure). `planAccess` is the same answer
 * `getEntitlements().active` gives, and `hasEligiblePublisher` and `navigationValid` come from
 * `getPublishFacts` (lib/publish-gates.ts), beside the guards the publish route itself uses. So
 * nothing here is a second calculation of either: it only combines their answers.
 */
export interface StoreAccess {
  /** The subscription grants a plan's features now, including during a grace period. */
  planAccess: boolean;
  /** The owner can actually use those features: plan access, and not suspended. */
  featureAccess: boolean;
  /** Publishing would be allowed, for someone. Maintenance mode can pause it for every store. */
  publishEligible: boolean;
  /** Shoppers can reach the storefront now. */
  storeOnline: boolean;
  /** Why publishing would be refused. */
  blockers: string[];
}

export function describeStoreAccess(input: { status: string; planAccess: boolean; hasEligiblePublisher: boolean; navigationValid: boolean }): StoreAccess {
  const suspended = input.status === "suspended";
  const blockers = [
    ...(suspended ? ["Suspended"] : []),
    ...(input.planAccess ? [] : ["No active plan"]),
    ...(input.hasEligiblePublisher ? [] : ["No owner or manager with a verified email"]),
    ...(input.navigationValid ? [] : ["A menu links to a page that no longer exists"]),
  ];
  return {
    planAccess: input.planAccess,
    featureAccess: input.planAccess && !suspended,
    publishEligible: blockers.length === 0,
    storeOnline: input.status === "published" && input.planAccess,
    blockers,
  };
}
