# Release 1 — Security Pre-Launch Checklist

Milestone 1.12 S4. Implements ADR-0011 §3.3.

**Do not deploy if any item is unchecked or has known divergence.** Every
row below is either an automated check (with the exact command to run),
a manual UI / network verification (with the exact page or surface to
inspect), or a document inspection (with the exact file path). The day
before the rep flips to the production deployment, a human walks every
row, ticks the box, and records any divergence inline.

This document is the granular expansion of `SECURITY.md` §8. §8 stays
as the summary; this document carries the row-level detail. Companion
to `docs/release-1-pen-test-plan.md` (post-deploy ZAP scan),
`docs/release-1-backup-restore-runbook.md` (cold-restore drill), and
`docs/release-1-deploy-runbook.md` (provision / cutover / rollback).

Cross-references:

- ADR-0011 §3.3 — checklist shape and sign-off block.
- `SECURITY.md` §2.1..§2.12 — threat model entries this checklist verifies.
- `CLAUDE.md` non-negotiables #1..#16 — the row-organizing principles.
- `docs/release-1-wcag-audit.md` — S1 audit outcomes referenced from §1.9 and §1.10.
- `docs/release-1-fuzzing-findings.md` — S2 parser-fuzz residuals referenced from §7.
- `docs/release-1-audit-verify-gaps.md` — S2 `--full` documented gaps referenced from §2.

---

## How to use this checklist

1. Provision a staging deployment per `docs/release-1-deploy-runbook.md`
   §"Infrastructure provisioning" (do NOT walk this checklist against
   production for the first time — the act of walking it on staging is
   itself part of the pre-launch verification).
2. Walk each section top to bottom. Tick each `[ ]` box only after the
   pass criterion is met.
3. Any unchecked row at the end blocks deploy. Any row with a known
   divergence requires an explicit note ("divergence accepted because…")
   recorded against that row before sign-off.
4. The final sign-off block at the bottom is the rep's explicit
   acknowledgement. Sign with date and initials.

---

## §1 — Encryption posture (non-negotiable #2, #4; SECURITY.md §3, §2.3)

- [ ] **1.1 Workplace KEK (`MASTER_KEY`) present in Fly Secrets.**
      Run `fly secrets list --app jhsc-worker-hub-api` and confirm
      `MASTER_KEY` is in the list. **Pass criterion:** the secret is
      listed with a recent `CREATED AT` timestamp; the secret value is
      NEVER displayed (Fly redacts it). If absent, generation procedure
      is documented in `docs/release-1-deploy-runbook.md` §"Secret
      installation".
- [ ] **1.2 `MASTER_KEY` is never in a checked-in env file.**
      Run `grep -rn "MASTER_KEY=" .env* 2>/dev/null` from repo root.
      **Pass criterion:** matches return zero lines OR only the
      placeholder line in `.env.example` (which carries an empty value
      after the `=`). Any non-empty `MASTER_KEY=…` in a `.env`-class
      file is a deploy blocker.
- [ ] **1.3 `MASTER_KEY` is never logged.**
      Run `grep -rn "MASTER_KEY" apps/api/src/ packages/crypto/src/`
      and inspect every hit. **Pass criterion:** no `console.log`,
      `logger.info`, `process.stdout.write`, or similar carries the
      value. The crypto layer's `requireAuthEnv()` (`apps/api/src/env.ts`)
      reads the variable but the value never leaves the libsodium
      buffer.
- [ ] **1.4 Sealed-box envelope end-to-end smoke test.**
      Run the Excel-import integration test suite against the staging
      database: `pnpm --filter @jhsc/api test -- excel-imports.integration`.
      **Pass criterion:** the test that seals a DEK under the workplace
      public key and round-trips through `openExcelImportField`
      (`apps/api/src/excel-imports/crypto.ts`) passes. Confirms the
      sealed-box primitive is operational against the deployed Postgres.
- [ ] **1.5 No plaintext sensitive columns in a Neon snapshot.**
      Take a Neon point-in-time branch (per
      `docs/release-1-backup-restore-runbook.md` §"Backup verification"),
      connect to it with `psql`, and run
      `SELECT octet_length(ct) FROM hazards LIMIT 5;` (or the
      equivalent for `action_items.description_ct`,
      `evidence_files.dek_ct`, `excel_import_items.description_ct`).
      **Pass criterion:** every result is a non-zero byte length and a
      quick `pg_dump | grep -a "rep@workplace"`-style scan of the
      branch's dump returns zero plaintext hits for known seeded
      sensitive strings. Neon sees ciphertext only.
- [ ] **1.6 Argon2id parameters match SECURITY.md §3.**
      Inspect `apps/api/src/auth/password.ts` — confirm
      `t=3, m=64MiB, p=1` (or current §3 spec). **Pass criterion:**
      parameters match `SECURITY.md` §3; deviation requires a documented
      ADR.

---

## §2 — Audit chain (non-negotiable #2; SECURITY.md §3, §2.2)

- [ ] **2.1 Full-chain verification against the production-shape fixture.**
      Run
      `DATABASE_URL=$STAGING_DB_URL bun apps/api/scripts/audit-log-verify.ts --full`.
      **Pass criterion:** exit code 0, the structured report's `ok` field
      is `true`, `gaps` array is empty, `payloadShapeMismatches` array
      is empty.
- [ ] **2.2 Full-chain verification with a 30-day window.**
      Run
      `DATABASE_URL=$STAGING_DB_URL bun apps/api/scripts/audit-log-verify.ts --full --since=$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)`.
      **Pass criterion:** exit code 0; report's `rowCount` matches the
      windowed row count in the database. Confirms `--since` SQL
      filtering is working against the staging chain.
- [ ] **2.3 Hash chain link integrity.**
      Same `--full` run as §2.1. **Pass criterion:** the report's
      structural check `prevHash[i] == thisHash[i-1]` holds for every
      row; a divergence surfaces as a non-empty `gaps` array with the
      offending idx. ADR-0011 §3.7 + `apps/api/src/lib/audit-verify-full.ts`.
- [ ] **2.4 Per-actor timestamp monotonicity (gap-2 substitute).**
      Same `--full` run. **Pass criterion:** the report does not
      report any per-actor backwards-time anomaly.
      `docs/release-1-audit-verify-gaps.md` §"Gap 2" documents that
      this check stands in for the missing per-actor `sequence` column;
      a backwards-time row for the same actor is the tamper signal.
- [ ] **2.5 Documented signature-chain skip (gap-1).**
      Confirm the `--full` output line `signature check skipped — no
signing_key_id column on audit_log schema (gap-1)` appears.
      **Pass criterion:** the line is present (verifying the skip is
      acknowledged, not silenced). The audit-row signing surface is on
      the post-Release-1 backlog per ADR-0011 §"Out of scope".
- [ ] **2.6 Genesis + backfill anchor present.**
      Run
      `DATABASE_URL=$STAGING_DB_URL bun apps/api/scripts/audit-log-verify.ts --check-backfill`.
      **Pass criterion:** PASS with backfill anchor row count matching
      live `auth_events`. Confirms the 1.2 backfill anchor (idx=1) and
      the genesis row (idx=0) are present and consistent.
- [ ] **2.7 Evidence forward-defense check.**
      Run
      `DATABASE_URL=$STAGING_DB_URL bun apps/api/scripts/audit-log-verify.ts --check-evidence`.
      **Pass criterion:** PASS, no zero-UUID placeholder rows.
- [ ] **2.8 Sync idempotency forward-defense check.**
      Run
      `DATABASE_URL=$STAGING_DB_URL bun apps/api/scripts/audit-log-verify.ts --check-sync`.
      **Pass criterion:** PASS OR documented anomaly count consistent
      with the `expired_unswept` deferral (the pg-boss sweep job lands
      post-Release-1 per ADR-0011 §"Out of scope"). Any `cached_5xx` or
      `orphan_actor` finding is a deploy blocker.

---

## §3 — Authentication (non-negotiable #2, #6; SECURITY.md §2.1)

- [ ] **3.1 Passkey enrolled for the rep.**
      In the running staging app: sign in as the rep account, navigate
      to the auth settings view, confirm at least one passkey is listed
      under "Registered credentials". **Pass criterion:** the rep has
      successfully completed a passkey enrollment ceremony against the
      production-RP-id (per `docs/release-1-deploy-runbook.md`
      §"Rep enrollment").
- [ ] **3.2 TOTP fallback enrolled.**
      Same auth settings view. **Pass criterion:** "TOTP" is listed as
      an active fallback factor with a recent enrollment timestamp.
      The rep's authenticator app holds the TOTP secret.
- [ ] **3.3 Recovery codes generated and offline-stored.**
      During first-run setup the rep was shown a recovery-code reveal
      screen. **Pass criterion:** the rep confirms verbally (or via
      checklist initial) that the printed codes are in a sealed
      envelope in a physically-secure location.
- [ ] **3.4 Step-up gates fire on every documented sensitive route.**
      Manual walk: from a signed-in session without recent step-up,
      attempt to (a) reveal a hazard reporter identity, (b) decrypt an
      evidence file, (c) export an inspection PDF, (d) export a
      recommendation PDF, (e) commit an Excel import. **Pass criterion:**
      every attempt triggers the step-up modal; submitting TOTP unlocks
      the action for the documented 60s freshness window.
- [ ] **3.5 Step-up freshness window enforces 60s.**
      Trigger step-up for hazard reveal; wait 61 seconds; attempt the
      same reveal again. **Pass criterion:** the step-up modal fires
      again (the prior grant is stale).
- [ ] **3.6 Biometric step-up works on the rep's mobile device.**
      On the rep's iPhone Safari (and Android Chrome if applicable):
      trigger a step-up flow. **Pass criterion:** Face ID / Touch ID /
      Android biometric prompt fires AND a successful biometric unlocks
      the step-up grant. Documented in `docs/runbooks/auth.md`.
- [ ] **3.7 Lockout ladder thresholds match SECURITY.md §3.**
      Inspect Fly Secrets for `AUTH_LOCKOUT_SHORT_FAILS=5`,
      `AUTH_LOCKOUT_LONG_FAILS=10`, `AUTH_LOCKOUT_HARD_FAILS=20` (and
      their `_WINDOW_SECONDS` partners). **Pass criterion:** values
      match SECURITY.md §3; any tighter values are recorded as
      intentional divergence; any looser values block deploy.
- [ ] **3.8 Step-up action binding is cosmetic-only (known divergence).**
      `docs/adr/0009-offline-sync.md` §3.6 documented that step-up
      tokens are not truly action-bound in Release 1; the 60s freshness
      check is the actual defense. **Pass criterion:** acknowledge the
      divergence with initial; lands as "true per-action step-up
      binding" in the post-Release-1 backlog per ADR-0011
      §"Out of scope".

---

## §4 — Exports (non-negotiable #2, #16; SECURITY.md §4a)

- [ ] **4.1 Inspection PDF export is step-up gated.**
      Manual walk: trigger `POST /api/inspections/{id}/export` from a
      stale session. **Pass criterion:** 401 `step_up_required`; after
      step-up, 200 with the PDF buffer.
- [ ] **4.2 Inspection export emits `inspection.exported` audit row.**
      After §4.1, run a quick chain query:
      `SELECT idx, kind, payload->>'outputDocumentSha256' FROM audit_log WHERE kind = 'inspection.exported' ORDER BY idx DESC LIMIT 1;`.
      **Pass criterion:** row exists with the output document's SHA-256.
- [ ] **4.3 Inspection PDF output document hash matches the audit row payload.**
      Compute `sha256` of the downloaded PDF locally; compare against the
      `outputDocumentSha256` from §4.2. **Pass criterion:** exact match.
- [ ] **4.4 Recommendation PDF export is step-up gated.**
      Same shape as §4.1 against `POST /api/recommendations/{id}/export`.
      **Pass criterion:** 401 → step-up → 200.
- [ ] **4.5 Recommendation export emits `recommendation.exported` audit row.**
      Same shape as §4.2. **Pass criterion:** row exists with output
      document hash.
- [ ] **4.6 Hazard reveal export (PDF) is step-up gated and audit-logged.**
      Per ADR-0004 + non-negotiable #16. **Pass criterion:** every
      sensitive-data-revealing PDF emits a chain row recording the
      output document hash.
- [ ] **4.7 PDF watermark + chain anchor footer present.**
      Visually inspect a generated inspection PDF and a recommendation
      PDF. **Pass criterion:** workplace name (from
      `config/workplace.ts`) in the header, generated-at timestamp,
      chain idx footer, output document hash visible on the last page.
- [ ] **4.8 Excel-import commit is step-up gated and audit-logged.**
      Manual walk: commit a fixture import. **Pass criterion:**
      step-up required; `excel_import.committed` row lands in the chain
      with `sourceSha256` payload field.

---

## §5 — Privacy / third-party data (non-negotiable #3, #4; SECURITY.md §6)

- [ ] **5.1 Production bundle contains no third-party analytics SDK.**
      Run `pnpm --filter @jhsc/web build` then
      `grep -rIE 'gtag|google-analytics|googletagmanager|segment\.com|amplitude|mixpanel|posthog|hotjar|fullstory|sentry-bundle' apps/web/dist/`.
      **Pass criterion:** zero matches. (Sentry is excluded by name —
      if a future PR adds Sentry it must be opt-in per non-negotiable
      #3; for Release 1 it is not present.)
- [ ] **5.2 No outbound network calls to non-app origins.**
      Open browser DevTools network tab on staging, sign in, capture a
      30-minute session covering the daily flows. **Pass criterion:**
      every request is to the staging API host, the workplace-config
      domain, or the Tigris bucket endpoint. Zero requests to
      analytics, CDN-fetch-on-load, or third-party telemetry.
- [ ] **5.3 CSP header present on every API response.**
      `curl -sI https://api.<staging-host>/health | grep -i content-security-policy`
      (the API mounts health at `/health`, not `/api/health` —
      apps/api/src/index.ts:23; per S5 F-R-NEW-1).
      **Pass criterion:** header is present with the strict policy from
      `apps/api/src/middleware/security.ts` (`default-src 'none'`,
      `frame-ancestors 'none'`, etc.).
- [ ] **5.4 No employer IdP integration.**
      Inspect `apps/api/src/auth/` directory listing + grep for `okta`,
      `azure`, `auth0`, `oidc`, `saml`. **Pass criterion:** zero hits.
      Only passkey + password + TOTP per non-negotiable #6.
- [ ] **5.5 AI features off by default; no Anthropic calls in production.**
      Inspect the running app for AI feature toggles. **Pass criterion:**
      no AI feature is enabled; the `apps/ai-proxy` Fly Machine is
      provisioned but idles per ADR-0011 §3.9.
- [ ] **5.6 Logout clears every browser-side store.**
      Sign in, populate Dexie with some hazards, sign out, inspect
      `chrome://indexeddb-internals` (or equivalent on Safari).
      **Pass criterion:** no plaintext sensitive data remains in
      IndexedDB after logout. (Dexie at-rest encryption is on the
      post-Release-1 backlog per ADR-0011 §"Out of scope"; the logout
      clear is the Release 1 mitigation.)

---

## §6 — Legal corpus (non-negotiable #5; SECURITY.md §3)

- [ ] **6.1 `packages/legal-corpus` builds cleanly.**
      `pnpm --filter @jhsc/legal-corpus build`. **Pass criterion:** exit 0.
- [ ] **6.2 Corpus seeded against production Neon.**
      Run `bun apps/api/scripts/seed-legal-corpus.ts` against the
      staging DB. **Pass criterion:** seed succeeds; row count matches
      the corpus's manifest count.
- [ ] **6.3 No citation in the app resolves outside the corpus.**
      Walk the recommendation drafting view; trigger the citation
      picker; confirm every offered citation has a `source_url` field
      populated from the corpus. **Pass criterion:** zero free-text
      citations; zero AI-generated citations (AI features are off per
      §5.5).
- [ ] **6.4 No fictional or hand-typed clause references in source.**
      `grep -rnE "OHSA s\.[0-9]|s\.43|s\.50|s\.9\(20\)|s\.9\(21\)" apps/web/src/`
      and confirm every match either (a) appears in static copy that is
      a verifiable statutory quote OR (b) is rendered from a corpus
      entry. **Pass criterion:** every match traceable to corpus or
      verifiable quote.
- [ ] **6.5 Copyrighted-source caution respected.**
      `grep -rnE "CSA Z|ISO [0-9]|ACGIH" packages/legal-corpus/`. **Pass
      criterion:** only summaries, clause numbers, citation metadata;
      no full text. Per CLAUDE.md "Legal Reference Module Rules" #5.

---

## §7 — Excel imports (non-negotiable #11; SECURITY.md §2.11, §4)

- [ ] **7.1 Parsing happens browser-side only — network tab proof.**
      Open DevTools network tab; perform a real Excel import in the
      staging app with a fixture workbook. **Pass criterion:** the
      `.xlsx` bytes never appear in any outbound request body. The only
      POST to `/api/excel-imports` carries the sealed-box-encrypted
      field payload, not the raw workbook bytes.
- [ ] **7.2 Fuzzing harness green.**
      `pnpm --filter @jhsc/excel-import test:fuzz`. **Pass criterion:**
      1000 cases per CI run pass; no uncaught throws; harness reports
      a green run consistent with `docs/release-1-fuzzing-findings.md`.
- [ ] **7.3 Schema-mismatch produces a clear error, not a partial import.**
      Manual walk: upload a malformed workbook (e.g. a `.xlsx` with the
      `NEW BUSINESS` sheet renamed to `New Business 2024`). **Pass
      criterion:** the upload view shows a "we don't recognize this
      format" error; no preview renders; no API call is made.
- [ ] **7.4 Sensitive fields encrypted client-side.**
      Open DevTools, perform an import, capture the POST body to
      `/api/excel-imports`. **Pass criterion:** every `description_ct`
      field is base64 ciphertext, every `dekCt` field is a
      crypto_box_seal envelope. No plaintext description bytes.
- [ ] **7.5 Imports are reversible for 30 days.**
      Commit a test import; verify the reverse button is enabled on the
      import-history view. **Pass criterion:** reversal succeeds; the
      `excel_import.reversed` audit row lands. (NB: an `excel_import.cancelled`
      audit kind for partial-commit cancels is on the post-Release-1
      backlog per ADR-0011 §"Out of scope".)
- [ ] **7.6 `xlsx@0.18.5` HIGH advisories on allowlist (documented residual).**
      `pnpm audit` runs through `scripts/audit-with-allowlist.mjs`.
      **Pass criterion:** the script exits 0 with the allowlist
      mitigation message. The CDN-version bump is on the
      post-Release-1 backlog per ADR-0011 §"Out of scope".

---

## §8 — Identifiers (non-negotiable #1, #14; SECURITY.md §3)

- [ ] **8.1 No workplace name in source.**
      `grep -rni "<workplace-name>" apps/ packages/ config/` (substitute
      the rep's actual workplace name at scan time — DO NOT commit the
      scan command to git). **Pass criterion:** zero hits in `apps/`
      and `packages/`; the only references are in env-variable lookups
      under `config/workplace.ts`.
- [ ] **8.2 No union local in source.**
      Same shape as §8.1 with the union local string. **Pass criterion:**
      zero hits.
- [ ] **8.3 No real-person names in source.**
      `grep -rniE "<first-name>|<last-name>|<known-rep-handle>" apps/ packages/`.
      **Pass criterion:** zero hits.
- [ ] **8.4 `config/workplace.ts` reads from env only.**
      Inspect `config/workplace.ts`. **Pass criterion:** the only string
      literals are the zone IDs (`zone_1`..`zone_10` per non-negotiable
      #14) and generic fallback strings (`"Zone N"`). The workplace
      display name, jurisdiction, and zone display names come from
      `env.WORKPLACE_DISPLAY_NAME`, `env.WORKPLACE_JURISDICTION`,
      `env.ZONE_N_NAME`.
- [ ] **8.5 Fly Secrets carries the workplace identity env vars.**
      `fly secrets list --app jhsc-worker-hub-api`. **Pass criterion:**
      `WORKPLACE_DISPLAY_NAME`, `WORKPLACE_JURISDICTION`, and the
      relevant `ZONE_N_NAME` entries are present.
- [ ] **8.6 Gitleaks scan clean against the deployable tree.**
      `gitleaks detect --source . --config .gitleaks.toml` (or via CI
      log). **Pass criterion:** zero findings.

---

## §9 — Rights-protective UI (non-negotiable #7; SECURITY.md §6)

CLAUDE.md non-negotiable #7: copy must never discourage exercise of
OHSA s.43 (refusal), s.50 (reprisal), or CLC s.128/s.147. The scan
list below is the discouraging-phrase pattern set. A manual walk against
every copy surface — not a regex pass alone — is the authoritative gate.

- [ ] **9.1 No discouraging-phrase patterns in user-facing copy.**
      `grep -rniE "don't refuse|do not refuse|may face consequences|consider whether|might not be|are you sure you want to refuse|risks to your job|career consequences|think carefully before" apps/web/src/`.
      **Pass criterion:** zero hits, OR every hit is in a
      legally-required disclaimer that is itself rights-protective
      (e.g. "consider whether the danger is imminent" is acceptable in
      a CLC s.128 context but "consider whether you really need to
      refuse" is not).
- [ ] **9.2 Refusal flow copy reviewed manually.**
      Manual walk: open every view in the refusal flow (deferred to
      Release 2 per ROADMAP; for Release 1 the refusal "copy" surface
      is the static disclaimers in hazard create + the recommendation
      drafting view). **Pass criterion:** the WCAG audit at
      `docs/release-1-wcag-audit.md` documents the copy-review outcome.
- [ ] **9.3 Reprisal flow copy reviewed manually.**
      Same shape as §9.2 (reprisal flow is also Release 2). **Pass
      criterion:** documented.
- [ ] **9.4 No "automated submission" language.**
      `grep -rniE "automatically submit|file with the ministry|submit to MLITSD|send to inspector" apps/web/src/`. **Pass criterion:**
      zero hits; per non-negotiable #8, the app drafts; a human submits.

---

## §10 — Mobile-primary (non-negotiable #9; SECURITY.md §6)

- [ ] **10.1 iOS Safari smoke test on the rep's actual device.**
      On the rep's iPhone Safari (the device they will use in
      production): sign in, capture a hazard via the floating action
      button, open the minutes board, swipe an action item to
      `old_business`, sign out. **Pass criterion:** every step
      completes without horizontal scroll, with touch targets ≥44pt,
      with the bottom tab bar correctly active.
- [ ] **10.2 Android Chrome smoke test.**
      Same as §10.1 on an Android Chrome device if the rep team
      includes Android users. **Pass criterion:** same. If no rep team
      member uses Android, record "N/A — no Android in rep team" as
      the divergence.
- [ ] **10.3 PWA install prompt fires on Android Chrome.**
      On Android Chrome, visit the staging hostname; confirm the
      "Install" prompt appears. **Pass criterion:** install succeeds;
      the installed PWA opens to the sign-in view.
- [ ] **10.4 iOS Add-to-Home-Screen path documented in onboarding.**
      iOS Safari has no programmatic install; the rep adds via the
      share sheet → Add to Home Screen. **Pass criterion:** the
      installed app icon launches the PWA in standalone mode (no Safari
      chrome).
- [ ] **10.5 Capture-to-Record FAB works.**
      On both mobile platforms: tap the FAB → camera intent fires →
      photo captured → hazard draft created with GPS stamp + content
      hash. **Pass criterion:** the hazard lands in the list with a
      revealable photo attachment; the camera roll on the device is
      NOT populated with the photo (per non-negotiable #4).
- [ ] **10.6 Mobile Playwright specs (S3) green in CI.**
      Confirm the most recent CI run of `pnpm test:e2e` includes the
      `mobile-safari` and `mobile-chrome` projects green. **Pass
      criterion:** all mobile-flow spec assertions pass.

---

## §11 — Backup posture (SECURITY.md §7, §3; ADR-0011 §3.6)

- [ ] **11.1 Backup drill executed within the past 7 days.**
      Cross-reference `docs/release-1-backup-restore-runbook.md`
      §"Drill log". **Pass criterion:** the most recent drill row is
      dated within the past 7 days with `Outcome: Pass`.
- [ ] **11.2 Cold-restore was clean.**
      The drill log row's notes include "audit-log-verify --full passed
      on restored chain" and "smoke-test sealed envelope decrypted with
      backed-up KEK". **Pass criterion:** both phrases (or
      equivalent) present.
- [ ] **11.3 Fly Secrets cold-storage envelope is current.**
      The rep confirms verbally (or by checklist initial) that the
      sealed-envelope cold-storage copy of the KEK + signing keys +
      VAPID + Tigris credentials is updated as of the last key
      rotation (or last deploy if no rotation). **Pass criterion:**
      acknowledged with date.
- [ ] **11.4 Neon point-in-time recovery covers the last 30 days.**
      Inspect Neon project settings → "Point-in-time restore window".
      **Pass criterion:** window ≥ 30 days (Neon free tier is 7 days;
      the rep may need to upgrade to the paid tier for 30-day window
      — record the tier choice with the deployment).
- [ ] **11.5 Tigris versioning enabled on both buckets.**
      `aws s3api get-bucket-versioning --bucket evidence-prod --endpoint-url $TIGRIS_ENDPOINT`
      (and `--bucket exports-prod`). **Pass criterion:** versioning is
      `Enabled` on both.

---

## §12 — Region (non-negotiable #6; CLAUDE.md Tech Stack; ADR-0011 §3.9)

PIPEDA T-HD32 (data residency): Canadian worker data must stay in
Canadian regions where reasonably possible. The choices below honour
that posture.

- [ ] **12.1 Fly region is `yyz` (Toronto).**
      `fly status --app jhsc-worker-hub-api`. **Pass criterion:**
      `primary_region = "yyz"` matches `apps/api/fly.toml` and the
      `Region` column in machine list shows `yyz`.
- [ ] **12.2 `apps/ai-proxy` Fly region is `yyz`.**
      `fly status --app jhsc-worker-hub-ai-proxy`. **Pass criterion:**
      same as §12.1.
- [ ] **12.3 Neon project region is `ca-central-1` (AWS Montreal).**
      Inspect Neon project settings. **Pass criterion:** region is
      `ca-central-1`. Per CLAUDE.md Tech Stack lock.
- [ ] **12.4 Tigris bucket region is `ca-central-1`.**
      Inspect Tigris bucket settings (or
      `aws s3api get-bucket-location --bucket evidence-prod --endpoint-url $TIGRIS_ENDPOINT`).
      **Pass criterion:** region is `ca-central-1` (PIPEDA T-HD32).
- [ ] **12.5 No cross-region data egress.**
      Review the daily flows for any feature that crosses regions
      (e.g. a CDN that egresses to US PoPs). **Pass criterion:** the
      web app is served from the YYZ Fly Machine directly (no CDN at
      Release 1 per ADR-0011 §3.9); future CDN must be Canadian-PoP-only
      or carry a documented privacy decision.

---

## §13 — Deploy runbook (ADR-0011 §3.9)

- [ ] **13.1 Deploy runbook exists and is current.**
      `docs/release-1-deploy-runbook.md` is present and references the
      current tree's `fly.toml` files, migration order
      (`migrations/0000`..`0010`), and env var inventory.
      **Pass criterion:** doc inspection.
- [ ] **13.2 Owner identified.**
      The rep is the operator-owner. **Pass criterion:** the deploy
      runbook §"Long-term ownership" section names the rep as the
      operator and lists the escalation path (the second pair of eyes
      who has read this checklist for the S5 review).
- [ ] **13.3 Rollback procedure rehearsed.**
      The rep has walked through a `fly deploy --image <prev>` on the
      staging environment at least once. **Pass criterion:**
      acknowledged with date in the drill log.
- [ ] **13.4 Pen test plan committed.**
      `docs/release-1-pen-test-plan.md` is present.
      **Pass criterion:** doc inspection.
- [ ] **13.5 Backup-restore runbook committed.**
      `docs/release-1-backup-restore-runbook.md` is present.
      **Pass criterion:** doc inspection.
- [ ] **13.6 Pen test schedule confirmed.**
      The rep has scheduled the post-deploy OWASP ZAP scan per
      `docs/release-1-pen-test-plan.md` §"Test environment" within the
      first 7 days of the post-deploy 4–6 week window.
      **Pass criterion:** scheduled date recorded inline.

---

## Documented residuals (post-Release-1 backlog)

The following items are accepted residuals; deploy is NOT blocked on
them but the rep acknowledges them at sign-off. Each row points to its
source ADR + the post-Release-1 milestone where it lands. The full
list is in ADR-0011 §"Out of scope":

- Workplace key pair rotation script — ADR-0002 §"Follow-ups".
- Workplace signing key rotation script — ADR-0008 + ADR-0009 forward seam.
- KEK rotation script — ADR-0002 + SECURITY.md §9.
- Dexie at-rest encryption via WebAuthn PRF / session-derived key — ADR-0009 priv-F1 + ADR-0010 T-X42.
- True per-action step-up binding — ADR-0009 §3.6 + ADR-0010 T-X26.
- Conflict UI Apply pipeline (three-way merge view-only today) — ADR-0009 priv-F4 + sec-F3 + sec-F4.
- Tigris bucket orphan-ciphertext GC — ADR-0006 + ADR-0007 + ADR-0008 forward seam.
- `audit-log-verify` forward-defense flags (`--check-inspections`, `--check-recommendations`, `--check-excel`) — ADR-0007 + ADR-0008 + ADR-0010 §"Follow-ups".
- PAdES embedded signatures for recommendation exports — ADR-0008 §"Follow-ups".
- `excel_import.cancelled` audit kind — ADR-0010 §11.
- `recommendation.read` audit kind — ADR-0009 §12 item 8.
- `inspection_finding.read` chain anchor refinements — ADR-0007 §"Follow-ups".
- pg-boss-backed sync_idempotency TTL sweep + sync rate-limit — ADR-0009 §12 item 5.
- SheetJS CDN upgrade past `xlsx@0.18.5` — `scripts/audit-with-allowlist.mjs` header + ADR-0010 T-X54.
- Per-attendee encryption for inspection findings — ADR-0010 §"Out of scope" + T-X14 + T-X48.
- `before_state_json` envelope encryption — ADR-0010 §11 priv-F7.
- Source workbook archival under workplace KEK — ADR-0010 §11 T-X43.
- Dexie preview persistence for excel-import — ADR-0010 §11 priv-F4.
- Server-side EXIF strip for upload-from-file fallback — ADR-0006 §"Follow-ups".
- Per-row Ed25519 signature column on `audit_log` (gap-1) — `docs/release-1-audit-verify-gaps.md` §"Gap 1".
- Per-actor `sequence` column on `audit_log` (gap-2 — currently using timestamp-monotonicity substitute) — `docs/release-1-audit-verify-gaps.md` §"Gap 2".
- Per-kind `payloadShapeMismatches` Zod validators (gap-3) — `docs/release-1-audit-verify-gaps.md` §"Gap 3".

---

## Operator sign-off

I have read every row of §1 through §13, plus the Documented residuals
section above. I have ticked every box or recorded a documented
divergence. I accept the residuals enumerated above as forward backlog
that lands in sequenced post-Release-1 hardening milestones. I authorize
Release 1 deploy.

```
Date:        ______________________
Operator:    ______________________  (the rep, in single-tenant scope)
Initials:    ______________________
Reviewer:    ______________________  (S5 second pair of eyes, per ADR-0011 §3.10)
Reviewer
initials:    ______________________
```

This sign-off is documentary, not legal. The cryptographic evidence of
what was deployed is the genesis audit row at idx=0 and the chain
anchors that follow. Per CLAUDE.md non-negotiable #2, the chain is the
canonical evidence; this signature is the rep's moment of
acknowledgement.
