# M1.12 Release-Readiness Review

Reviewer: independent S5 (release-readiness)
Reviewed commits: 630b3df, 64d0605, 87c5341, 0eb4c17, ac5ce65
Scope: §A doc executability, §B cross-doc consistency, §C GAP triage,
§D backlog ratchet, §E ROADMAP delta

This review is READ-ONLY. No source files were modified. Findings
below are organized by severity. The S4 deploy runbook already
self-flagged five gaps in §11; this review re-triages those plus
surfaces NEW gaps the S4 author did not catch.

---

## §A — Executability spot-check (10 cited commands/paths)

| Doc                         | Cited path / command                                                                               | Exists?                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| deploy runbook §4.6         | `https://jhsc-worker-hub-api.fly.dev/api/health`                                                   | NO — health is mounted at `/health` (see F-R1)    |
| deploy runbook §4.1         | `pnpm --filter @jhsc/api drizzle:migrate`                                                          | NO — package script is `db:migrate` (see F-R2)    |
| deploy runbook §2.5         | `apps/api/scripts/generate-kek.ts`                                                                 | NO — already flagged GAP-3                        |
| deploy runbook §2.1         | `apps/web/fly.toml`                                                                                | NO — already flagged GAP-1                        |
| deploy runbook §2.1         | `apps/web/Dockerfile`                                                                              | NO — already flagged GAP-2                        |
| deploy runbook §2.3         | `lifecycle-30d.json`                                                                               | NO — already flagged GAP-4                        |
| deploy runbook §4.2         | `apps/api/scripts/seed-audit-genesis.ts`                                                           | YES                                               |
| backup-restore §3.6 / §3.10 | `docs/runbooks/auth.md §7` (tamper response)                                                       | YES — exists at auth.md L289 (GAP-5 false alarm)  |
| security checklist §1.4     | `excel-imports.integration` test grep                                                              | YES — file is `excel-imports.integration.test.ts` |
| security checklist §10.6    | `pnpm test:e2e` covers `mobile-safari` + `mobile-chrome`                                           | YES — playwright config covers both               |
| pen-test plan §3.2          | `apps/api/src/auth/lockout.ts`                                                                     | YES                                               |
| ADR-0011 §3.7 fixture       | `apps/api/test/fixtures/audit-log-full-dataset.sql` + `apps/api/scripts/generate-audit-fixture.ts` | NO — see F-R3 (NEW gap, S2 silently dropped both) |

---

## §C — GAP triage table (the five GAPs S4 self-flagged in §11)

| #     | Item                                             | Severity  | Justification                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-1 | `apps/web/fly.toml` missing                      | **P0**    | Blocks the web Fly Machine deploy. The runbook proposes a Tigris+CDN alternative but does not ship that toml either. Without one of the two paths the rep cannot serve the PWA in production — first-run + every flow downstream is blocked. Must ship before cutover. |
| GAP-2 | `apps/web/Dockerfile` missing                    | **P0**    | Same shape as GAP-1. The Fly Machine path requires a runtime container; the Tigris+CDN path requires a static-host pipeline. Either way an artifact is missing.                                                                                                        |
| GAP-3 | `apps/api/scripts/generate-kek.ts` missing       | **P1**    | The `.env.example` ships a working `node -e` one-liner; the script form is documentary not load-bearing. Production deploy can proceed with the one-liner. Track in 1.12.1.                                                                                            |
| GAP-4 | `lifecycle-30d.json` fixture missing             | **P1**    | The lifecycle-policy JSON is small enough to author inline at provision time from the AWS S3 lifecycle schema. The 30-day retention is the substantive contract; the file shape is mechanical. Do not block cutover, but author it before the bucket commands run.     |
| GAP-5 | `docs/runbooks/auth.md §7` referenced unsurveyed | **CLEAN** | Verified: `auth.md` line 289 is `## 7. Audit-chain tamper response (Milestone 1.3+)`. Section exists. This GAP can be closed as a false alarm in the runbook §11 list.                                                                                                 |

**P0 count: 2.**

---

## New gaps discovered (NOT in S4's §11)

- **F-R1 (P0).** Health endpoint path mismatch. The deploy runbook §4.6 + the security checklist §5.3 + the backup-restore drill §3.9 all curl `https://...fly.dev/api/health`. The actual route mounted in `apps/api/src/index.ts:23` is `app.route('/health', healthRoute)` and `apps/api/fly.toml` health-check path is `/health`. A rep walking the runbook will fail the smoke-test step on a working deploy because the URL is wrong. Fix the runbook URLs (or remount the route under `/api/health` — but the toml health-check would then also need updating).
- **F-R2 (P0).** Drizzle migrate command mismatch. Deploy runbook §4.1 invokes `pnpm --filter @jhsc/api drizzle:migrate`. The `apps/api/package.json` defines `db:migrate` (no `drizzle:migrate` script). Backup-restore runbook §3.5 carries the same broken invocation. A rep running it produces "Command 'drizzle:migrate' not found." Fix to `db:migrate`.
- **F-R3 (P1).** S2 silently dropped the synthetic full-dataset audit-log fixture + the generator script. ADR-0011 §3.7 + S2 brief specify `apps/api/test/fixtures/audit-log-full-dataset.sql` (committed) and `apps/api/scripts/generate-audit-fixture.ts` (developer-side tool). Neither exists. The S2 commit lands `audit-log-verify.test.ts` (479 lines, synthetic in-test fixtures) which is functionally similar but means CI does not run `--full` against a chain that mirrors the production-shape across every chain-kind. The S2 docs do not flag this as a deferral. **Recommend: either author the fixture before cutover OR add an honest line to `release-1-audit-verify-gaps.md` documenting the deferral and pointing at the alternative in-test coverage.**
- **F-R4 (P1).** pg-boss worker shell provisioning is absent from the deploy runbook. ADR-0011 §3.9 explicitly says the deploy provisions `boss.schema_create` + the empty worker process so post-Release-1 sweeps drop in cleanly. The shipped deploy runbook §2 + §3 + §4 do not provision either. Without it the post-Release-1 `sync_idempotency` TTL sweep + dead-letter retry will land alongside their own deploy churn.
- **F-R5 (P1).** ADR-0011 §3.4 promised a `docs/audits/release-1-pentest-findings.md` target file path; the pen-test plan §1 + §12 references it but the directory exists (`docs/audits/`) and the file is correctly NEW-at-first-scan. Acceptable, but the doc should explicitly state "file does not exist yet; the first scan creates it" — currently §12 reads "appended to on subsequent scans" which implies it exists today.
- **F-R6 (P1).** Migration run order in ADR-0011 §3.9 says "0001..0010" but the actual tree carries `0000_auth_baseline.sql` through `0010_excel_import.sql` (11 migrations, 0000-inclusive). The deploy runbook §4.1 gets this right ("11 rows (0000..0010)"). The ADR text has a minor off-by-one — does not block deploy but reads inconsistently with the runbook.
- **F-R7 (P2).** ADR-0011 §3.9 + the security checklist refer to `WORKPLACE_NAME` env var in some places (ADR-0011 §3.9 bullet list) and `WORKPLACE_DISPLAY_NAME` in others (deploy runbook §3, config/workplace.ts is the canonical name). Reps reading the ADR will set the wrong var. Update ADR-0011 §3.9 prose to match `WORKPLACE_DISPLAY_NAME` (the code-canonical form). The CI lint that ADR-0011's S4 follow-up calls for ("env var inventory matches `config/workplace.ts`") would catch this — but that lint is not yet shipped.
- **F-R8 (P2).** ADR-0011 §3.1 specifies the WCAG audit lives at `docs/audits/release-1-wcag-audit.md`; S1 shipped it at `docs/release-1-wcag-audit.md` (root of `docs/`, not `docs/audits/`). Cross-references in the checklist follow the as-shipped path so no rep is blocked, but the ADR is now subtly out of sync with the tree.
- **F-R9 (P1).** ADR-0011 §3.10 specifies `apps/api/scripts/backup-restore-smoke.ts` is shipped in S4. It is NOT in the tree. The backup-restore runbook §3 walks the drill manually and does reach §3.6's `audit-log-verify --full` step, so the smoke-test script's absence is mitigated by the explicit drill procedure; track for 1.12.1.
- **F-R10 (P2).** Cosmetic-only step-up action-binding (the 1.9 sec-F1 deferral, 1.10 + 1.11 carry-forward) IS captured in the security checklist §3.8 and in ADR-0011 §"Out of scope" as "true per-action step-up binding". Verified clean — see §"Verified clean" below.

---

## §B — Cross-doc consistency

- **RTO/RPO consistency.** Backup-restore runbook §4.1 says RTO 4h, §4.2 says RPO 24h. The security checklist §11 references the drill log but does not assert an RTO/RPO value — no conflict. The deploy runbook §1 prerequisite reads "drill within the past 7 days" which the checklist §11.1 also enforces. **Consistent.**
- **Step-up gates on every PDF/export.** Security checklist §4.1, §4.4, §4.6, §4.8 cover inspection, recommendation, hazard reveal, excel-import-commit step-ups. Non-negotiable #16 requires every export be step-up gated + audit-logged with output document hash. Checklist §4.3 + §4.5 explicitly verify the output document hash chain. **Consistent.**
- **Pre-deploy gate order.** Deploy runbook §1 lists the prerequisites; the order respects the security checklist's §"How to use" rule (walk staging first). The deploy runbook does NOT walk to step §2 until §1 is clean. **Consistent.**
- **AI proxy idle posture.** Security checklist §5.5 + pen-test plan §1 + ADR-0011 §3.9 all agree the proxy idles. Deploy runbook §2.1 + §3 provision the keys for forward compat. **Consistent.**
- **Cross-link integrity.** Security checklist correctly references `release-1-wcag-audit.md`, `release-1-fuzzing-findings.md`, `release-1-audit-verify-gaps.md` — all three files exist. Pen-test plan references `release-1-security-pre-launch-checklist.md §13.6` (real row), backup-restore §"Drill log" (real), and `release-1-deploy-runbook.md §"Infrastructure provisioning"` (real). **Consistent.**

---

## §D — Backlog ratchet (prior-ADR deferrals → 1.12 absorption)

ADR-0011 §"Out of scope" + the security checklist §"Documented residuals" carry roughly 24 deferrals. Cross-referencing each prior-ADR's "1.12 absorbs" stub:

**Captured cleanly:**

- Workplace key pair / signing key / KEK rotation scripts (ADR-0002, ADR-0008, ADR-0009). ✓
- Dexie at-rest encryption (ADR-0009 priv-F1, ADR-0010 T-X42). ✓
- True per-action step-up binding (ADR-0009 §3.6, ADR-0010 T-X26) — the 1.9 sec-F1 deferral. ✓
- Conflict UI Apply pipeline (ADR-0009 priv-F4 + sec-F3 + sec-F4). ✓
- Tigris orphan-ciphertext GC (ADR-0006/0007/0008). ✓
- `audit-log-verify` forward-defense flags. ✓
- PAdES embedded signatures (ADR-0008). ✓
- `excel_import.cancelled`, `recommendation.read`, `inspection_finding.read` audit kinds. ✓
- pg-boss `sync_idempotency` TTL sweep (ADR-0009). ✓
- SheetJS CDN upgrade past 0.18.5. ✓
- `before_state_json` envelope encryption, source-workbook archival under KEK, Dexie preview persistence. ✓
- Per-attendee encryption (ADR-0010). ✓

**NOT captured in 1.12 backlog (prior ADRs deferred but 1.12 ADR forgot them):**

- **F-R11 (P1).** ADR-0008 §3 forward-seam: **public verification page** ("1.12 ships a public verification page" per ADR-0008 line 249). Neither shipped in 1.12 nor enumerated in the backlog. Recipients of a signed recommendation PDF have no documented way to verify outside the rep's audit chain. Add to ADR-0011 §"Out of scope" + checklist Section C with a "lands in" pointer.
- **F-R12 (P1).** ADR-0008 §3 forward seam: **pg-boss-backed cross-process export rate limiter** ("1.12 follow-up per the 1.8 runbook"). Not in 1.12 backlog. At single-tenant scale the in-memory rate limiter holds, but the deferral should be explicit.
- **F-R13 (P2).** ADR-0009 §"Out of scope" forward seam: **service-worker rotation procedure** (revoke stale SW on KEK rotation). Not in 1.12 backlog. Will become load-bearing the day KEK rotation lands; absent the entry it could be forgotten.
- **F-R14 (P2).** ADR-0009 §"Out of scope" forward seam: **dead-letter Prometheus metric** (or equivalent operational signal). Not in 1.12 backlog. Operability degradation.
- **F-R15 (P2).** ADR-0010 §"Out of scope" forward seams not captured: **automated content_hash dedup detection across imports**, **source-filename PII detector**, **reverse-window admin UI for the co-chair past 30 days**, **`.xls` (binary 97-2003) fallback parser**. Four items; none enumerated in the 1.12 backlog list. (The reverse-window admin UI is the most operationally relevant — the rep needs a way past day 30 today and has only the operator script.)
- **F-R16 (P2).** ADR-0007 §"Follow-ups" forward seam: **`inspection_finding_redactions` table**. ADR-0011 §"Out of scope" lumps this into "Evidence / inspection_finding / recommendation redaction tables — lands in Release 2". Adequate, but the rep should know it's a Release 2 item rather than a post-Release-1-hardening item.

The 1.9 cosmetic-step-up-binding sec-F1 deferral **IS** captured (§3.8 of the checklist + bullet 5 of ADR-0011 §"Out of scope"). Verified clean.

---

## §E — ROADMAP delta (scope bleed into Release 2/3?)

- **Web Push / VAPID.** Deploy runbook §2.4 generates VAPID keys at deploy time even though Web Push is deferred to Release 2 per ROADMAP. Justified: the keys are forward-seam; no Release 2 feature is promised in the runbook. **Clean.**
- **Reprisal / refusal flow.** Security checklist §9.2 + §9.3 explicitly mark these as "Release 2" and only assert the Release 1 surface (static disclaimers in hazard create + recommendation drafting). **Clean.**
- **E2EE messaging / libsignal.** No mention in any S4 doc. **Clean.**
- **AI features.** Deploy runbook §2.1 + §3 provision the ai-proxy Fly Machine + the env vars, explicitly noting it idles. Security checklist §5.5 verifies AI is off. Pen-test plan §1 covers the proxy in scope only for "cannot be coerced into proxying without an authenticated origin." **Clean.**
- **Meeting lifecycle (Release 2.1).** No mention. **Clean.**

The S4 docs honor the "Release 1 only" scope discipline. No Release 2 / Release 3 features are accidentally promised.

---

## Findings

### CRITICAL (release-blocker; must fix before production cutover)

- **F-R1** — Health endpoint URL mismatch (`/api/health` in docs vs `/health` actually mounted). Smoke test step fails on a working deploy.
- **F-R2** — `drizzle:migrate` script does not exist; package defines `db:migrate`. Both deploy and backup-restore drills fail on this command.
- **GAP-1** — `apps/web/fly.toml` missing.
- **GAP-2** — `apps/web/Dockerfile` missing.

### HIGH (fix-in-S5-bundle — block S5 sign-off but not deploy if accepted as documented divergence)

- **F-R3** — Audit-log-verify full-dataset fixture + generator script silently dropped from S2 deliverables.
  - **Where:** ADR-0011 §3.7 + S2 brief vs. tree
  - **What:** `apps/api/test/fixtures/audit-log-full-dataset.sql` and `apps/api/scripts/generate-audit-fixture.ts` do not exist. S2 shipped in-test synthetic fixtures inside `audit-log-verify.test.ts` instead.
  - **Fix:** either author the fixture + script OR add a documented-deferral row to `release-1-audit-verify-gaps.md` explaining the in-test coverage is the equivalent.
- **F-R4** — pg-boss worker shell provisioning absent from deploy runbook.
  - **Where:** `docs/release-1-deploy-runbook.md` §2 + §3 + §4 vs. ADR-0011 §3.9
  - **What:** ADR-0011 §3.9 prescribed `boss.schema_create` migration + empty worker process at deploy time. The shipped runbook ships neither.
  - **Fix:** add §2.8 "pg-boss worker shell" with the schema-create command + a §4.x Fly Machine command shipping the worker process (or document this as a deferral now that the first post-Release-1 milestone will handle it).
- **F-R9** — `apps/api/scripts/backup-restore-smoke.ts` not shipped despite ADR-0011 §3.10 S4 deliverable list. The manual drill mitigates; track for follow-up.
- **F-R11** — Recommendation public-verification page (ADR-0008 forward seam to 1.12) absent from both 1.12 deliverables and backlog. Recipients cannot verify signed PDFs outside the rep's audit chain.
- **GAP-3** — `apps/api/scripts/generate-kek.ts` missing (already self-flagged; the `node -e` fallback works but ADR-0011 §3.9 references the script).

### MEDIUM

- **F-R5** — Pen-test findings file does not exist yet; pen-test plan §12 phrasing implies it does.
- **F-R6** — ADR-0011 §3.9 migration-order text says "0001..0010" but tree is 0000..0010 (11 migrations). Off-by-one in the ADR prose only; the runbook gets it right.
- **F-R12** — pg-boss cross-process export rate limiter (ADR-0008 forward seam) absent from 1.12 backlog.
- **GAP-4** — `lifecycle-30d.json` fixture missing (already self-flagged).

### LOW

- **F-R7** — ADR-0011 §3.9 mixes `WORKPLACE_NAME` and `WORKPLACE_DISPLAY_NAME`; the code-canonical name is `WORKPLACE_DISPLAY_NAME`.
- **F-R8** — WCAG audit shipped at `docs/release-1-wcag-audit.md`, not `docs/audits/release-1-wcag-audit.md` per ADR-0011 §3.1. Cross-refs use the as-shipped path.
- **F-R13** — Service-worker rotation procedure deferral (ADR-0009) not in 1.12 backlog.
- **F-R14** — Dead-letter Prometheus metric deferral (ADR-0009) not in 1.12 backlog.
- **F-R15** — Four ADR-0010 forward seams (content_hash dedup detection, source-filename PII detector, past-30d reverse-window admin UI, `.xls` parser) not in 1.12 backlog. The reverse-window admin UI is the most operationally relevant.
- **F-R16** — `inspection_finding_redactions` table — already lumped into the "Release 2 absorbs" line; honest but coarse.

---

## Verified clean

- The five S4 GAPs in deploy runbook §11 — re-triaged: GAP-5 is a false alarm (auth.md §7 exists at line 289).
- Security checklist sign-off block is structurally complete (date / operator / initials / reviewer / reviewer-initials).
- Step-up gating coverage on every PDF/export route is explicitly enumerated in checklist §4.1–§4.8 + cross-referenced from non-negotiable #16.
- The 1.9 sec-F1 cosmetic-only step-up action-binding deferral IS explicitly captured (checklist §3.8 + ADR-0011 §"Out of scope" bullet 5).
- The backup-restore runbook is internally consistent on RTO (4h) / RPO (24h) / 30-day drill cadence / 7-day pre-deploy currency requirement.
- The S4 docs honor the Release-1-only scope discipline — no Release 2 (meeting lifecycle, reprisal, accommodation) or Release 3 (E2EE messaging, AI features) features are accidentally promised. The VAPID + AI-proxy keys are explicitly forward-seam, not feature-active.
- Cross-references between the four S4 docs resolve to existing files; section numbers cited are accurate.
- The fuzz harness ships at `packages/excel-import/test/fuzz/` (not `packages/excel-import/src/__fuzz__/` per ADR-0011 §3.5) — documented in `release-1-fuzzing-findings.md` F-1 as a structural-equivalence wrap-don't-refactor decision; acceptable.
- Pen-test plan severity ladder (P0 / P1 / P2) is consistent with the security checklist's "block deploy / fix in window / backlog" gating.

---

## Verdict

- **CRITICAL:** 4 release-blockers (2 GAPs from S4 + 2 NEW from this review). Cutover MUST NOT proceed until F-R1, F-R2, GAP-1, GAP-2 are resolved.
- **HIGH:** 5 items that should fold into an S5 follow-up bundle.
- **MEDIUM/LOW:** documentation tightening; do not block deploy if explicitly accepted as documented divergence on the security checklist.
- **Backlog ratchet:** ADR-0011's deferral list is mostly complete but missed 6 prior-ADR forward seams (F-R11..F-R16); recommend a single backlog-amend commit before close.
- **ROADMAP delta:** clean. No Release 2 / Release 3 scope bleed.

This review identifies F-R1, F-R2, GAP-1, GAP-2 as the cutover gate. F-R3, F-R4, F-R9, F-R11, GAP-3 should be addressed in the S5 close-out bundle. The remaining MEDIUM/LOW findings can ship as documented divergences with the rep's initial on the checklist.
