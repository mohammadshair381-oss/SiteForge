# Platform management

The website builder's sections, library, screen size settings, design and menus are in `docs/storefront-commerce.md`.

How plan limits, notifications, platform settings and Super Admin plan assignment work.
Nothing in this document has been compiled or run yet.

## Plan limits

`lib/usage-limits.ts` is the one place usage is counted (`getBusinessUsage`). The billing page,
insights, notifications and the Super Admin business page all read it. `lib/plan-limits.ts` holds the
pure parts that client components also need.

| Limit | Plan field | Absent means | Stops | Enforced in |
| --- | --- | --- | --- | --- |
| Products | `features.productLimit` | required | Adding products | `assertCanAddProduct` |
| Team members | `features.staffLimit` | required | Inviting and accepting | `assertCanAddStaff`, `lib/team-invitations.ts` |
| Custom domain | `features.customDomain` | required | Adding a domain, and serving one | `assertCanAddCustomDomain`, `lib/tenant.ts` |
| Themes | `features.themes` | default tier | Switching to another theme | `assertCanUseTheme` |
| AI suggestions | `features.aiRequestsPerMonth` | platform default | New AI requests | `runAiRequest` |
| Pages | `features.pageLimit` | no limit | Creating pages | `assertCanAddPages` |
| Media storage | `features.storageMb` | no limit | Uploads | `assertStorageAvailable` |
| Orders a month | `features.monthlyOrderLimit` | no limit | New orders | `assertCanAcceptOrder` |

The last three are new and optional, so **existing plans behave exactly as before** until a Super Admin
sets a value in the plan manager. A blank field means no limit and clears a stored one.

Rules:

- A limit only ever stops something new. A smaller plan never deletes, hides or changes anything. A store
  over a limit keeps everything, can still edit it, and can delete things to get back under it.
- The homepage does not count as a page. Moving a legacy homepage to a Home page record is exempt.
- Storage counts files until they are really gone from storage, including ones waiting for cleanup.
- Monthly orders count from the 1st (UTC), and a cancelled order gives its place back. Shoppers are told
  only that the store cannot take orders now, never about its plan. A retried order still gets its answer.

Requests at the same moment cannot pass a limit together. A limit is checked in the same transaction as the
write it allows (`withUsageCheck`, or passing a session to `assertCanAddProduct`, `assertCanAddStaff`,
`assertCanAddPages`, `assertStorageAvailable` or `assertCanAcceptOrder`). Before counting, each takes the store's
turn (`takeUsageTurn`, `Business.usageTurn`): two such transactions conflict on that document, MongoDB retries the
later one, and its count then includes what the earlier one added. It uses the built-in `_id` index, so nothing
needs approval, and a refused transaction leaves nothing behind. Limits a plan does not set take no turn, so they
add no contention. AI suggestions already reserve atomically (`reserveAiRequest`).

Pages and storage only open a transaction when the plan sets a limit (`withPageCapacity`, `withStorageCapacity`).
Nothing falls back to writing without a transaction when one is needed: see "MongoDB must be a replica set" in
`docs/database-preparation.md`.

Restoring a product (`restoreArchivedProduct`) is one transaction: the limit, the edit, a `product_restored` history
entry, any stock change and any variant changes. Stock that does not add up is refused, and the product stays archived.

Media uploads (`app/api/businesses/[id]/media`, `lib/media-cleanup.ts`) write the record first, as `pending`, which
reserves the size against the plan. Then the file is uploaded, and the record becomes `ready`. So no file can exist
without a record. A failed upload removes the file. If that removal fails too, the record stays in the owner's "needs
removing" list. Uploads interrupted for an hour, and deletions storage did not confirm, are retried when the store's
library opens and by `POST /api/cron/media-cleanup`. A file anything refers to is never removed.

Default pages (`generateDefaultPages`) are created only up to the plan's allowance: contact, about and the main
product list first, then policies, then the rest (`pagePriority`). The ones left out are returned as `omitted` and
listed on the Pages screen, and the owner can prepare them after upgrading. With no room at all, nothing changes.

## Notifications

`lib/notification-events.ts` (creating), `lib/notifications.ts` (reading and catching up),
`models/Notification.ts`, `GET`/`POST /api/businesses/[id]/notifications`,
`components/dashboard/NotificationBell.tsx`, `NotificationCenter.tsx`.

Events are created as they happen. Each `notify*` function is called after the change is committed, does its work
after the response, and never throws, so a failure here cannot affect an order, payment or refund. An event's key
is fixed by what happened, so one event is listed once however often it is reported. The bell polls once a minute,
only while its tab is visible. There is no real-time service, and nothing here sends an email.

| Event | Called from |
| --- | --- |
| New order, stock it brought low | `orders` route |
| Paid | `confirmPaymentLink`, cash on delivery confirmation |
| Payment attempt declined | `recordPaymentFailure` |
| Cancelled | the three cancel paths |
| Shipped, delivered | `updateFulfillment` |
| Refund completed or failed | `settleRefund`, `failRefund` |
| Stock adjusted down | `adjustStock` |
| Subscription warning | `syncProviderSubscription` |
| Domain problem | `checkDomainActivation` |
| Invitation accepted | `acceptInvitation` |
| Suspended, reactivated | Super Admin status action |

After-response work is not a durable queue, so when someone has the dashboard open, at most every five minutes per
store, the same events are worked out from stored records with the same keys. That catch-up also covers what nothing
announces: orders whose hold expired, disputes, plan limits, a store going live, and manual subscriptions ending.
Its cursor only moves once a look has fully succeeded, and a lease that runs out by itself stops two running at once.
A look that finds more than a batch moves the cursor to where it got to, and the next continues from there. The bell
asks only for a count, and any catching up runs after that response.

Limitations:

- Catch-up looks back at most 30 days.
- More than 200 order changes inside the same two minutes can be skipped by the catch-up, though the events
  created as they happened are unaffected.
- Stock, plan and domain warnings describe the state at that moment, and repeat at most weekly or monthly.
- When the feature is first switched on, it looks back 7 days.

Each role sees only its own events: orders, payments and refunds go to owners and managers; stock to everyone;
subscription, plan limits, domains, team and disputes to owners. Read state is per person. Text never contains
a shopper's details; the one address shown is a team member's, to the owner.

Off until its unique index exists (`lib/required-indexes.ts`): the bell stays hidden and the page explains
why. See `docs/database-preparation.md`.

## Platform settings

`models/PlatformSettings.ts` (one document, `_id: "platform"`), `lib/platform-settings.ts`,
`PUT /api/admin/settings`, `/admin/settings`.

Only the support email, accepting new accounts, and maintenance mode can be changed there, each with a
reason and an audit entry in the same transaction. Everything else on the page is read-only: whether
integration settings are present (never their values), feature availability, plans and database readiness.
Live payments, production AI and integrations stay environment settings, which that page cannot reach.

Maintenance mode pauses new accounts, new stores and publishing, and shows a dashboard notice. Storefronts,
checkout, webhooks, signing in, unpublishing and existing work carry on. Settings are cached for 30 seconds
per server instance. If they cannot be read, the defaults apply, so a database problem cannot lock people out.

A save names the revision it was based on, and is refused if another came first, with a message saying another
administrator changed the settings. If settings cannot be read, the settings page says so and saving is refused, so defaults can never overwrite what is
stored. The support email and registration state reach pages through `GET /api/platform/status` and `SupportContact`,
which says to contact the platform administrator when no address is set. Shoppers on a store see the store's own
contact details, never the platform's.

## Super Admin plan assignment

`lib/admin/plan-assignment.ts`, `POST /api/admin/businesses/[id]/plan`. For complimentary or support changes,
with a required reason, audited in the same transaction as `business.plan_assign`.

- It records no payment and never marks anything paid.
- It does not change who may publish. `getPublishFacts` (`lib/publish-gates.ts`) answers that for the directory:
  someone with a publishing role, an active membership and account and a verified email, and menus that link only to
  this store's pages. Plan access and suspension are added in `lib/store-access.ts`.
- It refuses a subscription Razorpay is billing, or a checkout in progress: that state comes only from Razorpay.
- In production, a paid plan needs `ALLOW_MANUAL_BILLING`, like any other manual activation.
- Period end follows the plan's interval, and a free plan has none.
