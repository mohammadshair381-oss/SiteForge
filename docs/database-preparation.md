# Database preparation

Index work to review before a persistent database is prepared. Nothing here has
been run on any persistent database. Each step needs its own approval.

## MongoDB must be a replica set

Products, pages with a plan limit, media with a plan limit, team changes, orders, refunds, billing and audited
admin actions all use multi-document transactions, so a limit cannot be passed and a refused change leaves nothing
behind. SiteForge never falls back to writing without one. On a standalone `mongod`, those actions are refused with
a `503 transactions_unavailable` and nothing is changed. `/admin/settings` shows which you have.

- **MongoDB Atlas** is always a replica set, so it works unchanged.
- **Local development:** start a single-node replica set. It needs no data migration:

```sh
mongod --replSet rs0 --dbpath <your data folder>
mongosh --eval "rs.initiate()"     # once only
```

Then use a URI ending in `?replicaSet=rs0`, as `.env.example` shows.

## Automatic index policy

Starting SiteForge does not create collections or indexes on a persistent database, and nothing at runtime does either.
`automaticIndexesAllowed` (`lib/db.ts`) decides, and there is deliberately no setting to change it:

| Database | Automatic creation |
|---|---|
| `NODE_ENV=production`, wherever it is | Off |
| Reached over a network (`mongodb+srv://`, or any host other than this machine), whatever `NODE_ENV` says | Off |
| `NODE_ENV` is development or test, and every host is `localhost`, `127.x.x.x` or `[::1]` | On, for models that do not opt out |

That last row is local development and the in-memory test server, where nothing else depends on the database. A model's
own `autoIndex: false` or `autoCreate: false` always wins. Scripts (`seed`, `create-admin`, `domain-migration`) connect
through `dbConnect`, so the same rule applies to them. The rate limiter no longer calls `createIndexes()`: it only checks.

With automatic creation off:

- **Core indexes are required before the first start** (next section). If one is missing, `dbConnect` logs
  `database_not_prepared` with what is missing and refuses, so every database-backed page and API answers an error
  (`503 database_not_prepared` from API routes), storefronts included. It looks again each minute, so creating the index
  needs no restart. A database that cannot answer proves nothing and is not treated as missing.
- **The rate limiter's unique index is required too.** Without it, every rate-limited route answers
  `503 rate_limit_unavailable`, sign-in included.
- **Features gated by `lib/required-indexes.ts` stay off** until their indexes exist, as before.
- **Other indexes only affect speed or cleanup.** Without them things work, more slowly, and TTL cleanup does not happen.
- **Collections are created by their first write, or by creating an index.** A first write inside a transaction needs
  MongoDB 4.4 or later, so on an older server create the collections first.

A development machine pointed at a shared cluster gets the same treatment as production: that database must be prepared
like any other. Every step below needs its own approval.

## Core indexes

**Required before the first start on a persistent database.** Declared in the models and listed in
`lib/core-indexes.ts`, which `dbConnect` checks. If a build fails on duplicates, stop and review them: never delete data
to make an index fit.

```js
db.users.createIndex({ email: 1 }, { unique: true })
db.authtokens.createIndex({ tokenHash: 1 }, { unique: true })
db.businesses.createIndex({ slug: 1 }, { unique: true })
db.businesses.createIndex({ subdomain: 1 }, { unique: true })
db.memberships.createIndex({ business: 1, user: 1 }, { unique: true })
db.plans.createIndex({ key: 1 }, { unique: true })
db.categories.createIndex({ key: 1 }, { unique: true })
db.products.createIndex({ business: 1, slug: 1 }, { unique: true })
db.pages.createIndex({ business: 1, slug: 1 }, { unique: true })
db.pages.createIndex({ business: 1, isHome: 1 }, { unique: true, partialFilterExpression: { isHome: true } })
db.media.createIndex({ storageKey: 1 }, { unique: true })
db.orders.createIndex({ orderNumber: 1 }, { unique: true })
db.orders.createIndex({ business: 1, orderNumber: 1 }, { unique: true })
db.orders.createIndex({ business: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "uniq_business_idempotencyKey_string" })
db.payments.createIndex({ providerEventId: 1 }, { unique: true, partialFilterExpression: { providerEventId: { $gt: "" } } })
db.subscriptions.createIndex({ providerSubscriptionId: 1 }, { unique: true, partialFilterExpression: { providerSubscriptionId: { $gt: "" } } })
```

The rate limiter's (the first is required, the second removes old counters):

```js
db.ratelimits.createIndex({ key: 1 }, { unique: true })
db.ratelimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

Declared in these models, for speed and cleanup. Automatic creation used to build these and no longer does on a
persistent database, so create them with the rest:

```js
db.authtokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
db.authtokens.createIndex({ user: 1, type: 1 })
db.businesses.createIndex({ category: 1 })
db.businesses.createIndex({ status: 1 })
db.memberships.createIndex({ business: 1 })
db.memberships.createIndex({ user: 1 })
db.products.createIndex({ business: 1 })
db.products.createIndex({ status: 1 })
db.products.createIndex({ business: 1, status: 1 })
db.pages.createIndex({ business: 1 })
db.pages.createIndex({ status: 1 })
db.pages.createIndex({ isHome: 1 })
db.media.createIndex({ business: 1 })
db.media.createIndex({ business: 1, createdAt: -1 })
db.media.createIndex({ business: 1, deletedAt: 1 })
db.media.createIndex({ deletedAt: 1, storageDeletedAt: 1 })
db.orders.createIndex({ business: 1, ownerToken: 1 })
db.payments.createIndex({ business: 1, paymentDomain: 1 })
db.subscriptions.createIndex({ business: 1, status: 1 })
db.carts.createIndex({ business: 1, ownerToken: 1 })
```

Custom domains also used to get theirs automatically. New domain claims stay off until the first two exist:

```js
db.businesses.createIndex({ customDomain: 1 }, { unique: true, partialFilterExpression: { customDomain: { $gt: "" } } })
db.domainverifications.createIndex({ domain: 1 }, { unique: true, partialFilterExpression: { domain: { $gt: "" } }, name: "domain_verification_1" })
db.domainverifications.createIndex({ business: 1, domain: 1 }, { unique: true })
db.domainverifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

The models also declare some single-field indexes not listed here (see "Single-field `{ business: 1 }` indexes" below and
each model's `index: true` fields). Check the schema you are deploying, since this list is written by hand. Subscription
checkout's index is further down.

## Optional indexes for the Super Admin directory

The directory works without these, and nothing creates them. They only speed up its lookups as the number of
stores grows, and are not declared in the models:

```js
db.subscriptions.createIndex({ business: 1, createdAt: -1 })  // latest subscription of each store
db.subscriptions.createIndex({ status: 1, business: 1 })      // the subscription status filter
db.subscriptions.createIndex({ plan: 1, business: 1 })        // the plan filter
db.memberships.createIndex({ business: 1, role: 1, status: 1 }) // who can publish
db.businesses.createIndex({ status: 1, createdAt: -1 })       // status filter, newest first
db.orders.createIndex({ business: 1, updatedAt: 1 })          // notification catch-up
db.productreviews.createIndex({ business: 1, status: 1, createdAt: -1 }) // reviews sections on the storefront
db.aiplangenerations.createIndex({ business: 1, createdAt: -1 }) // comparing saved plans with recent AI plans
db.aiconversations.createIndex({ business: 1, createdBy: 1, createdAt: -1 }) // a person's website conversation
```

## Cart: the duplicate `{ business: 1 }` declaration (fixed in code)

`models/Cart.ts` declared the same index twice, which caused Mongoose's "Duplicate
schema index" warning. The second declaration has been removed. The set of declared
indexes is unchanged, so no database change follows from it, and a test `createIndexes`
on a throwaway server produced a single `business_1`.

Recommended, not done: every cart query found filters by `business` and `ownerToken`
together, which `business_1_ownerToken_1` serves, so `business_1` and `ownerToken_1`
may be unused. Check `$indexStats` over a representative period before considering
any removal.

## DomainVerification: two indexes on `{ domain: 1 }` (not changed)

The `domain` field has `index: true`, and the schema also declares a named index on
the same key. They are genuinely different, so Mongoose does not warn:

| Index | Comes from | Purpose |
|---|---|---|
| `domain_verification_1` | `schema.index()` | Unique, partial. Enforces one record per domain across all businesses: a real security rule |
| `domain_1` | `index: true` | Plain lookup. Redundant |

On a throwaway MongoDB 8.2 server, both were created. Queries on `{ domain }` and on
`{ business, domain }` chose `domain_verification_1`, and with `domain_1` dropped the
`{ domain }` query still used it. Only `domain_verification_1` is required.

This has not been tested on other MongoDB versions. MongoDB restricts indexes that
share a key pattern, so an older server could refuse one of the two, leaving whichever
was created first. Check that the unique one exists, because it is the one that matters.

Recommended configuration, not applied:

1. Run `db.domainverifications.getIndexes()` and confirm `domain_verification_1`
   exists, is unique, and has the partial filter. If it is missing, duplicates may
   exist: stop and review before creating it.
2. Remove `index: true` from `domain` in `models/DomainVerification.ts`. This only
   stops the plain index being declared; it does not remove it from a database.
3. Later, as an approved operation: `db.domainverifications.dropIndex("domain_1")`.

Keep `domain_verification_1`, `business_1_domain_1` (unique) and `expiresAt_1` (TTL).
`docs/domain-lifecycle-migration.md` lists these three and says not to drop or recreate
indexes during that migration. Step 3 is a separate decision.

## Single-field `{ business: 1 }` indexes (no change recommended yet)

`Customer`, `DomainVerification`, `Media`, `Membership`, `Order`, `Page`, `Payment`,
`Product` and `Subscription` also have compound indexes starting with `business`. The
compound index can serve the same queries, so these may be redundant, but they are not
duplicates. Review them with `$indexStats` before changing anything.

## Indexes for models with `autoIndex` off

Website history (`models/WebsiteRevision.ts`):

```js
db.websiterevisions.createIndex({ business: 1, target: 1, targetId: 1, createdAt: -1 })
```

Order refunds (`models/OrderRefund.ts`) and coupon redemptions:

```js
db.orderrefunds.createIndex({ business: 1, order: 1, createdAt: -1 })
db.orderrefunds.createIndex({ providerRefundId: 1 }, { unique: true, partialFilterExpression: { providerRefundId: { $type: "string" } } })
db.couponredemptions.createIndex({ coupon: 1, emailKey: 1, status: 1 })
```

**The unique refund index is required for Razorpay refunds.** Refund processing re-checks inside a transaction, but
this index is what guarantees one record per provider refund, so the feature `order_refunds` stays off without it: starting
a Razorpay refund answers `503 feature_not_ready` before anything is held or sent, and a webhook for a refund started in
Razorpay's dashboard answers 503, so that Razorpay can deliver it again. Refunds already recorded still settle, and manual
refunds have no provider id, so neither needs it. It must have exactly this filter: a full unique index would refuse
every refund that has no provider id yet. Create it before enabling online payments.

Team invitations (`models/TeamInvitation.ts`), billing events
(`models/BillingEvent.ts`) and coupon identity keys:

```js
db.teaminvitations.createIndex({ tokenHash: 1 }, { unique: true })
db.teaminvitations.createIndex({ business: 1, status: 1, createdAt: -1 })
db.teaminvitations.createIndex({ business: 1, email: 1 }, { unique: true, partialFilterExpression: { status: "pending" } })
db.billingevents.createIndex({ provider: 1, eventId: 1 }, { unique: true })
db.billingevents.createIndex({ business: 1, createdAt: -1 })
db.billingadjustments.createIndex({ kind: 1, providerId: 1 }, { unique: true, partialFilterExpression: { providerId: { $gt: "" } } })
db.billingadjustments.createIndex({ business: 1, createdAt: -1 })
db.billingadjustments.createIndex({ payment: 1, kind: 1 })
db.domainevents.createIndex({ business: 1, domain: 1, createdAt: -1 })
db.subscriptions.createIndex({ "pendingCheckout.providerSubscriptionId": 1 }, { sparse: true })
db.couponredemptions.createIndex({ coupon: 1, phoneKey: 1, status: 1 })
db.couponredemptions.createIndex({ coupon: 1, addressKey: 1, status: 1 })
```

`lib/required-indexes.ts` looks for the unique indexes these features rest on in the database
itself, since a schema declaring an index says nothing about whether it exists. The feature stays off
until they do: team invitations (`teaminvitations`), subscription billing (`billingevents`,
`billingadjustments`), custom domains (`businesses.customDomain`, `domainverifications.domain`), carts saved to customer
accounts (`carts`), the notification centre (`notifications`) and Razorpay refunds (`orderrefunds`). It only
looks and never creates one; the Super Admin billing page lists what is missing. Automated tests run on
throwaway databases, so it does not apply there.

What counts: `{ business: 1, email: 1 }` on `teaminvitations` must have exactly the `status: "pending"` filter,
since without it a person could never be invited twice. For the others, a full unique index is as protective
as the documented partial one, so either passes, and a partial one with any other filter does not. A database
that cannot answer leaves the feature off for that request only. Custom domains only hold back new claims:
renewing or checking a domain a store already has works regardless, so existing domains are not interrupted.

`billingadjustments` is partial on `providerId` so that a record without one could never collide with another.
The app always sets one, but upserts skip Mongoose's `required` check. It uses `$gt: ""`, not `$type`, so
lookups by a real id can use the index. `billingevents` needs no filter: both its fields are always present.
`domainevents` and the non-unique indexes only affect speed, so nothing waits for them. `ScheduledJob` needs no
index: its lock relies on the built-in `_id`.

Carts saved to customer accounts need this index, and until it exists a signed-in shopper's cart stays tied to
their browser, as a guest's does:

```js
db.carts.createIndex({ business: 1, customer: 1 }, { unique: true, partialFilterExpression: { customer: { $exists: true } } })
```

It is deliberately not declared in `models/Cart.ts`, and neither are these optional ones, which only affect speed.
That model has `autoIndex` on for local databases, so declaring them there would also change what local development and
the tests build:

```js
db.carts.createIndex({ business: 1, updatedAt: -1 })                  // Abandoned carts page
db.carts.createIndex({ updatedAt: 1 })                                // expired cart cleanup
db.inventorymovements.createIndex({ business: 1, order: 1 })          // an order's stock history
```

Create the two unique indexes before use: the `billingevents` one stops two concurrent
deliveries of one webhook from both applying, and the `teaminvitations` ones keep one
live invitation per person and one holder per link. The `teaminvitations` collection
is not created automatically (`autoCreate` off), and accepting an invitation runs in a
transaction, so create the collection along with its indexes.

The notification centre (`models/Notification.ts`, `autoIndex` and `autoCreate` off) stays off until the unique
index exists, since it is what stops an event being announced twice. The second only affects speed:

```js
db.notifications.createIndex({ business: 1, dedupeKey: 1 }, { unique: true })
db.notifications.createIndex({ business: 1, occurredAt: -1 })
```

`PlatformSettings` needs no index: it is one document, read by `_id`. Its collection is created by the first save,
inside a transaction, which needs MongoDB 4.4 or later. On an older server, run `db.createCollection("platformsettings")` first.

Draft preview links (`models/PreviewLink.ts`):

```js
db.previewlinks.createIndex({ tokenHash: 1 }, { unique: true })
db.previewlinks.createIndex({ business: 1, createdAt: -1 })
db.previewlinks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

Without them both features still work, but lookups scan the collection, and
finished preview links are removed only when that business next creates one.
Expiry is always checked explicitly, so a missing TTL index never extends a link.

Create these before relying on the features at scale. The other approved index
operations are in `docs/customer-accounts.md`, `docs/payments-architecture.md` and
`docs/commerce-operations.md`.
