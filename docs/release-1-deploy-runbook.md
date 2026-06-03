# Release 1 — Deploy Runbook

Milestone 1.12 S4. Implements ADR-0011 §3.9.

The exact procedure to take the app from current state to "rep is
using it in production". The rep walks this runbook once for the
initial deploy; subsequent deploys (post-Release-1 hardening
milestones, Release 2 features) reuse §"Initial deploy" + the relevant
provisioning steps.

Cross-references:

- ADR-0011 §3.9 — deploy runbook shape.
- `docs/release-1-security-pre-launch-checklist.md` — every row green
  before any of the steps below run.
- `docs/release-1-pen-test-plan.md` — runs post-deploy against
  staging.
- `docs/release-1-backup-restore-runbook.md` — the recovery procedure
  the deploy must be reversible against.
- `CLAUDE.md` Tech Stack — region + service choices this runbook
  honours.
- `SECURITY.md` §3 (controls), §7 (incident response), §8 (pre-launch
  checklist summary).

---

## 1. Prerequisites

Before any provisioning step below runs:

- [ ] `docs/release-1-security-pre-launch-checklist.md` walked, every
      row green or with documented divergence + operator sign-off.
- [ ] `docs/release-1-backup-restore-runbook.md` §"Drill log" carries
      a successful drill within the past 7 days (per checklist §11.1).
- [ ] `docs/release-1-pen-test-plan.md` reviewed; the rep has
      scheduled the post-deploy ZAP scan within 7 days of cutover
      (per checklist §13.6).
- [ ] PR #29 (1.11 Excel Import) merged to `main` — already done as
      of 1.12 S4.
- [ ] The 1.12 PR (this milestone's PR) merged to `main`.
- [ ] `SECURITY.md` is current (the threat-modeler §2.12 appendix
      from 1.12 S0 has landed on `main`).
- [ ] `docs/adr/0011-release-1-hardening.md` reviewed and accepted.
- [ ] `pnpm audit` (via `scripts/audit-with-allowlist.mjs`) exits 0.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test` exits 0 across the full workspace.
- [ ] `pnpm test:e2e` exits 0 on chromium + mobile-safari +
      mobile-chrome projects (per S3 deliverable, owned by the
      parallel S3 worktree).

---

## 2. Infrastructure provisioning

### 2.1 Fly.io app provisioning

Three Fly Machines in `ca-central-1` (region `yyz` — Toronto, per
CLAUDE.md Tech Stack lock).

```bash
# API
fly apps create jhsc-worker-hub-api --org=<rep-org>

# Web (serves the React PWA bundle)
fly apps create jhsc-worker-hub-web --org=<rep-org>

# AI proxy (idles in Release 1; provisioned now so post-Release-1 / R3
# milestones can drop in without a deploy churn — ADR-0011 §3.9)
fly apps create jhsc-worker-hub-ai-proxy --org=<rep-org>
```

The existing `fly.toml` files cover `apps/api` and `apps/ai-proxy`:

- `apps/api/fly.toml` — region `yyz`, internal port 3001 (the
  Dockerfile EXPOSEs the same), `force_https`, `auto_stop_machines`,
  health check at `/health`.
- `apps/ai-proxy/fly.toml` — region `yyz`, internal port 3002, same
  shape.

**GAP:** `apps/web/fly.toml` does NOT exist in the current tree. The
deploy needs one before the Fly Machine for the web app can ship.
**Must be addressed before production:** create `apps/web/fly.toml`
mirroring the apps/api shape (region `yyz`, internal port = whatever
`apps/web/Dockerfile` exposes for the static-serving runtime,
`force_https = true`, health check against a static path). Alternative
serving paths (Tigris+CDN per ADR-0011 §3.9) require their own
provisioning steps not covered in this runbook; the Fly Machine path
is the simpler initial choice.

**GAP:** there is no `apps/web/Dockerfile` in the current tree either.
The web app currently builds to `apps/web/dist/`; a production-serving
container (nginx static, Caddy, or a simple node http-server) needs
to be added. **Must be addressed before production.**

### 2.2 Neon Postgres provisioning

A new Neon project in region `ca-central-1` (AWS Montreal). The
project has one `production` branch (the default) and zero forks.

```bash
neonctl projects create --name=jhsc-worker-hub --region-id=aws-ca-central-1
# Capture project id from output.

neonctl databases create --project-id=<id> --name=jhsc_worker_hub
# Capture connection string.

# Roles: one app role + one read-only role for the audit-verify cron.
neonctl roles create --project-id=<id> --name=jhsc_app
neonctl roles create --project-id=<id> --name=jhsc_audit_readonly
```

After roles exist, grant the `jhsc_audit_readonly` role SELECT on
`audit_log` only:

```sql
GRANT CONNECT ON DATABASE jhsc_worker_hub TO jhsc_audit_readonly;
GRANT USAGE ON SCHEMA public TO jhsc_audit_readonly;
GRANT SELECT ON audit_log TO jhsc_audit_readonly;
```

Per ADR-0011 §3.9: the `jhsc_audit_readonly` role is the one the
daily `audit-log-verify` cron uses; it cannot mutate the chain, only
verify it. The app role (`jhsc_app`) carries the write privileges.

### 2.3 Tigris bucket provisioning

Two buckets in region `ca-central-1` (PIPEDA T-HD32):

```bash
aws s3api create-bucket --bucket evidence-prod --endpoint-url $TIGRIS_ENDPOINT --create-bucket-configuration LocationConstraint=ca-central-1
aws s3api create-bucket --bucket exports-prod --endpoint-url $TIGRIS_ENDPOINT --create-bucket-configuration LocationConstraint=ca-central-1

# SSE-AES256
aws s3api put-bucket-encryption --bucket evidence-prod --endpoint-url $TIGRIS_ENDPOINT --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-encryption --bucket exports-prod --endpoint-url $TIGRIS_ENDPOINT --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Versioning
aws s3api put-bucket-versioning --bucket evidence-prod --endpoint-url $TIGRIS_ENDPOINT --versioning-configuration Status=Enabled
aws s3api put-bucket-versioning --bucket exports-prod --endpoint-url $TIGRIS_ENDPOINT --versioning-configuration Status=Enabled

# Lifecycle policy: retain non-current versions for 30 days
# (matches the 1.11 reverse window per ADR-0010)
aws s3api put-bucket-lifecycle-configuration --bucket evidence-prod --endpoint-url $TIGRIS_ENDPOINT --lifecycle-configuration file://lifecycle-30d.json
aws s3api put-bucket-lifecycle-configuration --bucket exports-prod --endpoint-url $TIGRIS_ENDPOINT --lifecycle-configuration file://lifecycle-30d.json
```

**GAP:** `lifecycle-30d.json` is referenced above but no fixture file
exists in the tree. **Must be addressed before production:** create
the JSON inline at provision time per the AWS S3 lifecycle
configuration schema; sample content is documented in the AWS docs
under "S3 Lifecycle configuration".

### 2.4 VAPID keypair generation (Web Push)

Web Push notifications are deferred per `.env.example` comments
(deferred to Milestone 1.10 / Release 2). However, the VAPID keypair
is generated at deploy time so the secrets are in place when the
Web Push feature lands:

```bash
npx web-push generate-vapid-keys
# Capture public + private + a subject mailto.
```

Per non-negotiable #3, push notifications require explicit opt-in;
the keys here only enable the future feature.

### 2.5 KEK generation

The workplace KEK is 32 raw bytes, base64-encoded. The `.env.example`
documents the one-liner:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**GAP:** `apps/api/scripts/generate-kek.ts` does NOT exist in the
current tree. The ADR-0011 §3.9 reference to
`bun apps/api/scripts/generate-kek.ts` is aspirational. **Must be
addressed before production** — either land the script as part of a
follow-up commit OR use the `node -e` one-liner above. Either path
produces the same 32-byte random value; the script form is friendlier
for documentation.

### 2.6 Ed25519 signing keypair generation

For JWT signing. The `.env.example` documents the one-liner:

```bash
node -e "const c = require('crypto'); const { privateKey, publicKey } = c.generateKeyPairSync('ed25519'); console.log('priv:', privateKey.export({format:'der',type:'pkcs8'}).toString('base64')); console.log('pub:', publicKey.export({format:'der',type:'spki'}).toString('base64'));"
```

Captured as `AUTH_JWT_ED25519_PRIVATE_KEY_B64` and
`AUTH_JWT_ED25519_PUBLIC_KEY_B64`. The active kid (per
`apps/api/src/env.ts`) defaults to `legacy`; rotations bump to `k1`,
`k2`, etc. — rotation lands in the post-Release-1 backlog per
ADR-0011 §"Out of scope".

### 2.7 Workplace key pair

The workplace public+private keypair lives in the `workplace_keys`
table (Postgres-stored, with the private key sealed under
`MASTER_KEY`). The keypair is generated at first-run setup, not at
deploy time; the deploy step is just to ensure `MASTER_KEY` is
installed before first-run runs.

---

## 3. Secret installation

Every secret name + its source, every secret value installed via
`fly secrets set`. **None are committed to the repo.** The
`.env.example` carries placeholder lines; production values are typed
manually at deploy time.

```bash
# Database
fly secrets set DATABASE_URL='postgres://jhsc_app:<password>@<neon-host>/jhsc_worker_hub' --app jhsc-worker-hub-api

# KEK (32 bytes base64)
fly secrets set MASTER_KEY='<value-from-§2.5>' --app jhsc-worker-hub-api

# JWT signing keys
fly secrets set AUTH_JWT_ED25519_PRIVATE_KEY_B64='<value-from-§2.6>' --app jhsc-worker-hub-api
fly secrets set AUTH_JWT_ED25519_PUBLIC_KEY_B64='<value-from-§2.6>' --app jhsc-worker-hub-api
fly secrets set AUTH_JWT_ACTIVE_KID='legacy' --app jhsc-worker-hub-api

# WebAuthn RP configuration (production hostnames)
fly secrets set WEBAUTHN_RP_ID='<production-hostname>' --app jhsc-worker-hub-api
fly secrets set WEBAUTHN_RP_ORIGIN='https://<production-hostname>' --app jhsc-worker-hub-api
fly secrets set WEBAUTHN_RP_NAME='JHSC Worker Hub' --app jhsc-worker-hub-api

# Lockout ladder (defaults match SECURITY.md §3; override only with documented reason)
# fly secrets set AUTH_LOCKOUT_SHORT_FAILS=5 --app jhsc-worker-hub-api
# (omit to use the env.ts default)

# Tigris (from §2.3)
fly secrets set TIGRIS_BUCKET='evidence-prod' --app jhsc-worker-hub-api
fly secrets set TIGRIS_ENDPOINT='<tigris-endpoint-url>' --app jhsc-worker-hub-api
fly secrets set TIGRIS_REGION='ca-central-1' --app jhsc-worker-hub-api
fly secrets set TIGRIS_ACCESS_KEY_ID='<value>' --app jhsc-worker-hub-api
fly secrets set TIGRIS_SECRET_ACCESS_KEY='<value>' --app jhsc-worker-hub-api

# VAPID (from §2.4; for the future Web Push feature)
fly secrets set VAPID_PUBLIC_KEY='<value>' --app jhsc-worker-hub-api
fly secrets set VAPID_PRIVATE_KEY='<value>' --app jhsc-worker-hub-api
fly secrets set VAPID_SUBJECT='mailto:<rep-email>' --app jhsc-worker-hub-api

# Workplace config (non-negotiable #1 — env-driven only)
fly secrets set WORKPLACE_DISPLAY_NAME='<workplace-display-name>' --app jhsc-worker-hub-api
fly secrets set WORKPLACE_JURISDICTION='ON' --app jhsc-worker-hub-api  # or 'CA-FED'
fly secrets set ZONE_1_NAME='<zone-display-1>' --app jhsc-worker-hub-api
# ...ZONE_2_NAME through ZONE_10_NAME...

# AI proxy (idles in Release 1; sets up the env for R3)
fly secrets set AI_PROXY_URL='https://jhsc-worker-hub-ai-proxy.fly.dev' --app jhsc-worker-hub-api
fly secrets set AI_PROXY_SHARED_SECRET='<value>' --app jhsc-worker-hub-api --app jhsc-worker-hub-ai-proxy
fly secrets set ANTHROPIC_API_KEY='<value>' --app jhsc-worker-hub-ai-proxy
```

**Confirmation:** none of the values above are committed to git.
Verify with `git grep -E "MASTER_KEY=|TIGRIS_SECRET|ANTHROPIC_API_KEY=|VAPID_PRIVATE_KEY=" $(git ls-files)` — every match should be either (a) the placeholder line in `.env.example` (empty after `=`), (b) a documentation reference, or (c) a test fixture with a throwaway value. Any real-looking value in committed source blocks deploy.

**Cold-storage envelope:** after installation, copy every secret name+value into the cold-storage envelope per `docs/release-1-backup-restore-runbook.md` §1.3. Update the §"Cold-storage refresh log" with date + trigger = "Initial deploy".

---

## 4. Initial deploy

### 4.1 Run migrations

```bash
DATABASE_URL='<production-connection-string>' pnpm --filter @jhsc/api db:migrate
```

The migration order is `migrations/0000_auth_baseline.sql` through `migrations/0010_excel_import.sql` (per ADR-0011 §3.9). Drizzle runs them in lexicographic order.

**Pass criterion:** every migration applies cleanly; the migration history table holds 11 rows (0000..0010).

### 4.2 Seed the genesis audit row + backfill anchor

```bash
DATABASE_URL='<production-connection-string>' MASTER_KEY='<value>' bun apps/api/scripts/seed-audit-genesis.ts
```

Per ADR-0002, the genesis row (idx=0) and the backfill anchor (idx=1) are seeded by the script. The chain bootstraps from there.

**Pass criterion:** `SELECT idx, kind FROM audit_log ORDER BY idx LIMIT 2;` returns `0, audit.genesis` and `1, audit.backfill.1_2_auth_events`.

### 4.3 Seed the legal corpus

```bash
DATABASE_URL='<production-connection-string>' bun apps/api/scripts/seed-legal-corpus.ts
```

**Pass criterion:** the corpus row count matches the manifest count (per `packages/legal-corpus` build output).

### 4.4 Seed inspection templates

```bash
DATABASE_URL='<production-connection-string>' bun apps/api/scripts/seed-inspection-templates.ts
```

**Pass criterion:** the template row count matches the manifest.

### 4.4a Seed the meeting agenda template (Milestone 2.1)

```bash
DATABASE_URL='<production-connection-string>' WORKPLACE_JURISDICTION='<ON|CA-FED>' bun apps/api/scripts/seed-meeting-template.ts
```

Seeds the canonical "JHSC Standing Agenda v1" row for the configured jurisdiction (per ADR-0012 §3.3). The seed is idempotent — re-runs print `inserted=0 skipped=1` and exit 0. Emits one `audit.meeting_template.seeded` chain anchor on the INSERT path only.

**Pass criterion (DB):**

```bash
psql '<production-connection-string>' -c "SELECT version_number, name, jurisdiction FROM meeting_templates WHERE retired_at IS NULL"
```

Expected: one row with `version_number=1`, `name='JHSC Standing Agenda v1'`, and `jurisdiction` matching the `WORKPLACE_JURISDICTION` env var.

**Pass criterion (chain):**

```bash
DATABASE_URL='<production-connection-string>' bun apps/api/scripts/audit-log-verify.ts --check-meetings --quiet
```

Expected: exit 0 with `audit-log-verify OK …` on stdout. The `--check-meetings` walker (extended in S4) enforces that every `meeting.created` event references a template version that has a corresponding `audit.meeting_template.seeded` upstream — running the seed BEFORE the first meeting is created is the operational requirement.

### 4.5 Deploy the Fly Machines

```bash
fly deploy --config apps/api/fly.toml --app jhsc-worker-hub-api
fly deploy --config apps/ai-proxy/fly.toml --app jhsc-worker-hub-ai-proxy
# Web deploy requires apps/web/fly.toml + apps/web/Dockerfile (see §2.1 GAP).
# fly deploy --config apps/web/fly.toml --app jhsc-worker-hub-web
```

Each deploy targets the YYZ region. Watch the deploy output for the image-pull + machine-start sequence; the deploy completes when Fly reports `Machines started`.

### 4.6 Smoke-test the health endpoint

```bash
curl -sf https://jhsc-worker-hub-api.fly.dev/health
# Expected: {"status":"ok","service":"api"}
# NOTE (S5 F-R-NEW-1): the API mounts health at /health (apps/api/src/index.ts:23
# + apps/api/fly.toml health-check path). Earlier drafts of this runbook said
# /api/health which would 404 against a healthy deploy.

curl -sf https://jhsc-worker-hub-ai-proxy.fly.dev/health
# Expected: a similar shape (the ai-proxy idles but its health endpoint responds).
```

### 4.7 Verify the audit chain initialized

```bash
DATABASE_URL='<production-connection-string>' bun apps/api/scripts/audit-log-verify.ts --full
```

**Pass criterion:** exit 0; report's `rowCount` is 2 (genesis + backfill anchor); `gaps: []`; `payloadShapeMismatches: []`.

For the full JSON-report schema (every field a consumer can rely on)
see `docs/release-1-audit-verify-report-schema.md`. Add `--report=json`
to the invocation to produce the machine-readable form; the runbook's
canonical shape is documented there.

---

## 5. Rep enrollment

The first-run setup wizard claims the co-chair account. **CRITICAL:** the first-run route is single-shot — whoever reaches it first claims the account. The hostname must NOT be publicly DNS-resolvable until the rep has completed first-run.

### 5.1 First-run setup (BEFORE public DNS cutover)

Per ADR-0001 T-A11: complete first-run setup against the Fly-internal hostname (`jhsc-worker-hub-api.fly.dev`) before pointing the public DNS at it. The procedure:

1. The rep visits `https://jhsc-worker-hub-api.fly.dev/` (the API hostname for now — the web app's public URL is set up post-DNS-cutover, but the first-run flow runs through the API).
2. The first-run wizard prompts for the rep's identity (display name; per non-negotiable #1 the workplace name is already env-loaded).
3. The rep creates a password.
4. The rep enrolls a passkey (Face ID / Touch ID on the rep's iPhone is the canonical case).
5. The rep enrolls a TOTP fallback (an authenticator app on the rep's phone).
6. The wizard reveals recovery codes — the rep prints them and seals them in a physical envelope per `docs/release-1-backup-restore-runbook.md` §1.3 spirit (recovery codes are NOT in the cold-storage envelope; they live separately so a single compromise does not yield both).
7. The `first_run_completed_at` timestamp lands; the first-run route is locked.

### 5.2 Passkey enrollment ceremony

The passkey enrollment happens against the production `WEBAUTHN_RP_ID`. If the RP_ID changes later (e.g. a domain change), the enrolled passkey is bound to the old RP_ID and the rep re-enrolls.

In-person or video-verified is recommended for the initial enrollment; a remote-only enrollment without identity verification accepts that the device holding the passkey is the rep's device (which, at single-tenant scale with the rep being the operator, is the only structural assumption that holds).

### 5.3 TOTP fallback enrollment

Per the wizard step. The TOTP secret lives on the rep's phone; the corresponding hash lands in `auth_totp_secrets` (encrypted under `MASTER_KEY`).

### 5.4 Biometric setup on the rep's phone

After §5.1–5.3, the rep installs the PWA on the iPhone (Add to Home Screen) and / or Android (Install prompt). The biometric-step-up flow uses the same passkey enrolled in §5.2; no additional setup needed beyond installation.

---

## 6. Cutover

### 6.1 DNS

The rep's chosen domain (e.g. `worker-hub.<rep-domain>` for the web app, `api.<rep-domain>` for the API) — point at the Fly-published addresses:

```bash
fly ips list --app jhsc-worker-hub-api
fly ips list --app jhsc-worker-hub-web  # if web Fly Machine exists per §2.1 GAP resolution
```

Set the DNS A/AAAA records at the rep's DNS provider to the Fly IPs. TTL: 300s for the cutover, then 3600s for steady-state.

**Critical ordering:** do not cut DNS over until §5 first-run is complete. Per T-A11, exposing the API hostname to the public internet before first-run runs gives any attacker who reaches the URL first the ability to claim the co-chair account.

### 6.2 TLS certificate provisioning

```bash
fly certs create <production-hostname> --app jhsc-worker-hub-api
fly certs create <production-hostname> --app jhsc-worker-hub-web
```

Fly handles Let's Encrypt provisioning. Wait for the certificate to provision (typically 30–90 seconds; longer if DNS propagation is slow).

```bash
fly certs show <production-hostname> --app jhsc-worker-hub-api
# Expected: "Status: Ready"
```

### 6.3 HSTS preload submission

After §6.2 succeeds, submit the production hostname to https://hstspreload.org for inclusion in the Chromium HSTS preload list. The `Strict-Transport-Security` header is already sent per `apps/api/src/middleware/security.ts` with `max-age=63072000; includeSubDomains; preload`. The preload submission is a one-way commitment — once accepted, removing the domain takes months.

Per SECURITY.md §8: HSTS preload submission is on the pre-launch checklist; the deploy runbook step here is the actual submission action.

### 6.4 "Hello world" first hazard

The rep, signed in as the co-chair, opens the production app and creates the first real hazard. This produces:

- The first non-bootstrap audit row (`hazard.created` at idx=2 or higher).
- Confirmation that the chain advances cleanly past the bootstrap rows.

**Pass criterion:**

```bash
DATABASE_URL='<production-connection-string>' bun apps/api/scripts/audit-log-verify.ts --full
```

returns `ok: true` with `rowCount = 3` (or higher if multiple actions). The chain link from idx=2 → idx=1 verifies (prev_hash matches).

---

## 7. Smoke tests

The rep walks this 10-item checklist in person after cutover. Failing any step rolls back per §8.

1. [ ] Sign in (passkey path) — Face ID / Touch ID accepts; session JWT issued.
2. [ ] Sign out + sign in (password + TOTP fallback path) — both factors accepted; session JWT issued.
3. [ ] Capture a hazard via the floating action button — photo captured, GPS stamped, content hash recorded.
4. [ ] Open the hazard list view — the captured hazard appears.
5. [ ] Reveal the hazard (step-up triggers; TOTP unlocks) — plaintext fields decrypt; reveal is audit-logged.
6. [ ] Open the minutes board — empty state renders with the documented "what to do next" copy.
7. [ ] Promote the hazard to an action item via the documented affordance — action item lands in `new_business`.
8. [ ] Print the hazard detail (browser print preview) — Source Serif 4 body, chrome hidden, chain footer present.
9. [ ] Open the Excel-import view — empty state renders.
10. [ ] Sign out — session ends; subsequent requests require sign-in again.

The smoke is the gate on the 4–6 week real-world-use window (per ROADMAP.md line 175 + ADR-0011 §3.9). Any failure pauses Release 2 planning until resolved.

---

## 8. Rollback

The rollback is **one-way for schema** and **two-way for code**. Per CLAUDE.md "migrations are append-only", a schema rollback is a manually-crafted compensating migration; the app code rollback is `fly deploy --image <prev>`.

### 8.1 App-code rollback

```bash
# Identify the prior known-good image SHA
fly releases list --app jhsc-worker-hub-api
# Roll back to the image SHA from the prior release
fly deploy --image <prior-image-sha> --app jhsc-worker-hub-api
```

The audit chain is NOT rolled back — the chain captures the truth of what happened, including the failed deploy attempt. Rolling back app code is operationally safe; the chain stays forward-only.

### 8.2 Schema rollback

If a migration from the failed deploy breaks something, the rollback is a manually-crafted compensating migration. Append-only means there is no `drizzle:down`; the rep writes the inverse migration as a new `migrations/00NN_rollback_X.sql` and applies it.

At single-tenant scale, this is rare-but-possible. The rep has full DB access and can write the one-shot fix.

### 8.3 Tigris rollback

The buckets are versioned. Any object written by the failed deploy can be reverted via version restore:

```bash
aws s3api list-object-versions --bucket evidence-prod --endpoint-url $TIGRIS_ENDPOINT --prefix=<key>
aws s3api copy-object --copy-source 'evidence-prod/<key>?versionId=<good-version-id>' --bucket evidence-prod --key <key> --endpoint-url $TIGRIS_ENDPOINT
```

The lifecycle policy retains versions for 30 days (per §2.3); rollback is possible within that window.

### 8.4 Cold-storage envelope considerations

Rollback does NOT change the Fly Secrets. The cold-storage envelope is current as of the last refresh, which is independent of the deploy version. No envelope update is needed for a rollback.

---

## 9. First-week monitoring

The rep walks this checklist daily for the first 7 days post-cutover:

- [ ] Run `bun apps/api/scripts/audit-log-verify.ts --full` (or per `SECURITY.md` §9's "daily cron" cadence). **Pass criterion:** exit 0.
- [ ] Check Fly logs for the API machine — any unexpected 5xx? Any deploy-restart loops? Any `requireAuthEnv` failures (would indicate a missing secret)?
- [ ] Check Neon metrics — any unusual query latency? Any connection-pool exhaustion?
- [ ] Check Tigris bucket metrics — any unexpected bandwidth? Any 403/404 patterns suggesting probing?
- [ ] Open the app on the rep's phone — sign-in works, daily-flow renders, no regressions visible.
- [ ] Confirm the OWASP ZAP scan is on schedule per `docs/release-1-pen-test-plan.md` §"Test environment".

After day 7, monitoring cadence drops to weekly for the rest of the 4–6 week window.

---

## 10. Long-term ownership

### 10.1 KEK custody

The rep is the sole custodian of `MASTER_KEY`. The cold-storage envelope per `docs/release-1-backup-restore-runbook.md` §1.3 is the only out-of-band copy. Loss of both online (Fly Secrets) and offline (envelope) copies is catastrophic — every encrypted column becomes opaque.

Per CLAUDE.md "single-tenant, worker-controlled": there is no second custodian. The rep's responsibility is structurally singular.

### 10.2 Signing-key custody

Same shape as §10.1 for the Ed25519 signing keypair. The cold-storage envelope carries the private key. Loss of the private key + all online copies means new JWTs cannot be issued; existing JWTs verify until they expire, then sign-in stops working — re-deploy with a new keypair (the verifier accepts multiple kids during a grace window per ADR-0001).

### 10.3 Fly account access

The Fly account that owns the apps has the deploy capability. Access management is on the rep:

- The rep's Fly account credentials are protected by the rep's password manager + 2FA.
- If a second pair of eyes (the S5 reviewer per ADR-0011 §3.10) needs access for an emergency, the rep adds them as an org member via `fly orgs invite`.

### 10.4 Escalation path

The S5 reviewer (the second pair of eyes named on the pre-launch checklist sign-off line) is the rep's escalation contact for incident response. If the rep is unavailable:

- The S5 reviewer has the rep's documented Fly org membership.
- The S5 reviewer has READ access to the cold-storage envelope's location (NOT the envelope contents — the contents are physically sealed; the reviewer knows where the safe is).
- For an actual recovery scenario where the rep is unavailable for an extended period: the S5 reviewer follows `docs/release-1-backup-restore-runbook.md` §3 (cold-restore drill) with the cold-storage envelope.

This is structurally documentary, not a multi-custody setup. Per CLAUDE.md, the project is single-rep-owned; the escalation path is the closest approximation to redundancy that the single-tenant posture allows.

### 10.5 Long-term cadence

- **Daily:** `audit-log-verify` cron (per SECURITY.md §9).
- **Weekly:** review audit log volume + dependency check.
- **Monthly:** backup-restore drill per `docs/release-1-backup-restore-runbook.md`. Excel-import log review (per SECURITY.md §9 additions).
- **Quarterly:** OWASP ZAP re-scan per `docs/release-1-pen-test-plan.md`. Backup verification per `docs/release-1-backup-restore-runbook.md` §2. Excel parser re-fuzz against latest SheetJS.
- **Annually:** key rotation (KEK, workplace key pair, signing key — all on the post-Release-1 backlog per ADR-0011 §"Out of scope"; the cadence is set here so when the rotation scripts land, the schedule is already documented).
- **Annually:** legal corpus refresh against statutory updates (per SECURITY.md §9 additions).

---

## 11. GAP summary

The following items surfaced during the runbook survey and are flagged for resolution before production deploy:

- **GAP:** `apps/web/fly.toml` does not exist — see §2.1. Must be created before the web Fly Machine can deploy. Alternative: serve from Tigris+CDN per ADR-0011 §3.9.
- **GAP:** `apps/web/Dockerfile` does not exist — see §2.1. Must be created (or the alternative-serving path adopted) before the web app deploys.
- **GAP:** `apps/api/scripts/generate-kek.ts` does not exist — see §2.5. Use the `node -e` one-liner from `.env.example` until the script lands.
- **GAP:** `lifecycle-30d.json` fixture not in tree — see §2.3. Author inline per AWS S3 lifecycle schema at provision time.
<!-- S5 M-4 + S5 F-S9 + release-readiness GAP-5 triage: the previous
     "auth.md §7 referenced unsurveyed" entry was a false alarm. The
     section exists in `docs/runbooks/auth.md` at line 289 (heading
     `## 7. Audit-chain tamper response (Milestone 1.3+)`). Removed
     from the GAP list so a rep walking the runbook does not waste
     time on a non-issue. -->
- **Closed (S5 false-alarm triage):** `docs/runbooks/auth.md` §7 (tamper response) exists at line 289 of the auth runbook; no gap. The previous entry here flagged it for survey but verification confirmed the section is present. Removed.

Each gap is documented so it does not paper over; the rep addresses each before the production deploy or accepts the gap as documented divergence on the security checklist.
