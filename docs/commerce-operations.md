# Commerce operations: variants, inventory, categories, coupons, reviews, shipping, SEO

How the store's catalogue, stock, discounts, reviews and delivery work, the
guarantees each one gives, and the database operations they need.

## Product variants

- `Product.options` (max 3, e.g. Size / Color / Material / Storage) and
  `Product.variants[]`: one per offered combination, each with its own SKU,
  optional price and original price, and stock. A product without options is
  a simple product and behaves exactly as before.
- Variants are **archived, never deleted** (orders and stock history point to
  them). Edits use targeted `$set`s that never touch stock; new variants are
  `$push`ed with their initial stock (`backend/lib/product-variant-service.ts`).
- `Product.stock` of a variant product is the **sum** of its variants' stock,
  changed in the same atomic update as the variant (`backend/lib/inventory.ts`).
- A simple product can get variants only while no unpaid order holds its
  stock (`pending_orders`); a variant product cannot drop its options.
- Cart lines and order items record the exact variant (`variant`,
  `variantLabel`, `sku`, unit price at purchase). The cart and checkout
  re-check that the variant exists, is not archived, belongs to the product
  and has stock (`variant_required`, `variant_unavailable`, `out_of_stock`).
- Shoppers choose options on the product page (`VariantPicker`); product
  cards link to it ("Choose options") and show the price range.

## Starter sample products

A new store created with the quick start (or an owner pressing "Start with sample products") gets up to
three products from the theme preview catalogue, chosen by business type (`sampleCatalogFor`; none for
services, real estate and education), within the plan's product limit (`backend/lib/sample-products.ts`).

- Each is a **draft** marked `sample` (the name of its bundled photo in `public/samples`), with stock 0,
  no description, no sale price and no rating. Drafts never reach a shopper.
- The product route refuses to make a sample active (`422 sample_product`). Changing its name, price or
  photo makes it the owner's own and clears the mark. Clients cannot set or clear it.
- The bundled photo is shown only in the dashboard and is never stored as `imageUrl`, which must be this
  store's own media. A copy of a sample is still a sample.
- "Remove samples" archives the samples still unchanged (soft, like every product delete). The setup
  checklist lists "Replace the sample products" while any remain. `sample` has no index.

## Inventory

All stock changes go through `backend/lib/inventory.ts` and record an
`InventoryMovement` in the **same transaction**:

| Change | Function | Reason |
| --- | --- | --- |
| Checkout reservation (COD, online, arrange-with-store) | `reserveStock` | `order_reserved` |
| Cancellation / expiry of an unpaid order | `restoreStock` | `order_released` |
| Owner/staff adjustment | `adjustStock` | `restock`, `damage`, `correction`, `adjustment` |
| Full refund with items returned | `backend/lib/payments/order-refunds.ts` | `order_refunded` |
| New product / new variant | product routes, variant service | `initial` |
| Simple product converted to variants | variant service | `variants_created` |

- Reservation is a conditional decrement (`stock >= qty`, variant not
  archived): concurrent checkouts can never oversell. A paid order consumes
  its reservation; a refund does not restock (unchanged). Cancellation or
  expiry restores stock exactly once (single-winner state transition).
- Adjustments are either a signed delta (never below zero) or an absolute
  "counted" value with the value the user saw (compare-and-set: a checkout
  meanwhile gives `409 stock_changed`).
- Low stock: `Product.lowStockThreshold` (default 5). Shoppers only see
  "Only a few left" / "Sold out"; exact counts are never in the public view,
  and the add-to-cart quantity is capped at 20 without revealing stock.
- Dashboard: **Inventory** (owners, managers, staff): stock per product and
  variant, Low/Out filters, adjustments, history per product.

## Categories

- `ProductCategory` (business-scoped; `backend/models/Category.ts` remains the
  platform's business types). Name, URL slug, description, image, order,
  active flag. Products are linked by the existing `Product.category` text
  (case-insensitive): **no data migration**. Existing category texts become
  managed only through the explicit "Manage them here" action.
- Renaming a category renames it on this business's products in the same
  transaction. Categories are hidden, never deleted.
- Store: active categories with products appear in managed order in the
  homepage, header and drawer, link to `/category/<slug>` (image,
  description, products, canonical metadata, sitemap). Hidden categories
  disappear; their products stay in the catalogue. Stores without managed
  categories keep the previous derived behaviour.

## Coupons

- `Coupon`: percent (1-100) or fixed amount (business currency), minimum
  order, largest discount, start/end, total and per-customer limits, active
  flag. A code can apply to the whole order, chosen products (this business's
  own, checked on save) or chosen categories, and then discounts only those lines.
  Codes are unique per business (writes serialised per business), deactivated
  not deleted. Owners and managers only.
- Checkout (`app/api/businesses/[id]/orders`) validates the code inside the
  order transaction (`checkCoupon`), computes the totals on the server, and
  claims a use with one conditional `$inc` only once the request owns the new
  order (`claimCouponUse`). Every redemption writes the coupon document, so
  concurrent uses of a coupon are serialised: total and per-customer limits
  hold under concurrency. One coupon per order (no stacking).
- Per-customer identity: the storefront account, else a SHA-256 of the
  normalised e-mail (no e-mail stored on the redemption). Every new redemption
  also stores the e-mail's hash, so an account holder cannot reuse a code as a
  guest with the same address. Normalising drops `+tags`, and dots at Gmail.
- Cancellation/expiry of the unpaid order releases the redemption and gives
  the use back exactly once. A paid order keeps its use.
- The cart quote (`POST /api/businesses/[id]/cart/quote`) previews the same
  numbers without consuming a use; code checks are rate-limited.

## Shipping and fulfilment

- `Business.shippingSettings`: standard rate, free shipping from an amount
  (checked after the discount), address step, delivery information, minimum
  order and largest cash-on-delivery order. Absent = no charge and no address
  step (unchanged).
- Delivery areas (`zones`): countries, regions and postal prefixes (empty = any),
  each with its own rate, free-from amount, delivery information and whether cash
  on delivery is offered. The first match wins. Outside every area the standard
  rate applies, or the store refuses the address (`shipElsewhere: false`).
- `Business.taxSettings`: one store-wide rate, its label, whether prices already
  include it, and whether shipping is taxed. SiteForge calculates and shows tax; it
  does not file or remit it. Per-product and per-region rates are not supported.
- `total = subtotal - discount + shipping + tax` (tax on top) or without the tax
  (tax inside the prices), computed only by `priceOrder` in `backend/lib/checkout-pricing.ts`.
  The cart preview and checkout both call it; online payment uses `order.total`.
  The order keeps its tax, label and area as they were when placed.
- The delivery address is validated server-side, stored on the order, shown
  to owners/managers, and never returned by the guest order-status API.
- Fulfilment (`fulfillmentStatus`: unfulfilled -> processing -> shipped ->
  delivered, forward only) for paid orders and open COD orders, with the
  business's own carrier, tracking number and https tracking link. **No
  carrier integration**: SiteForge does not fetch tracking data.
- Shoppers see progress and tracking on their order page. A shopper can no
  longer cancel once an order is shipped; the business still can.

## Reviews

- `ProductReview`: only from a **paid** order of the same business that
  contains the product, proven with the order proof (like the order page).
  One review per order and product, 1-5 stars, plain text, at most 2 links,
  rate-limited. Published name is "First L.", never the e-mail.
- Every review starts `pending`; only an owner/manager approval publishes it.
  `Product.ratingAverage/ratingCount` count approved reviews only and are
  recomputed in the moderation transaction.
- Stars, review lists and `aggregateRating` structured data appear only when
  approved reviews exist. Nothing is ever shown otherwise.

## SEO

- Product pages: canonical, Open Graph with the product image, `Product`
  JSON-LD (`Offer`, or `AggregateOffer` for variants; availability from the
  derived state; `aggregateRating` only with approved reviews) and
  breadcrumbs. Homepage: `Organization` and `WebSite` (with the real
  `/products?q=` search). JSON-LD is escaped (`<`, U+2028/9) before it is
  placed in the page.
- Category pages: canonical, description, image. Catalogue: canonical
  `/products`; search, filter and sort views are `noindex, follow`.
- Sitemap adds active categories with products and `/policies` when it
  exists. robots.txt is unchanged (cart, order, account, API disallowed).

## Guest cash on delivery

Off by default, and owner-only: `Business.guestCodEnabled`, on top of `codEnabled`. It does not need customer accounts.
A guest gives a name, email, phone and address, all required whatever the shipping settings say. Everything else
matches any other order: prices, coupons, delivery areas, the minimum order and the cash-on-delivery limit come only from
the server, and the idempotency key and cart consumption stop duplicates. Nobody verified behind the order changes two things:

- **At most 2 open per phone number or email, per store**, counted through keyed digests on the order
  (`guestCodKeys`, `select: false`), inside the order's transaction.
- **Stock is held for 7 days**, not indefinitely, unless the store starts preparing the order, which clears the timer.

## Carts

- A guest's cart is found by the httpOnly `cart-token` cookie, now kept for 30 days and renewed on use. Every query filters
  by the Host-resolved store. `backend/lib/cart/shopper-cart.ts` is the only place that decides whose cart a request means.
- With the index in `docs/database-preparation.md`, a signed-in customer has one cart per store. A guest cart becomes theirs,
  or merges into their existing one, on their first request after signing in. A product and variant appear once, quantities
  are limited to what is in stock, unavailable lines are dropped and prices become current, in one transaction. A cart tied to
  an account is unreachable without that account's session.
- A cart holds no stock. Untouched for 24 hours it counts as abandoned, and coming back brings it up to date
  (`revalidateCartItems`) and says what changed. Untouched for 30 days it is deleted.
- Owners and managers see abandoned carts on their own page. There is no contact detail in a cart and nothing is sent to
  shoppers: reminders would need a consent workflow, which does not exist.

## Database operations (approved operation, not automatic)

New collections and fields need no migration. The new models have
`autoIndex` off; create these indexes once, as an approved operation, before
production traffic:

| Collection | Index |
| --- | --- |
| `inventorymovements` | `{ business: 1, product: 1, createdAt: -1 }`, `{ business: 1, createdAt: -1 }` |
| `coupons` | `{ business: 1, code: 1 }` **unique** |
| `couponredemptions` | `{ coupon: 1, customerKey: 1, status: 1 }`, `{ order: 1 }`, `{ coupon: 1, emailKey: 1, status: 1 }` |
| `orderrefunds` | `{ business: 1, order: 1, createdAt: -1 }`, `{ providerRefundId: 1 }` **unique, partial** (strings only) |
| `productcategories` | `{ business: 1, slug: 1 }` **unique**, `{ business: 1, sort: 1 }` |
| `productreviews` | `{ business: 1, product: 1, status: 1, createdAt: -1 }`, `{ business: 1, status: 1, createdAt: -1 }`, `{ order: 1, product: 1 }` **unique** |

For coupons, categories and reviews, correctness does not depend on the unique
indexes (writes are serialised in transactions), but they are the backstop and
keep lookups fast. The `orderrefunds` one is different: Razorpay refunds stay off
until it exists (`order_refunds`, `backend/lib/required-indexes.ts`; see
`docs/database-preparation.md`). Manual refunds do not need it.

## Known limitations

- No carrier integration, weight-based shipping or per-product tax rates.
- One coupon per order; no automatic discounts or free-shipping coupons.
- No review replies, photos or helpfulness votes.
- Variant images are not separate from product images.
- Refunds restock only when asked, and only with a refund of the full remaining
  amount. A partial return needs a stock adjustment in Inventory.

## Products

Owners, managers and staff can create, edit and duplicate products; owners and
managers archive them. A copy (`products/[productId]/duplicate`) is a draft with no
stock and no SKUs, and needs room in the plan's limit. Archived products are listed
separately and restored as drafts, again within the limit. Each product has a main
image and up to 10 gallery photos. Variant-specific images are not supported.

## Orders (owner dashboard)

Search covers order number, customer, product, SKU and tracking number, always
literal and scoped to the business. Filters cover order status, payment (awaiting,
failed or expired, paid, refunded, cash on delivery, online) and delivery status. The
CSV export (`manage/orders/export`) uses the same filters, is capped at 5,000 orders,
never includes team notes, and neutralises cells that a spreadsheet would run as
formulas. Each order opens to its payment attempts, refunds and a private team note.

Order emails (`backend/lib/orders/notifications.ts`): the shopper hears when an order is
placed, paid, shipped, delivered, cancelled or refunded, and the store when an order
is placed or paid online. They are sent after the response and best-effort, so a mail
failure never changes an order. Not sent when reservations expire on their own.

Insights and the customer list count what a paid order kept: partial refunds come off
its total. Insights lists them under refunds in the period the order was paid, because
a partly refunded order has no single refund date on it (`OrderRefund` has each one).
Super Admin payment reports stay gross by design.

