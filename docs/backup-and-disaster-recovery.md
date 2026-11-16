# Backup and disaster recovery

Status: **design only.** Nothing here has been carried out. No backup has been
taken, no restore has been tested, and no key has been escrowed. Every step
that touches a real database, a real secret or the hosting platform needs
explicit approval first.

How statements are marked:

- **Verified (code):** read in this repository.
- **Verified (docs):** taken from MongoDB's official documentation, checked
  2026-11-16. Re-check before relying on it, because providers change plans.
- **Recommendation:** a proposal that needs a decision.
- **Not verified:** unknown. Nobody has looked at the real Atlas project or
  hosting settings.

Roles: **[Operator]** runs the procedure. **[Atlas admin]** holds Atlas project
rights. **[Hosting admin]** manages the deployment's environment variables.
**[Key custodian]** is one of two named people who can open the key escrow.

## 1. What has to be recoverable

| Asset | Where it lives | Recoverable from |
|---|---|---|
| All business data: 42 models (users, stores, products, pages, orders, payments, refunds, coupons, customers, audit logs, …) | One MongoDB database (`MONGODB_URI`) | Database backups only |
| Uploaded images and files | S3-compatible bucket (`S3_*`, `backend/lib/s3.ts`); `Media` records point at them by `storageKey` | The bucket's own versioning or copies. **Database backups do not contain them.** |
| `PAYMENT_CREDENTIALS_KEY` | Hosting environment only | **Nowhere unless escrowed** (section 3) |
| `SESSION_SECRET` | Hosting environment only | **Nowhere unless escrowed** (section 4) |
| Other credentials: database user, Resend, S3, Razorpay billing keys, Gemini | Hosting environment | Re-issued by each provider. No escrow needed, but write down who can re-issue them. |

**Verified (code):** the repository has no backup, export or restore tooling.
There's no script, no `package.json` command and no scheduled job for it. The
only mention is a one-off `mongodump` of `domainverifications` in
`docs/domain-lifecycle-migration.md`. `.gitignore` already keeps database
exports out of git (`/dump/`, `/backups/`, `*.bson`, `*.archive`).

**Not verified:**
- which Atlas tier production uses (a comment in `backend/lib/env.ts` mentions
  M0 as an example);
- whether any Atlas backup is enabled, its schedule and retention;
- who has Atlas access;
- whether the media bucket has versioning;
- whether `PAYMENT_CREDENTIALS_KEY` is set in production, and whether any
  encrypted payment record exists there. Online payments are off by default
  (`ORDER_ONLINE_PAYMENTS_ENABLED`), and their indexes are still a pending
  approved operation, so there may be none yet.

**[Atlas admin]** must record the real tier and backup settings in section 10
before this plan can be finalised.

## 2. MongoDB backups

### What each Atlas tier offers (Verified (docs))

| Tier | Managed backups | Point-in-time recovery | Fit for SiteForge production |
|---|---|---|---|
| Free (M0) | **None.** Only `mongodump`/`mongorestore` by hand | No | **No** |
| Flex | Daily snapshot, last **8** kept. Always on, no custom policy, no on-demand snapshot | No | Only as a stopgap: up to 24 hours of orders could be lost |
| Dedicated (M10+) | Cloud Backup with a configurable snapshot policy and on-demand snapshots | Yes, with the **Continuous Cloud Backup** add-on (oplog-based, "RPO as low as one minute" within the restore window) | **Yes** |

Also verified from the Atlas docs:
- Storage and snapshot volumes are encrypted at rest (AES-256, always on), and
  TLS is always required in transit.
- **Restoring a snapshot to a cluster deletes all existing data on that
  cluster first.** A restore must never target the production cluster unless
  that is the deliberate recovery decision (section 6).
- A Backup Compliance Policy can stop anyone, including an attacker with Atlas
  access, from deleting or changing snapshots. Turning it off needs MongoDB
  support and a cooldown.

### Recommended setup (Recommendation)

1. **Production on M10 or larger, with Continuous Cloud Backup** before launch.
   Orders, payments and stock are written continuously, and a daily snapshot
   can lose a day of them.
2. **Snapshot policy**, Atlas's suggested starting point:

   | Snapshot | Every | Kept |
   |---|---|---|
   | Hourly | 6 hours | 7 days |
   | Daily | day | 7 days |
   | Weekly | Saturday | 4 weeks |
   | Monthly | last day | 12 months |

   Point-in-time restore window: **7 days.**
3. **Offsite copy against losing the Atlas account itself** (deleted project,
   compromised admin, billing lapse): a weekly logical export (section 2.3) to
   storage in a **different provider account**, encrypted before upload. Keep
   5 weekly and 3 monthly copies. Backups contain customers' names, emails,
   phones and addresses, so keep them no longer than needed, and say in the
   privacy policy that deleted data can stay in backups until they expire.
4. **Access:**
   - MFA for every Atlas user.
   - Only named people hold the project roles that can restore, download or
     delete snapshots.
   - A separate read-only database user, used only for exports.
   - Consider the Backup Compliance Policy once the policy above is settled,
     because it is hard to undo.
5. **Keys are never stored with backups.** A backup plus
   `PAYMENT_CREDENTIALS_KEY` in the same place would expose every store's
   Razorpay secrets.
6. **Media bucket:** enable object versioning if the storage provider supports
   it (Not verified for the current provider), keeping old versions at least as
   long as the restore window. Otherwise copy the bucket on the same schedule as
   the offsite export. SiteForge only deletes a file after
   `countMediaReferences` finds no reference to it, but a restore to an earlier
   point can bring back references to files deleted since.

### Recovery objectives (Recommendation; to be confirmed by the first drill)

| | Target | Why |
|---|---|---|
| **RPO** (data that may be lost) | **≤ 1 hour**; minutes in practice with Continuous Cloud Backup | Each lost order is money and stock a store cannot account for. On Flex the honest RPO is 24 hours; on M0 it is the time since someone last ran `mongodump`. |
| **RTO** (time until the platform works again) | **≤ 4 hours** from the decision to restore | Restore to a new cluster, verify (section 7) and cut over. Atlas says restore time grows with data size. The first drill replaces this guess with a measured figure. |

### 2.3 Logical export commands (Verified (docs); not run in this project)

The MongoDB Database Tools are **not installed on this machine**, so these
commands have not been run against SiteForge. They follow the official
`mongodump`/`mongorestore` documentation.

**[Operator]** Keep the connection string and password off the command line
and out of shell history. Use a `--config` file (Database Tools 100.3.0 or
later), readable only by you and deleted after use:

```yaml
# export.yaml: permissions 600; never commit; delete after use
uri: mongodb+srv://<export-user>:<password>@<cluster-host>/<database>
```

```bash
mongodump --config=export.yaml --archive=siteforge-YYYYMMDD.archive.gz --gzip
sha256sum siteforge-YYYYMMDD.archive.gz > siteforge-YYYYMMDD.archive.gz.sha256
```

- **Consistency:** a dump of a database that is taking writes is not a single
  point in time. `--oplog` fixes that, but only for a full dump (no `--db`),
  and it needs oplog access, which shared tiers may not allow (Not verified).
  For a consistent copy, prefer exporting from a restored snapshot (section 6)
  rather than from the live cluster.
- Encrypt the archive with a key held separately from the payment and session
  secrets before it leaves the machine, then delete the unencrypted file.
- **Integrity:** keep the `.sha256` file with the archive and check it before
  any restore. `mongorestore --dryRun` reads the archive without writing (see
  section 7).

## 3. `PAYMENT_CREDENTIALS_KEY`

### What it does (Verified (code), `backend/lib/payments/credentials-crypto.ts`)

- **Format:** 32 random bytes, base64-encoded. It is used directly as an
  AES-256-GCM key with a random 96-bit IV per value. It is not derived from
  `SESSION_SECRET`.
- **What it encrypts:** two fields of `BusinessPaymentAccount`, `keySecretEnc`
  (each store's Razorpay key secret) and `webhookSecretEnc` (its Razorpay
  webhook secret). Each is stored as `{ v, iv, tag, ct }`. Nothing else in
  SiteForge is encrypted with it. SiteForge's own billing keys stay in the
  environment.
- **Who needs it to decrypt:** every use of a store's Razorpay account:
  - creating payment links, and verifying webhook signatures
    (`order-payments.ts`);
  - refunds and refund re-reads (`order-refunds.ts`);
  - dispute re-reads (`disputes.ts`).
  Storing a new connection encrypts with it (`app/api/businesses/[id]/payment-account`).
- **Rotation is not supported today.** Values carry a version (`v`), but only
  version 1 is accepted; anything else is refused (`PaymentCredentialsKeyError`).
  Rotating would need code that holds two keys and re-encrypts, which doesn't
  exist. Until then the key must never change while encrypted records exist.

### What goes wrong (Verified (code); tried with throwaway keys only)

| Situation | Result |
|---|---|
| **Key missing** | `isPaymentCredentialsKeyConfigured()` is false: online payment is not offered, refunds through Razorpay are unavailable, new connections answer `503 payment_encryption_unconfigured`. Stored values stay intact and work again once the right key is back. |
| **A different key** (any valid 32 bytes) | See the next table. It still counts as configured, so the key check is what catches it. |
| **Key lost for good** | The stored secrets can never be decrypted (that is the point of GCM). They are not lost in the world, though: each owner can create new keys and a webhook secret in their Razorpay dashboard and reconnect. Stores recover one by one; until each one does, it has no online payments, no Razorpay refunds and no dispute updates. With the check record in place, reconnecting under a new key is refused (`mismatch`), so a lost key needs its own approved recovery procedure, which does not exist yet. |

**A different key, before and after the payment key check.** The "before"
column describes what the code did before the check was added, and corrects an
earlier version of this table that called it "HTTP 500 everywhere".

| Operation | Before the check | With the check (`mismatch`, `check_unreadable` or `unknown`) |
|---|---|---|
| Payment webhook | The decryption failure was caught and answered as `401 invalid_signature`, so a key problem looked like a forged request | `503 temporarily_unavailable` with `Retry-After`, the same for every request and every business, before any account is looked up |
| Return from Razorpay's page | Quietly showed "pending" | Still "pending", now without attempting to decrypt |
| Creating a payment link; dispute re-reads | Could fail with an unhandled error (HTTP 500) | Online payment is not offered at checkout; dispute re-reads answer 503 before decrypting |
| Refund | The amount was **held on the order before decryption**, so the hold could be left stuck, needing the owner's stuck-refund recovery | Refused with `503 payment_key_unavailable` **before** any hold, refund record or request |
| Reconnecting a store | **Re-encrypted that store's secrets under the wrong key**; restoring the right key then broke that store | Refused with 503; the stored account is not touched |

The check needs its record. On an installation that already stored secrets
before the check existed (`unverified_legacy`), payments keep working as before
and reconnection is refused until an operator adopts the key. **Production is
not protected until the record exists:** check Super Admin → Settings or
`npm run payment-key-check -- status`. Details:
`docs/payments-architecture.md`, "Payment key check".

### Escrow (Recommendation; [Key custodian] and [Hosting admin], needs approval)

The hosting platform's copy is not a backup. Some platforms will not show a
secret's value again once saved, and a deleted project takes its variables with
it.

1. **Two independent escrow copies**, neither in the hosting platform or the
   Atlas account:
   - **a.** a secret manager or an organisation password-manager vault, with
     access limited to the two named custodians and access logging on;
   - **b.** an offline copy: the key written into an encrypted file (or on paper)
     kept in a physically secured place, under a different custodian's control.
2. **One direction only.** The production variable is always set *from* escrow,
   never generated in place and never edited by hand. A new key is generated
   once, escrowed, fingerprinted and only then deployed.
3. **Fingerprint, not value.** Record this fingerprint next to both escrow
   copies and in the deployment notes. It's safe to share: a 64-bit slice of a
   domain-separated SHA-256 of a random 256-bit key reveals nothing usable.
   Check it whenever someone sets or restores the key. (Verified with a fake
   key: it parses exactly as the app does, including surrounding spaces, and
   refuses a value that isn't 32 bytes.)

   ```bash
   # Run where the key is already in the environment, e.g. after
   #   read -rs PAYMENT_CREDENTIALS_KEY && export PAYMENT_CREDENTIALS_KEY
   # Prints only the fingerprint, never the key.
   node -e 'const k=Buffer.from((process.env.PAYMENT_CREDENTIALS_KEY||"").trim(),"base64");if(k.length!==32){console.log("not a valid key (expected 32 bytes, base64)");process.exit(1)}console.log("fingerprint: "+require("crypto").createHash("sha256").update("siteforge-payment-key-check:").update(k).digest("hex").slice(0,16))'
   unset PAYMENT_CREDENTIALS_KEY
   ```
4. **Test recovery once a year and at every custodian change.** Each custodian
   opens their copy and checks the fingerprint. Nobody else sees the key.
5. **The fingerprint is also what adoption needs.** The payment key check stores
   the same fingerprint in its database record. Super Admin → Settings shows the
   configured and expected fingerprints side by side, and
   `npm run payment-key-check -- adopt --expected-fingerprint <fingerprint>`
   takes the escrow copy's fingerprint as independent confirmation.
6. **If the key is suspected leaked:** see the rotation note above. Today the
   only safe response is new Razorpay credentials from every connected store
   (owners re-issue them in Razorpay), then a new key and reconnection. That is
   a planned, approved operation, not an emergency improvisation.

## 4. `SESSION_SECRET` is a recovery secret too

**Verified (code):** besides signing sessions, `SESSION_SECRET` keys hashes that
are **stored in the database**:

- `CouponRedemption.phoneKey` / `addressKey` (per-customer coupon limits,
  `coupons.ts`);
- `Order.guestCodKeys` (open guest cash-on-delivery orders per phone and email,
  `orders/guest-cod.ts`);
- `SecurityEvent.emailDigest` / `sourceDigest` (`security-events.ts`).

It is also the root of login-code HMACs, customer
sessions and rate-limit keys.

Restoring a database under a **different** `SESSION_SECRET` keeps every record
readable, but:
- coupon and guest-COD limits stop recognising earlier orders, so limits
  effectively reset;
- security events no longer link to new ones;
- every session becomes invalid. Every platform account
  then needs an emailed code to sign in again, so email must work during
  recovery.

**Recommendation:** escrow `SESSION_SECRET` exactly like
`PAYMENT_CREDENTIALS_KEY` (same two copies, same fingerprint idea). A
production recovery restores **both** original values.

## 5. Choosing a recovery point

**[Operator]** Decide what happened before choosing:

| Situation | Recovery |
|---|---|
| Cluster lost, corrupted or unreachable for good | Restore the latest good point to a **new** cluster and cut over (section 6). |
| Some records deleted or damaged by a bug or a person; the cluster is otherwise fine | Do **not** roll the whole platform back. Restore to a recovery cluster, then copy back only the affected records as a reviewed, approved operation. Everything else written since stays. |
| Atlas account lost | Restore the newest offsite export (section 2.3) into a new cluster or account. |

Pick the latest point **before** the damage: the time of the bad deploy, the
admin action or the first error in the logs. Write the chosen point (UTC) and
the reason in the incident record.

## 6. Disaster recovery runbook

Each step says who does it. Stop at any failed check and escalate; don't skip
ahead.

1. **Identify the failure.** [Operator]
   - Signals:
     - `database_not_prepared` or connection errors in the server logs;
     - `[api] unhandled error` spikes;
     - the `/login` health check failing (`docs/email-delivery.md`);
     - owners reporting missing data;
     - Atlas alerts.
   - Confirm with Atlas (cluster status) before acting. Open an incident
     record: time, symptoms, who is involved.
   - **Freeze risky changes:** no deploys, no index operations, no admin bulk
     actions, no store reconnections to Razorpay.
2. **Select the recovery point** (section 5). [Operator + Atlas admin]
3. **Restore into an isolated recovery cluster.** [Atlas admin]
   - Create a new cluster, e.g. `siteforge-recovery-YYYYMMDD`, in the same
     project and region, at the same tier or larger. Restore the chosen
     snapshot or point in time **to that cluster.** Atlas wipes the target, so
     check the target name twice. Never target the production cluster at this
     stage.
   - For an offsite export, use `mongorestore` into the new cluster under a
     separate database name (section 7).
   - Create a new database user for the recovery cluster. Never reuse the
     production password.
4. **Verify collections and indexes.** [Operator]
   - Run the read-only inventory (section 7, step 4) and compare its output with
     the last known-good inventory. Every collection must be present with
     plausible counts.
   - All core unique indexes (`backend/lib/core-indexes.ts`, listed in
     `docs/database-preparation.md`) must exist. Atlas snapshots and
     `mongorestore` restore indexes with the data.
5. **Verify the keys.** [Key custodian]
   - Take `PAYMENT_CREDENTIALS_KEY` and `SESSION_SECRET` from escrow and check
     both fingerprints against the recorded ones. A restored database brings its
     payment key check record with it: once the application runs against it with
     the escrowed key, Super Admin → Settings must show "Verified". "Wrong key"
     means this is not the key the restored data was written with.
   - If the payment key cannot be recovered, follow "Key lost for good" in
     section 3. The database restore itself still goes ahead.
6. **Check decryption without exposing secrets.** [Operator + Key custodian]
   - Follow section 7, step 6: decrypt only the canary store's record in
     memory, comparing fingerprints. Never print, log or copy a decrypted
     value.
7. **Run the application against the recovery cluster.** [Hosting admin]
   - Use a separate, access-restricted deployment of the same release, with the
     settings in section 7, step 5.
   - Check:
     - `/login` answers `200`;
     - the server log has no `database_not_prepared`;
     - Super Admin → Settings shows no missing indexes for the features in use.
8. **Confirm sign-in and tenant isolation.** [Operator]
   - Run section 7, step 7 with the canary accounts.
9. **Cut over.** [Hosting admin + Operator; needs the incident lead's go-ahead]
   - Point the production `MONGODB_URI` at the recovery cluster, using the
     original `SESSION_SECRET` and `PAYMENT_CREDENTIALS_KEY`, and redeploy. The
     `/login` health check must pass before traffic moves.
   - Then reconcile everything written after the recovery point, which the
     restore cannot contain:
     - **payments:** check Razorpay's dashboard for payments in the gap;
       payment-link orders are confirmed only by re-reading Razorpay;
     - **SaaS subscriptions:** Super Admin → Billing → ask Razorpay again;
     - **orders and stock:** reconcile orders placed in the gap with the
       affected stores;
     - **security actions:** re-apply known password resets, forced sign-outs,
       deactivations and role changes. They are lost too, along with their
       audit entries.
   - Tell affected store owners what time window was lost.
10. **Rollback.** [Hosting admin]
    - Keep the old production cluster **untouched**: not deleted, not
      restored into. Its data is the only record of anything after the
      recovery point.
    - If the cut-over deployment fails its checks, redeploy with the previous
      `MONGODB_URI`.
    - Once real traffic has written to the recovery cluster, going back would
      lose those writes too. Decide quickly (within the first hour), then stop
      considering it.
    - Delete the old cluster only after an approved review, typically 30 days
      later.

## 7. Isolated restore drill (staging; quarterly and before launch)

The drill proves that backups can be restored, measures RTO, and checks the
keys and decryption. It **never writes to production and never connects to the
production cluster**. Use a Flex or M10 recovery cluster created only for the
drill.

**Before the first drill (one-time setup, needs approval):**
- [Operator] Create in production a **canary store** owned by a canary owner
  account whose mailbox the operator controls. Give it a known number of
  products, pages and one test order, and a canary staff account. It holds no
  real customer data. Write its expected counts in the drill record.
- [Operator] Once online payments are enabled in production, connect the canary
  store to a Razorpay **test-mode** account. Record the fingerprint of the test
  key secret as you enter it: the same command as section 3, with the secret in
  a temporary variable. Until then there are no encrypted records to test, and
  step 6 checks only the key fingerprint.

**Steps** (record each start and end time):

1. **Restore.** [Atlas admin]
   - Restore the latest snapshot (or a chosen point) into
     `siteforge-drill-YYYYMMDD`, a new cluster.
   - For an offsite export, check its `.sha256` first, then run:

     ```bash
     # restore.yaml points at the DRILL cluster, never production
     mongorestore --config=restore.yaml --archive=siteforge-YYYYMMDD.archive.gz --gzip \
       --nsFrom="<database>.*" --nsTo="siteforge_drill_YYYYMMDD.*" --dryRun
     # then the same command without --dryRun. Never use --drop.
     ```

     Use double quotes around the namespaces; single quotes have restored into
     the wrong database on Windows.
2. **Isolate.** [Atlas admin]
   - Give the drill cluster its own database user and network access list.
   - Never copy production connection strings or passwords into the drill
     notes or logs.
3. **Time to data.** Record how long the restore took.
4. **Inventory without reading records.** [Operator] Run this in `mongosh`
   (Not verified: `mongosh` isn't installed here). It prints only collection
   names, counts and index definitions, never a document:

   ```js
   // inventory.js. Read-only.
   const report = db.getCollectionInfos({ type: "collection" })
     .map((c) => c.name).sort()
     .map((name) => {
       const coll = db.getCollection(name);
       return {
         name,
         count: coll.countDocuments({}),
         indexes: coll.getIndexes().map((i) => ({ key: i.key, unique: i.unique === true, partial: i.partialFilterExpression ?? null })),
       };
     });
   printjson(report);
   ```

   ```bash
   mongosh "mongodb+srv://<drill-cluster-host>/<database>" --username <drill-user> --quiet --file inventory.js
   # prompts for the password; it never appears in the command
   ```

   Compare with the previous drill's inventory:
   - every collection is present;
   - the canary store's counts match exactly;
   - totals are close to the Super Admin overview at the recovery point;
   - every core unique index listed in `docs/database-preparation.md` exists,
     with the same `partial` filter.
5. **Application connectivity.** [Hosting admin] Deploy the same release to a
   separate, access-restricted environment with:
   - `MONGODB_URI` pointing at the drill cluster;
   - a **drill-only** `SESSION_SECRET`, so no production cookie is valid there;
   - **no** `PAYMENT_CREDENTIALS_KEY`, so the app never decrypts anything (step
     6 does that separately);
   - `ORDER_ONLINE_PAYMENTS_ENABLED`, live billing and AI off;
   - no webhooks or cron pointed at it;
   - the staging email settings.

   Then check:
   - `/login` answers `200`;
   - no `database_not_prepared` in the log;
   - Super Admin → Settings lists no missing indexes for the features in use.

   Testers use **only** canary accounts, so no real customer or owner is ever
   emailed. This environment holds real customer data: restrict access to the
   drill team.
6. **Keys and decryption.** [Key custodian]
   - Check both escrow fingerprints (section 3).
   - When a canary payment record exists: decrypt the canary store's
     `keySecretEnc` with the escrowed key **in memory**, print only its
     fingerprint, and compare it with the one recorded at connect time.
   - This needs a small read-only script that loads only that one record and
     prints only the fingerprint. **It doesn't exist yet**; writing it needs
     review and approval.
   - Never decrypt any other store's record.
7. **Sign-in and tenant isolation.** [Operator]
   - The canary owner signs in from a new browser: the emailed code arrives
     and is accepted.
   - The canary owner sees only the canary store. Opening another store's
     dashboard address is refused.
   - Canary staff can't open settings, billing or members.
   - A Super Admin signs in and sees the platform views.
   - The canary storefront (on the drill host) shows only published content.
8. **Record the results** (template below) and **tear down.** [Atlas admin]
   - Delete the drill cluster, the drill environment and any local exports the
     same day.
   - Write down that they were deleted.

### Drill record

| Field | Value |
|---|---|
| Date, people involved | |
| Source (snapshot id / point in time / offsite export + checksum) | |
| Restore started / data available / app healthy (UTC) | |
| **Measured RTO** (restore start to app healthy) | |
| Recovery point used, and implied **RPO** | |
| Collections and counts match (yes/no, differences) | |
| Core and feature indexes present (yes/no, missing) | |
| Payment key fingerprint matches; session secret fingerprint matches | |
| Canary decryption fingerprint matches (or "no encrypted records yet") | |
| Sign-in and tenant checks passed | |
| Problems found, follow-up actions | |
| Drill resources deleted (time) | |

## 8. Proposed follow-ups (not implemented; each needs approval)

- ~~Key fingerprint check at startup~~ **Done differently:** the payment key
  check (`docs/payments-architecture.md`) catches a wrong key from a record kept
  with the data, at the first payment operation, without stopping the rest of
  the platform. It still needs adoption on an installation with stored secrets.
- **Key rotation:** accept two key versions and add a reviewed re-encryption
  operation.
- **Read-only drill tools:** the inventory and canary-decryption checks in
  section 7 as reviewed scripts.
- **Bind ciphertext to its store** (AES-GCM associated data), so an encrypted
  value copied between stores won't decrypt. Today it would.

## 9. Before launch (blockers)

- [Atlas admin] Production on a tier with managed backups (M10+ with Continuous
  Cloud Backup recommended); the snapshot policy and restore window set; MFA
  and least-privilege access confirmed.
- [Key custodian] `PAYMENT_CREDENTIALS_KEY` and `SESSION_SECRET` escrowed in two
  places, with fingerprints recorded.
- [Operator] Payment key check shows **Verified** in production: either the
  first connection bootstrapped it, or the key was adopted with the escrow
  fingerprint (staging first).
- [Operator] Canary store set up; one complete drill (section 7) passed, with
  the measured RTO and RPO recorded.
- [Operator] Offsite export scheduled, encrypted, with a retention decision.
- [Hosting admin] Media bucket versioning or copies in place.

## 10. Actual configuration (to be filled in by the Atlas admin)

| Item | Value | Checked by / date |
|---|---|---|
| Atlas tier | | |
| Cloud Backup enabled; policy | | |
| Continuous Cloud Backup; restore window | | |
| Backup Compliance Policy | | |
| People with restore / download / delete rights | | |
| Offsite export location and retention | | |
| Media bucket versioning | | |
| Key escrow locations (not the values) and custodians | | |
| Payment key check state (Super Admin → Settings) and how it was reached (bootstrap / adoption, date) | | |
| Last drill date and measured RTO | | |
