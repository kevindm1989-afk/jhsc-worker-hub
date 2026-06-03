# Release 1 — Backup & Restore Runbook

Milestone 1.12 S4. Implements ADR-0011 §3.6.

The rep runs this drill every 30 days. A successful cold restore from
the latest snapshot completes in under one hour. The runbook is also
the drill record — the §"Drill log" table at the bottom carries the
30-day-cadence outcomes.

**RTO:** 4 hours (from incident-declared to rep using the restored
app). **RPO:** 24 hours (worst-case data loss is the last 24h of
writes; Neon's point-in-time recovery covers anything within the
configured window).

Cross-references:

- ADR-0011 §3.6 — runbook shape and verification semantics.
- `SECURITY.md` §3 (encryption posture), §7 (incident response).
- `docs/release-1-security-pre-launch-checklist.md` §11 — backup
  posture rows the checklist verifies.
- `docs/release-1-deploy-runbook.md` §"Infrastructure provisioning"
  — the provisioning steps the restore procedure mirrors.
- `apps/api/scripts/audit-log-verify.ts` — the chain verifier the
  restore validates against.

---

## 1. Backup inventory

The Release 1 stack has four backup-critical surfaces. Each has its
own backup mechanism, its own restore procedure, and its own
verification step. They MUST be restored together — restoring Postgres
without the matching KEK leaves every encrypted column opaque.

### 1.1 Postgres (Neon)

- **Primary mechanism:** Neon point-in-time recovery (PITR). Neon
  retains a write-ahead log; any moment in the retention window can
  be restored as a new branch.
- **Secondary mechanism:** Neon daily snapshot. Snapshots are
  managed by Neon; the rep does not run them manually.
- **Retention window:** ≥ 30 days. The Neon free tier is 7 days; the
  paid tier (required for Release 1) is 30 days. Pre-launch
  checklist §11.4 verifies the window.
- **What's protected:** every row in every table —
  `users`, `auth_*`, `audit_log`, `hazards`, `action_items`,
  `inspections`, `inspection_findings`, `recommendations`,
  `evidence_files`, `excel_imports`, `excel_import_items`,
  `workplace_keys`, `sync_idempotency`, plus migration history.
- **What's NOT protected by Neon alone:** the application-layer
  encryption keys (KEK, workplace keys, signing keys). Without
  those, Neon's restored ciphertext is opaque. See §1.3.

### 1.2 Tigris (S3-compatible object storage)

- **Primary mechanism:** Tigris bucket versioning. Every object
  write creates a version; deletes are soft (a delete marker is
  written; prior versions remain restorable). Versioning is
  configured at bucket-provision time per
  `docs/release-1-deploy-runbook.md` §"Tigris bucket provisioning".
- **Secondary mechanism:** weekly cold-storage copy to a separate
  Tigris bucket (`evidence-cold` / `exports-cold`) via
  `rclone sync` from a Fly Machine. The cold copy lives in a
  different bucket name (or, budget permitting, a different
  Tigris account) so a single-bucket compromise does not destroy
  both copies.
- **MFA-delete:** enabled at provision time. A delete operation
  against a versioned bucket with MFA-delete requires a TOTP at the
  Tigris control plane. This is the Tigris equivalent of AWS S3's
  MFA-delete; consult the Tigris documentation for the current
  enablement command.
- **What's protected:** every uploaded evidence file (the
  client-side-encrypted ciphertext per ADR-0006), every exported PDF
  (the step-up-gated export blobs per ADR-0007 + ADR-0008).
- **What's NOT protected:** the per-file DEKs (which live in
  Postgres as `evidence_files.dek_ct` — sealed under the workplace
  public key — and are restored via §1.1).

### 1.3 Fly Secrets (KEK + signing keys + VAPID + Tigris credentials)

- **Primary mechanism:** Fly Secrets is the runtime carrier — when
  `fly deploy` runs, the secrets are injected as env vars into the
  Fly Machine. They are NEVER stored in source, NEVER logged.
- **Backup mechanism:** out-of-band cold storage. The secrets are
  written (manually, by the rep) to a printed sealed envelope OR an
  encrypted USB key in a physical safe. There is NO automated
  online backup — an online backup would create a
  single-point-of-compromise surface that defeats the purpose.
- **Cold-storage envelope contents (a row per secret):**
  - `MASTER_KEY` (32 raw bytes, base64-encoded).
  - `AUTH_JWT_ED25519_PRIVATE_KEY_B64` + `_PUBLIC_KEY_B64` (and any
    `_K1`/`_K2`/`_K3`/`_K4` rotation kids).
  - `AUTH_JWT_ACTIVE_KID` (string).
  - `TIGRIS_ACCESS_KEY_ID` + `TIGRIS_SECRET_ACCESS_KEY` +
    `TIGRIS_BUCKET` + `TIGRIS_ENDPOINT` + `TIGRIS_REGION`.
  - `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT` (if
    Web Push lands; deferred in Release 1 per `.env.example`
    comments — record as "N/A — deferred" if not provisioned).
  - `AI_PROXY_SHARED_SECRET` + `ANTHROPIC_API_KEY` (the AI proxy is
    provisioned but idles; record the secret if it exists, else
    "N/A — Release 3" per ARCHITECTURE.md).
  - `WORKPLACE_DISPLAY_NAME`, `WORKPLACE_JURISDICTION`,
    `ZONE_N_NAME` × 10. These are non-secret but mandatory for the
    app to render correctly; treat them as backup-critical config.
- **Cold-storage refresh trigger:** at every deploy (a fresh
  `fly deploy` against new secret values) AND at every key rotation
  (workplace key rotation, signing key rotation, KEK rotation — all
  on the post-Release-1 backlog per ADR-0011 §"Out of scope"; until
  then a rotation is itself a deploy).
- **Critical note:** loss of `MASTER_KEY` is catastrophic. Every
  encrypted column in Postgres becomes opaque. The chain still
  verifies cryptographically (the hash chain is keyed by SHA-256,
  not by KEK), but the payload contents are unrecoverable. The
  cold-storage envelope is the structural mitigation.

### 1.4 Audit chain (cryptographic evidentiary surface)

- **Carrier:** the `audit_log` table in Postgres. Restored via §1.1.
- **Why it warrants separate criticality:** per CLAUDE.md
  non-negotiable #2, the chain is the evidentiary backbone. A
  corrupted chain breaks the worker rep's ability to demonstrate
  chain-of-custody in arbitration / MLITSD complaint / OLRB
  reprisal hearing. The chain SHOULD verify identically after
  restore; a divergence is a tamper signal (an actual attack) OR a
  restore-procedure bug (operator error).
- **Verification:** after every restore (drill or production),
  `bun apps/api/scripts/audit-log-verify.ts --full` runs against
  the restored DB. If `--full` does not exit 0, the restore is
  rolled back and the procedure is re-walked.

---

## 2. Backup verification (quarterly cadence)

Every quarter (independent of the 30-day drill cadence), the rep
runs a deeper verification that the backup chain itself is not silently
corrupt. The quarterly check is per `SECURITY.md` §9.

### 2.1 Spin up a parallel Neon branch

```bash
neonctl branches create --name=verify-$(date +%Y%m%d) --from=snapshot --snapshot-id=<latest>
```

The branch creation completes in seconds (Neon is copy-on-write under
the hood). Record the connection string output.

### 2.2 Run full-chain verification

```bash
DATABASE_URL=<branch-connection-string> bun apps/api/scripts/audit-log-verify.ts --full
```

**Pass criterion:** exit 0; report's `ok` field `true`; `gaps` empty;
`payloadShapeMismatches` empty. The chain on the branch should match
the chain on production byte-for-byte.

### 2.3 Decrypt a sample sealed envelope with the backed-up KEK

- From the cold-storage envelope, retrieve the `MASTER_KEY` value.
- Run the Excel-import integration test suite against the verify
  branch with the cold-storage KEK loaded into the env:
  `MASTER_KEY=<cold-storage-value> DATABASE_URL=<branch-connection-string> pnpm --filter @jhsc/api test -- excel-imports.integration`.
- **Pass criterion:** the round-trip seal+open test passes. Confirms
  the cold-storage KEK matches the production KEK.

### 2.4 Tear down the verify branch

```bash
neonctl branches delete verify-$(date +%Y%m%d)
```

Record the verification outcome in the §"Drill log" table with
`Verification: <date>`.

---

## 3. Restore procedure (cold drill)

The 30-day drill runs this procedure from cold. The procedure also
runs during a real recovery (the steps are identical; only the
trigger differs). The drill is timed: from §3.1 to §3.10, target
completion is ≤ 1 hour.

### 3.1 Create the parallel infrastructure

Create a new Fly app, a new Neon branch (from the latest snapshot),
and a new Tigris bucket. The drill uses parallel infrastructure so the
production app keeps running; a real recovery from a total-loss
incident creates these as the new production.

```bash
# Fly app (drill scope; for production recovery use the production app names)
fly apps create jhsc-worker-hub-api-drill --org=<rep-org>
fly apps create jhsc-worker-hub-ai-proxy-drill --org=<rep-org>

# Neon branch from the latest snapshot
neonctl branches create --name=restore-drill-$(date +%Y%m%d) --from=snapshot --snapshot-id=<latest-snapshot-id>
# Capture the connection string from the output.

# Tigris drill bucket (or, for production recovery, re-create the production buckets)
aws s3api create-bucket --bucket evidence-drill-$(date +%Y%m%d) --endpoint-url $TIGRIS_ENDPOINT --create-bucket-configuration LocationConstraint=ca-central-1
aws s3api put-bucket-versioning --bucket evidence-drill-$(date +%Y%m%d) --endpoint-url $TIGRIS_ENDPOINT --versioning-configuration Status=Enabled
```

**Time check:** target ≤ 10 minutes.

### 3.2 Restore Fly Secrets from cold storage

Open the cold-storage envelope (the sealed paper or the encrypted
USB key). For each secret in the inventory (§1.3):

```bash
fly secrets set MASTER_KEY=<value-from-envelope> --app jhsc-worker-hub-api-drill
fly secrets set AUTH_JWT_ED25519_PRIVATE_KEY_B64=<value> --app jhsc-worker-hub-api-drill
# ...continue for every secret in §1.3...
```

**Critical:** the cold-storage envelope's values are typed manually
(or scanned from the USB key). The rep does NOT copy-paste from any
online channel.

**Time check:** target ≤ 15 minutes.

### 3.3 Restore Neon from snapshot

Step 3.1 already created the branch from a snapshot. Verify the
branch is accessible:

```bash
psql <branch-connection-string> -c "SELECT count(*) FROM audit_log;"
```

**Pass criterion:** non-zero count; the count matches the production
chain length (or a documented divergence — the snapshot is point-in-time
so the drill count is whatever the snapshot captured).

**Time check:** target ≤ 5 minutes.

### 3.4 Restore Tigris from versioning

For a drill: no restore needed — the production Tigris bucket is
still online; the drill app reads from the production bucket OR from
the cold-storage bucket (`evidence-cold` / `exports-cold` per §1.2).

For a real recovery from total-loss:

```bash
# Sync from the cold-storage bucket into the new production bucket.
rclone sync tigris-cold:evidence-cold tigris:evidence-prod --progress
rclone sync tigris-cold:exports-cold tigris:exports-prod --progress
```

**Time check:** target ≤ 15 minutes (depends on data volume; at
single-tenant scale the volume is small).

### 3.5 Run all migrations

The Neon branch carries the production schema as of the snapshot
moment. If any migrations have shipped since the snapshot, run them:

```bash
DATABASE_URL=<branch-connection-string> pnpm --filter @jhsc/api drizzle:migrate
```

**Pass criterion:** migrations complete cleanly; the migration
history table is up to date with the current `migrations/` directory
listing (`migrations/0000_auth_baseline.sql` through
`migrations/0010_excel_import.sql` as of Release 1).

**Time check:** target ≤ 5 minutes.

### 3.6 Run `audit-log-verify --full` against the restored chain

```bash
DATABASE_URL=<branch-connection-string> bun apps/api/scripts/audit-log-verify.ts --full
```

**Pass criterion:** exit 0; report `ok: true`; `gaps: []`;
`payloadShapeMismatches: []`. A non-zero exit means the chain on the
restored branch does NOT match the chain on production — either a
tamper between snapshot and now, OR a restore-procedure bug, OR a
Neon snapshot corruption (rare but possible).

If §3.6 fails: stop the drill. Investigate per `docs/runbooks/auth.md`
§7 (tamper response). Do NOT proceed to §3.7.

**Time check:** target ≤ 5 minutes (chain length × O(N) verifier
overhead is small at single-tenant scale).

### 3.7 Decrypt a smoke-test sealed envelope end-to-end

The cold-storage KEK must match the production KEK. Run the same
sealed-box round-trip from §2.3:

```bash
MASTER_KEY=<cold-storage-value> DATABASE_URL=<branch-connection-string> pnpm --filter @jhsc/api test -- excel-imports.integration
```

**Pass criterion:** the integration test passes. The sealed-box
envelope from a production-written Excel import row decrypts cleanly
with the cold-storage KEK.

If §3.7 fails: the cold-storage envelope is out of sync with the
current production KEK. The most likely cause is a key rotation
between the last cold-storage refresh and now (workplace key
rotation is post-Release-1 backlog per ADR-0011 §"Out of scope" —
until then, a key rotation IS a deploy, and the deploy should have
refreshed the envelope). Investigate.

**Time check:** target ≤ 5 minutes.

### 3.8 Re-enroll passkey if the signing key rotated

If the signing key (Ed25519 keypair) rotated between the snapshot
moment and now, the JWTs issued under the old key still verify (the
verifier accepts multiple kids during a grace window per
ADR-0001 + `apps/api/src/auth/jwt.ts`), but new sign-ins on the
restored stack issue under the new key.

For a drill: no action needed.

For a real recovery from total-loss: the rep re-enrolls a passkey
against the new RP_ID by walking the first-run setup flow on the
restored app.

### 3.9 Deploy the drill app

```bash
fly deploy --app jhsc-worker-hub-api-drill --config apps/api/fly.toml
```

Wait for the deploy to settle. Hit the health endpoint:

```bash
curl -sf https://jhsc-worker-hub-api-drill.fly.dev/api/health
```

**Pass criterion:** `{"status":"ok","service":"api"}`.

**Time check:** target ≤ 10 minutes (Fly deploy + image pull).

### 3.10 Smoke-test against the restored stack

Per the post-deploy smoke procedure in
`docs/release-1-deploy-runbook.md` §"Smoke tests" — sign in, capture a
hazard, open the minutes board, verify a chain row lands. The smoke
asserts the restored stack is operationally equivalent to production.

**Pass criterion:** every smoke step succeeds; the new chain row's
`prev_hash` matches the restored chain's `this_hash` at the tail.

**Time check:** target ≤ 10 minutes.

### 3.11 Tear down the drill infrastructure

```bash
neonctl branches delete restore-drill-$(date +%Y%m%d)
aws s3api delete-bucket --bucket evidence-drill-$(date +%Y%m%d) --endpoint-url $TIGRIS_ENDPOINT
fly apps destroy jhsc-worker-hub-api-drill --yes
fly apps destroy jhsc-worker-hub-ai-proxy-drill --yes
```

For a real recovery: skip the teardown; the drill infrastructure
becomes the new production.

**Total drill time:** target ≤ 1 hour. Record actual duration in the
§"Drill log".

---

## 4. RTO / RPO targets

### 4.1 RTO — 4 hours

From incident-declared to rep using the restored app. The drill
procedure (§3) targets ≤ 1 hour; the 4-hour budget covers:

- 1 hour for the drill-equivalent procedure.
- 1 hour for incident triage (decide whether to restore vs.
  partial-fix-in-place).
- 1 hour for DNS / TLS cutover to the new app (DNS TTL propagation,
  Let's Encrypt cert provisioning).
- 1 hour buffer for unforeseen friction (Fly platform latency,
  Neon snapshot retrieval, the rep being away from a stable network).

### 4.2 RPO — 24 hours

The rep accepts up to 24 hours of write loss in a total-loss
scenario. Justification:

- Single-rep tool. Multi-tenant SaaS would target RPO ≤ 1 hour with
  continuous replication; this is not multi-tenant.
- Neon PITR's window is 30 days; the practical RPO at single-tenant
  scale is the time-since-last-snapshot (Neon snapshots daily). 24
  hours covers the worst case (a write at T+0, snapshot at T+24,
  incident at T+25 — the writes from T+0 to T+24 survive in
  PITR; from T+24 to T+25 they are lost).
- A worker rep's daily write volume is small (a handful of action
  items, a hazard or two, maybe an inspection). Losing a day of
  writes is recoverable: the rep re-enters from paper notes or
  memory.
- A multi-tenant SaaS RPO of ≤ 1 hour would require continuous
  replication infrastructure that the project's single-tenant
  posture does not warrant.

### 4.3 RTO / RPO honest divergences

- The pg-boss `sync_idempotency` TTL sweep is post-Release-1 backlog
  (per ADR-0011 §"Out of scope"). The table grows during the
  retention window; a restore from snapshot inherits the unswept
  rows. The chain is unaffected; the `--check-sync` forward-defense
  flag surfaces the expected `expired_unswept` anomaly count
  consistent with the deferral.
- A Fly region-wide outage in YYZ extends the RTO. Mitigation: the
  Fly platform's documented recovery time; the rep waits.
- A Neon region-wide outage in `ca-central-1` extends the RTO.
  Mitigation: same — wait for Neon's recovery.

---

## 5. Drift detection — what indicates the backup is stale or corrupt

- **`audit-log-verify --full` fails on the restored chain.** Either
  a tamper between snapshot and now, OR a snapshot corruption, OR a
  restore-procedure bug. Investigate per `docs/runbooks/auth.md` §7.
- **Sealed-box round-trip fails with the cold-storage KEK.** The
  envelope is out of sync; the most likely cause is a deploy that
  rotated KEK without refreshing the envelope. Re-extract from the
  current Fly Secrets and re-seal the envelope; record the
  refresh date.
- **Migration history on the restored branch is behind the current
  `migrations/` directory.** The snapshot is older than the last
  migration; either run the pending migrations (§3.5) OR roll
  forward to a fresher snapshot. The Fly + Neon free-tier window
  may not cover both extremes.
- **Tigris cold-storage bucket size diverges materially from the
  live bucket.** The `rclone sync` may have skipped objects (a
  permissions issue, a credential expiry). Re-run the sync
  manually with `--checksum` to force a content compare.
- **Neon PITR window shrinks below 30 days.** Check Neon project
  settings; the rep may have downgraded the tier.

---

## 6. Drill log

The runbook IS the drill record. Each drill row carries the date,
duration, outcome, and any findings. The S5 reviewer and the
pre-launch checklist §11.1 read this table.

| Drill date   | Operator | Duration  | Outcome     | Audit-verify | KEK round-trip | Notes / findings                                                               |
| ------------ | -------- | --------- | ----------- | ------------ | -------------- | ------------------------------------------------------------------------------ |
| `YYYY-MM-DD` | <rep>    | <minutes> | Pass / Fail | Pass / Fail  | Pass / Fail    | (free text — env or procedure bug, gap to address, link to remediation commit) |

### Verification log (quarterly, per §2)

| Verification date | Operator | Branch        | Audit-verify | KEK round-trip | Notes       |
| ----------------- | -------- | ------------- | ------------ | -------------- | ----------- |
| `YYYY-MM-DD`      | <rep>    | <branch-name> | Pass / Fail  | Pass / Fail    | (free text) |

### Cold-storage refresh log

| Refresh date | Trigger                   | Operator | Secrets refreshed                  | Storage location          |
| ------------ | ------------------------- | -------- | ---------------------------------- | ------------------------- |
| `YYYY-MM-DD` | Deploy / Rotation / Drill | <rep>    | (list secret names — never values) | Sealed envelope / USB key |

The drill log is the rep's responsibility to maintain. The
pre-launch checklist §11.1 reads the most recent drill row to
confirm the 7-day-pre-deploy currency requirement.

---

## 7. Honest divergences

- **The drill runs against a SNAPSHOT, not the live chain.** A
  drill that passes §3.6 confirms the snapshot's chain is
  consistent; a tamper that happened AFTER the snapshot is not in
  scope. The daily `audit-log-verify` cron (per `SECURITY.md` §9)
  covers the live chain.
- **The cold-storage envelope is single-rep-custody.** Per CLAUDE.md
  "single-tenant, worker-controlled". A multi-tenant SaaS would
  split custody across multiple operators; this is not SaaS. The
  envelope is the rep's responsibility; loss of the envelope without
  another copy is catastrophic.
- **The drill does NOT exercise a Fly region failure.** The drill
  uses the same `yyz` region as production. A region-wide outage is
  out of scope for the drill; Fly's platform recovery time is the
  bound. A future drill variant could provision the drill in a
  different region; for Release 1 the single-region posture is
  documented (PIPEDA T-HD32 — keep data in Canadian regions).
- **The drill timing target (≤ 1 hour) assumes a competent operator
  walking a familiar runbook.** A first-time drill, or a drill
  during an actual incident, may exceed the target. The 4-hour RTO
  budget absorbs that.
