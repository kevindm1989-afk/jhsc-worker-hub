# ADR-0011: Release 1 Hardening (release-readiness audit + deploy preparation)

Status: Accepted, Milestone 1.12
Date: 2026-06-03
Authors: codifies Milestone 1.12 architect-phase decisions; pairs with `SECURITY.md` §8 (pre-launch checklist), `docs/release-1-security-checklist.md` (new), `docs/release-1-pentest-plan.md` (new), `docs/release-1-backup-restore-runbook.md` (new), `docs/release-1-deploy-runbook.md` (new), and the existing runbooks in `docs/runbooks/`.

## Context

Release 1 is ten feature milestones — 1.2 auth + step-up (ADR-0001), 1.3 envelope encryption + tamper-evident audit chain (ADR-0002), 1.4 legal corpus (ADR-0003), 1.5 hazards (ADR-0004), 1.6 action items (ADR-0005), 1.7 evidence capture (ADR-0006), 1.8 inspections (ADR-0007), 1.9 recommendations (ADR-0008), 1.10 offline-first sync (ADR-0009), 1.11 Excel import (ADR-0010). Each one shipped its own architect ADR + threat-modeler appendix to `SECURITY.md` §2.x + an operator runbook in `docs/runbooks/` + an independent security/privacy review. Each one closed honestly: a "post-Release-1 backlog" section enumerating the residuals the reviewer accepted as deferred — Dexie at-rest encryption (1.10 priv-F1), action-bound step-up tokens (1.9 close-out residual + 1.10 + 1.11 carry-forward), the pg-boss `sync_idempotency` TTL sweep (1.10 S1 deferred), conflict-resolution Apply pipeline (1.10 priv-F4 + sec-F3 + sec-F4), workplace key rotation (1.3 forward seam), `audit-log-verify` forward-defense flags for inspections/recommendations/excel (1.8 + 1.9 + 1.11 deferrals), Tigris orphan-ciphertext GC (1.7 deferral), and a long tail more. 1.12 is the release-gate milestone — the one that says, with operational confidence, that what's been built is what's about to be deployed and that what's deferred is documented enough for a worker rep to read a checklist and understand both what's enforced and what's accepted residual.

1.12 is structurally different from 1.2–1.11. It ships NO new feature surface — no new tables, no new audit kinds, no new API routes, no new entity types. The user authorized the milestone with explicit scope: "ROADMAP scope only." The nine ROADMAP.md 1.12 line items are the milestone (WCAG 2.2 AA audit + fixes; print stylesheets verified; security pre-launch checklist completed; penetration test plan; Excel parser fuzzing; backup + restore drill; audit log verification on full dataset; mobile flow verified on iOS Safari + Android Chrome; deploy to production). The post-Release-1 backlog enumerated in §"Consequences / Out of scope" stays deferred. The rep has authorized a 4–6 week real-world-use window between the 1.12 deploy and the start of Release 2 (per ROADMAP.md line 175); the post-deploy smoke test in the deploy runbook is the gate on that window, not a feature-completeness gate.

The operational pattern of this ADR is therefore different from the feature ADRs: there is no entity model to decide, no encryption boundary to draw, no chain-payload shape to ratify. The decisions are about METHODOLOGY (how the audit walks; what the checklist's row format is; what the fuzzing harness asserts; what the drill verifies), about ARTIFACTS (the four release-readiness documents that ship at S4), and about RESPONSIBILITIES (what the operator runs manually post-merge — the actual pen test, the actual backup drill, the actual deploy — vs. what the milestone ships as documentation + smoke-test scripts that make those operations safe).

`docs/adr/0001-auth-and-step-up.md` through `docs/adr/0010-excel-import.md` are the ten feature decisions this milestone audits. `SECURITY.md` §2.1 through §2.11 are the eleven threat sections this milestone walks. `docs/runbooks/*.md` are the nine existing operator runbooks this milestone references but does not edit (except where a hardening fix touches a documented behavior). `.github/workflows/ci.yml` is the automated portion of release-readiness (verify + e2e + docker-build jobs). `apps/web/tests/e2e/` is the existing Playwright spec set (auth-setup, offline-sync, smoke) that grows under §3.8. `apps/api/scripts/audit-log-verify.ts` is the chain verifier this milestone extends with `--full` per §3.7. `packages/excel-import/src/parser.worker.ts` is the 1.11 attack surface this milestone hardens via the fuzzing harness per §3.5. `scripts/audit-with-allowlist.mjs` is the 1.11 close-out's allowlist wrapper that defines the security model for the `xlsx@0.18.5` HIGH-advisory residual; 1.12 does not bump SheetJS (the CDN-version bump is on the post-Release-1 backlog) but the checklist re-confirms the allowlist's mitigation posture is still load-bearing. `apps/api/src/middleware/security.ts` is the security-headers + CSRF surface this milestone verifies against an OWASP baseline per §3.4. ADR-0010 (Excel import) is the closest structural precedent for "a milestone that hardens an existing attack surface," but ADR-0010 also ADDED a new entity model; ADR-0011 is verification + documentation only.

## Decision

Audit every Release 1 view against the CLAUDE.md WCAG 2.2 AA Phase 1 baseline, categorize findings as MUST-FIX-FOR-RELEASE vs. SHOULD-FIX vs. DOCUMENTED-FOR-V2, land the MUST-FIX bundle in S1 alongside print-stylesheet verification across every printable view (hazards, action items, inspections, recommendations, exports list). Produce a single `docs/release-1-security-checklist.md` with one row per non-negotiable (#1..#16) + one row per threat-model entry (T-A1..T-A16, T-AC1..T-AC9, T-LC1..T-LC?, T-H1..T-H?, T-AI1..T-AI?, T-E1..T-E?, T-I1..T-I?, T-R1..T-R?, T-S1..T-S?, T-X1..T-X54) + one "Documented residuals" section enumerating every deferred item with a "lands in [post-Release-1 milestone X]" pointer. Produce `docs/release-1-pentest-plan.md` with the OWASP ZAP target list + the manual test cases beyond ZAP coverage (step-up bypass, CSRF surface, SSRF via Tigris presign, JWT replay, SQLi on the polymorphic FK trigger, content-hash collision in Excel imports, etc.) + the runbook for triaging findings (operator runs ZAP post-merge; findings land in `docs/audits/release-1-pentest-findings.md` + are triaged against the threat model). Ship `packages/excel-import/src/__fuzz__/parser-fuzz.test.ts` — a Vitest suite that uses a deterministic seed to generate ≥1000 adversarial workbook bytes per CI run (random byte flips, oversized cells, malformed sheet headers, formula-injection payloads, BIDI control characters, recursive structure references) and asserts `parseWorkbookInWorker` either returns `{kind:'error'}` or `{kind:'unrecognized'}` cleanly — never throws an uncaught exception. Produce `docs/release-1-backup-restore-runbook.md` covering Neon snapshot + restore-to-staging procedure, Tigris bucket backup (the evidence + exports ciphertext), Fly Secrets backup (KEK + workplace key pair + JWT signing key + Tigris credentials), and chain-of-custody verification on the restored data (`audit-log-verify.ts --full` on the restored chain). Extend `apps/api/scripts/audit-log-verify.ts` with a `--full` flag that walks the entire chain (vs. the existing per-row spot-check via `verify()`), produces a structured report (chain rows per kind, gap detection, prior-milestone payload-shape recompute), and exits 0 only when every row hashes correctly + every prior-milestone-required payload field is present; CI runs this against a synthetic full-dataset fixture in `apps/api/test/fixtures/audit-log-full-dataset.sql`. Extend `apps/web/playwright.config.ts` to add the `mobile-safari` (iPhone 15 Pro device emulation + WebKit) and `mobile-chrome` (Pixel 9 device emulation + Chromium) projects alongside the existing chromium project; add mobile-viewport specs in `apps/web/tests/e2e/mobile-flow.spec.ts` covering the load-bearing flows (rep auth → first-run setup → hazard create → action-item move → inspection start + sign → recommendation submit + export → Excel import preview + commit → sync conflict resolution). The mobile specs run as part of the existing CI `e2e` job. Produce `docs/release-1-deploy-runbook.md` covering Fly.io deploy procedure (apps/api + apps/web + ai-proxy machines, ca-central-1 region) + Neon Postgres production provisioning + the migration run order (0001..0010) + Tigris bucket provisioning + SSE-AES256 + lifecycle policy + DNS + TLS + the workplace-config env var inventory + the pg-boss worker shell setup (the worker exists in production from day 1 even though the TTL sweep jobs are deferred backlog — the deploy provisions the boss schema + the empty worker process so the post-Release-1 sweeps drop in cleanly) + the rollback procedure + the post-deploy smoke test (rep signs in + first-run + captures one hazard + verifies chain row landed + checks the import-history view + checks the print stylesheet on the hazard detail). All four release-readiness documents are NEW files in `docs/`; none of the existing nine runbooks are rewritten (only cross-referenced from the new docs).

### 3.1 WCAG 2.2 AA audit methodology

The audit walks every Release 1 view against the CLAUDE.md "Accessibility (WCAG 2.2 AA Baseline — Phase 1)" rules: keyboard nav for every interactive element, visible focus indicators (2px ring, accent color), semantic HTML before ARIA, color contrast ≥4.5:1 text + ≥3:1 UI, no information by color alone, form errors announced to screen readers, skip-to-content in app shell, `prefers-reduced-motion` respected. The audit produces `docs/audits/release-1-wcag-audit.md` (NEW under existing `docs/audits/` directory) with one row per view × one column per WCAG criterion + the finding text + the category (MUST-FIX-FOR-RELEASE / SHOULD-FIX / DOCUMENTED-FOR-V2).

**Per-view walk.** Eight shipped feature surfaces, each with the views the rep encounters daily:

- **Auth (1.2):** sign-in view, first-run setup wizard, step-up modal, recovery-code reveal screen, passkey enrollment flow.
- **Hazards (1.5):** list view, detail view, create form, reveal view, status-transition affordances.
- **Action items (1.6):** minutes board (the canonical multi-section view), detail view, create form, the section-move swipe/drag interaction, the Action Flag indicator strip.
- **Evidence (1.7):** capture-to-record floating action button, list view, reveal view (the step-up-gated decrypt), the EXIF-strip preview.
- **Inspections (1.8):** template picker, conduct flow (zone-by-zone walk-through), finding entry, signature capture, export view, history view.
- **Recommendations (1.9):** drafting view (long-form text editor + citation picker), Adversarial Lens panel, submit flow, export view.
- **Offline-sync (1.10):** sync-status chip, sync-status view, three-way merge conflict view, dead-letter view, PWA install modal (web + iOS Add-to-Home-Screen variant).
- **Excel import (1.11):** upload view (file picker + drag-drop), preview view (four collapsible sections + per-row edit panel + PII summary), import-history view, reverse confirmation modal.

**Category definitions.**

- **MUST-FIX-FOR-RELEASE:** a Phase-1 baseline violation that blocks a rep using assistive tech from completing a critical flow. Examples: a form input with no label; a status indicator that uses color alone with no icon/text; a focus indicator under 2px or invisible against the background; a modal without an `aria-modal` + focus-trap; a keyboard trap. These land as small fixes in S1.
- **SHOULD-FIX:** a Phase-1 deviation that degrades the experience but does not block a flow. Examples: a section heading that uses `<div>` instead of `<h2>`; a tooltip without a keyboard-accessible alternative; a non-critical decorative icon without `aria-hidden`. These land in S1 if the fix is mechanical; else they move to DOCUMENTED-FOR-V2.
- **DOCUMENTED-FOR-V2:** a deviation that requires structural rework (e.g., the minutes-board swipe interaction's keyboard equivalent — desktop drag works; mobile swipe is touch-only; the keyboard equivalent for the same operation is a tray of "move to section X" buttons that needs design work). These land in the security checklist's "Documented residuals" section with a "lands in Release 2.x" pointer.

**No automated-only audit.** The audit uses `axe-core` via `@axe-core/playwright` as a scanning aid (run once per view via a new `apps/web/tests/a11y.spec.ts`) but the manual walk is the authoritative pass. Screen-reader testing covers VoiceOver on iOS Safari + TalkBack on Android Chrome + NVDA on desktop Firefox. The audit document records the assistive-tech configuration used per view.

**Fix bundle posture.** All MUST-FIX-FOR-RELEASE findings land in S1 as small, focused commits — one commit per view (or a small handful per feature surface). No structural rework; the fixes are aria-label additions, focus-ring CSS adjustments, color-contrast tweaks against the design tokens, screen-reader announcement wiring on form-error surfaces. The design tokens (`packages/ui/src/tokens.ts`) are NOT modified unless a contrast finding forces a token-level change; in that case the change is the smallest possible diff and is documented in the audit's "design-system implications" section.

### 3.2 Print stylesheet verification methodology

CLAUDE.md design rules: "Print stylesheet for every printable view — evidence-grade output." The 1.5–1.11 feature ADRs each declared print-stylesheet coverage as a quality-bar item; 1.12 verifies the existing `@media print` rules cover the canonical pattern and lands fixes for any gaps.

**Canonical print pattern** (per CLAUDE.md design rules + ARCHITECTURE.md §8): Source Serif 4 for body text; hide chrome (top bar, bottom tab bar, action buttons, swipe affordances); expand collapsible sections; `page-break-inside: avoid` for cards + table rows + section headings; print-only metadata header (workplace name from `config/workplace.ts`, generated-at timestamp, chain-anchor idx); page footer with page number + document hash (per non-negotiable #16 for exports).

**Per-view verification.** Five printable surfaces:

- **Hazards detail (1.5):** revealed plaintext + status history + chain-anchor footer.
- **Action items detail + minutes board (1.6):** the canonical minutes printout — four sections, action items grouped, Action Flag indicators preserved (the emoji exception per CLAUDE.md design rules), chain footer.
- **Inspection report (1.8):** the PDF-export equivalent rendered on screen for the rep to preview before exporting; the export PDF itself is generated server-side per ADR-0007 but the browser-side print stylesheet must match its layout so a rep printing from the browser produces evidentiarily-equivalent output.
- **Recommendation document (1.9):** the long-form Source-Serif-4 print layout with citation footnotes + chain footer (per ADR-0008).
- **Excel-import history detail (1.11):** the per-import provenance row (source SHA-256 + counts + reverse-window status + chain-anchor idxs) for audit purposes.

Each view's stylesheet is verified via a Playwright spec that calls `page.emulateMedia({ media: 'print' })` and asserts the chrome is hidden + the expected print-only metadata is visible + the page-break rules are applied. Gaps land as small CSS fixes in S1. The verification spec lives in `apps/web/tests/e2e/print.spec.ts` and runs in the existing `e2e` CI job.

### 3.3 Security pre-launch checklist shape

`docs/release-1-security-checklist.md` is the single sign-off artifact. Three sections:

**Section A — Non-negotiables (#1..#16).** One row per non-negotiable. Each row has four columns: the non-negotiable number, the rule text, the enforcement mechanism (the file + function or the document that implements it), and the verification step (the test or the operator action that confirms enforcement). Example row:

> | #   | Rule                                                                                       | Enforcement                                                                                                                                                                                                                           | Verification                                                                                                                                                                                                                                    |
> | --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | #11 | Excel imports parsed in browser; sensitive fields encrypted client-side before server sync | `packages/excel-import/parser.worker.ts` (Web Worker, no Node deps) + `apps/web/src/excel-import/upload-view.tsx` (sealed-box encrypt under workplace public key from `/api/auth/session`) + ADR-0010 §3.1 (workspace-shape contract) | Integration test `packages/excel-import/test/no-network.test.ts` (Vitest grep-the-bundle for `fetch`/`XMLHttpRequest`); manual operator step — capture a TLS dump during an import and confirm only ciphertext + non-PI metadata cross the wire |

**Section B — Threat model entries (T-A1..T-X54).** One row per threat from `SECURITY.md` §2.1..§2.11. Same four-column shape. The "Enforcement" column points at the ADR subsection + the code that implements the mitigation; the "Verification" column points at the test or the operator step that confirms the mitigation is still load-bearing. Roughly 150 rows total across the eleven threat sections.

**Section C — Documented residuals (post-Release-1 backlog).** One row per deferred item (the full list enumerated in §"Consequences / Out of scope"). Each row carries: the residual description (cribbed from the source ADR's "Negative tradeoffs" or "Risks"), the source ADR + the source threat model entry, the accepted-risk reasoning, and a "lands in [post-Release-1 milestone X]" pointer. A rep reading this section sees both what's enforced and what's known-deferred — there are no silent residuals.

**Sign-off shape.** The document ends with an explicit "operator sign-off" block: a single line for the operator (the rep, in single-tenant scope) to date + initial + confirm "I have read every row of Sections A, B, and C; I accept the residuals enumerated in Section C; I authorize Release 1 deploy." This is documentary, not legal — it exists so the rep has a moment of explicit acknowledgement that they understand what they're deploying.

**Cross-reference with SECURITY.md §8.** The existing SECURITY.md §8 pre-launch checklist is a short list of high-level confirmations ("all sensitive fields encrypted at application layer", "audit log verification passes on full dataset", etc.). The 1.12 checklist is the granular expansion. §8 stays as the summary; the new document is the detail. A line in §8 points at the new document.

### 3.4 Penetration test plan

`docs/release-1-pentest-plan.md` documents the target list + the manual test cases + the triage runbook. The actual pen test runs post-merge; the milestone ships the plan + the runbook.

**OWASP ZAP target list.** Active scan against:

- `https://<api-host>/api/*` — every documented route, with the rep's session cookie pre-loaded so authenticated paths are reachable. ZAP's "Form-Based Auth" config uses the password+TOTP fallback path (the passkey path is not scriptable from ZAP).
- `https://<web-host>/*` — the SPA's served HTML + static assets + the manifest + the service-worker file. Passive scan on the response headers + a small active scan against the auth endpoints exposed at `/api/auth/*`.

**Manual test cases beyond ZAP.** ZAP catches the common surfaces (header presence, header values, redirect chains, basic injection patterns, missing CORS). The manual cases are the surfaces ZAP cannot reach without app-specific knowledge:

- **Step-up bypass attempts.** Replay a step-up token across a different `action` value (per the honest stance from ADR-0009 §3.6 + ADR-0010 §3.10 — action-binding is cosmetic until post-Release-1 lands action-bound tokens; the 60s freshness check is the real defense; the manual test confirms a stale grant for `evidence.decrypt` does not satisfy a follow-up `inspection.export`).
- **CSRF surface.** Cross-origin POST against every mutation route with no `X-Requested-With: jhsc-web` header; confirm 403 `csrf_blocked` on every route (per `apps/api/src/middleware/security.ts`).
- **SSRF via Tigris presign.** The presigned-URL handler issues URLs against the Tigris bucket; the manual test attempts to coerce the presigner into signing a URL against an attacker-controlled S3 bucket or the Fly Machine's internal metadata service.
- **JWT replay.** Capture a session JWT, replay against a different IP / a different User-Agent (the session row's IP + UA are stamped at issue per 1.2; the manual test confirms replay across IPs is detected and logged via `auth.session_anomaly`).
- **SQL injection on the polymorphic FK trigger.** ADR-0007 §3.7 + ADR-0008 §3.5 land a polymorphic-FK trigger on `action_items.linked_type + linked_id`; the manual test attempts payloads in the `linked_id` field (UUID-shaped strings with semicolons + comment markers) to confirm the trigger rejects malformed types and parameterized queries hold.
- **Content-hash collision in Excel imports.** Per T-X20 in ADR-0010 — the manual test crafts two workbooks with identical `sha256(canonical(description||start_date))` (computationally infeasible at SHA-256 scale, but the test asserts the reconciler's documented behavior on the structurally-impossible collision case is "treat as same item, surface as conflict_pending if any field differs").
- **Service-worker scope abuse.** A test page on a same-origin path attempts to register a competing service worker; confirm the registered SW's scope is `/` and a competing registration is rejected.
- **Idempotency-Key replay against a different user.** Per 1.10 sec-F3 close-out — replay a captured Idempotency-Key against a different session; confirm the `(key, user_id)` cache key isolates per-user.
- **Workplace public key tampering.** The browser fetches the workplace public key from `/api/auth/session`; a man-in-the-middle test confirms HSTS + cert-pinning (the SW caches the key under integrity-checked storage) prevents key substitution.
- **Excel parser worker plaintext leakage across imports.** Per T-X3 + T-X4 close-out — after a parse, the worker is `worker.terminate()`'d (per ADR-0010 §3.2); the manual test confirms a follow-up parse with a different file does not see residual plaintext from the prior parse.

**Triage runbook.** The plan documents the post-scan workflow: ZAP findings export to `docs/audits/release-1-pentest-findings.md`; each finding is triaged against the threat model (existing T-# entry → mitigation already documented; new finding → new T-# entry + mitigation; false positive → documented as such with reasoning); HIGH + CRITICAL findings block deploy; MEDIUM findings land as fixes within the 4–6 week window; LOW + INFO findings land in the post-Release-1 backlog.

**1.12 does NOT run the actual pen test.** The operator runs ZAP post-merge against the deployed staging environment (the deploy runbook §3.9 covers staging provisioning). The milestone artifact is the plan + the runbook. The 1.12 acceptance gate does not depend on a clean pen-test report; it depends on the plan + runbook existing + the operator's sign-off in the security checklist that they will run the scan post-deploy.

### 3.5 Excel parser fuzzing harness

`packages/excel-import/src/__fuzz__/parser-fuzz.test.ts` is a Vitest suite that hardens the 1.11 attack surface against malformed inputs. The harness is deterministic-seeded (`Math.seedrandom`-style or a small PRNG embedded in the test file) so CI runs are reproducible; the seed is per-CI-run from the commit SHA so each CI run gets fresh coverage while staying reproducible from the SHA alone.

**Adversarial-workbook generator.** A pure function `generateAdversarialWorkbook(seed, scenario)` produces an `ArrayBuffer` whose bytes vary by scenario:

- **Random byte flips** against a valid baseline workbook (the parser fixture from 1.11). 1% byte-flip rate; 100 iterations per seed.
- **Oversized cells** — a workbook with a single cell containing 9KB / 12KB / 100KB of text (per T-X11; the 8KB cap is the documented bound).
- **Malformed sheet headers** — a workbook where the `NEW BUSINESS` sheet's first-row column headers carry random Unicode replacement characters / null bytes / extreme-length strings.
- **Formula-injection payloads** — a workbook where cells contain `=HYPERLINK("http://attacker/", "click")`, `=cmd|'/C calc'!A0`, `@SUM(...)`, `+1+1`, DDE-style payloads (per T-X5; the parser's `cellFormula: false` is the documented mitigation).
- **BIDI control characters** — cells containing U+202E / U+202D / U+2066–U+2069 LRO/RLO/LRI/RLI/FSI/PDI sequences that could spoof the rep's read of the cell content in the preview.
- **Recursive structure references** — a workbook whose `xl/sharedStrings.xml` references its own indices in a self-referential loop (the underlying ZIP structure parsing — SheetJS's hardened parser is the documented defense).
- **Truncated archives** — a workbook with a valid ZIP header but a truncated central directory.
- **Mixed-case sheet names beyond the documented tolerance** — sheet names with combining diacritics / unusual case-folding cases (per T-X7; the detector's case-insensitive match is the documented behavior).

**Assertion contract.** For every generated workbook, `parseWorkbookInWorker(buffer)` must resolve to one of:

- `{kind: 'recognized', schema: 'meeting_minutes', version: 'v1', sheets: ParsedSheets, rawSha256: string}` — when the random bytes happen to produce a recognizable workbook (rare; most flips break recognition).
- `{kind: 'unrecognized', reason: string}` — the schema detector's documented fail-closed (the most common outcome).
- `{kind: 'error', message: string}` — a parse-level error surfaced through the worker's structured-clone result envelope.

The harness asserts the parser NEVER throws an uncaught exception. A thrown exception fails the test and surfaces in CI with the seed + scenario + the byte-buffer hex of the offending workbook so the failure is reproducible.

**Iteration count.** 1000 cases per CI run (100 per scenario × 10 scenarios). The harness is bounded — it does not run forever; it does not depend on flaky randomness; it produces a deterministic pass/fail per seed. The Vitest config gives the harness a 60-second timeout; at single-tenant scale, 1000 parses complete in well under that.

**The harness lives inside the workspace** (`packages/excel-import/src/__fuzz__/`) rather than in `apps/web/tests/` because the parser is workspace-scoped and the Vitest discovery already covers `packages/*/src/**/*.test.ts`. The CI `verify` job (which runs `pnpm test`) picks the harness up without a new pipeline step.

**Beyond 1.12, fuzzing is operational hygiene.** The runbook (SECURITY.md §9, existing) already calls for quarterly re-fuzzing against the latest SheetJS version. The 1.12 milestone seeds the harness; the operational cadence keeps it relevant.

### 3.6 Backup + restore drill runbook

`docs/release-1-backup-restore-runbook.md` documents the procedure + ships a smoke-test script. The actual drill runs post-merge by the operator; the milestone documents how to run it safely.

**Postgres backup procedure.** Neon's branch-based snapshot is the primary mechanism; the runbook documents:

1. Create a Neon point-in-time branch from production (`neonctl branches create --name=restore-drill-$(date +%Y%m%d)`).
2. Restore the branch to a staging Fly Machine connection string.
3. Run `apps/api/scripts/audit-log-verify.ts --full` against the staging branch (per §3.7 — the chain on the restored branch must verify identically to the chain on production).
4. Confirm the row counts match across `audit_log`, `users`, `hazards`, `action_items`, `inspections`, `inspection_findings`, `recommendations`, `evidence_files`, `excel_imports`, `excel_import_items`.
5. Tear down the Neon branch (`neonctl branches delete restore-drill-$(date +%Y%m%d)`).

**Tigris bucket backup.** The evidence + exports ciphertext lives in Tigris. The runbook documents:

1. The bucket's versioning is enabled at provision time (per the deploy runbook §3.9) so accidental deletes are recoverable by version.
2. A weekly cold-storage copy to a separate Tigris bucket (a different account if budget allows; same account with a different bucket name otherwise) via `rclone sync` from a Fly Machine.
3. Restore is per-object recovery from version history OR full-bucket restore from cold storage; the runbook covers both.

**Fly Secrets backup.** The KEK + workplace key pair (public on disk, private in Fly Secrets) + JWT signing key + Tigris credentials + VAPID keys all live in Fly Secrets. The runbook documents:

1. The operator-only `fly secrets list` command + a manual cold-storage backup (printed paper in a sealed envelope OR an encrypted USB key in a physical safe). The rep is single-tenant; the secrets backup is single-rep custody.
2. The cold-storage backup is generated at deploy time + after any key rotation (workplace key rotation is on the post-Release-1 backlog; until then the rotation is a fresh deploy).
3. Loss of the KEK is catastrophic — every encrypted column in Postgres becomes opaque ciphertext. The runbook says this plainly + documents the operator's obligation to maintain the cold-storage backup.

**Chain-of-custody verification on restored data.** After a restore, the operator runs `audit-log-verify.ts --full` (per §3.7) against the restored database. The chain must verify identically; any divergence is a tamper signal (or a restore-procedure bug). The runbook documents the expected output + the failure-recovery procedure.

**Smoke-test script.** `apps/api/scripts/backup-restore-smoke.ts` is a Bun script that:

1. Connects to a staging DATABASE_URL.
2. Runs `audit-log-verify.ts --full` programmatically.
3. Issues a read against each entity table (`hazards`, `action_items`, etc.) + asserts a non-zero row count.
4. Issues a read against the workplace public key endpoint + confirms the key matches the expected fingerprint from Fly Secrets.
5. Exits 0 on success, 1 on any check failing, 2 on operational error (DB unreachable, etc.).

The script is shipped in the milestone; the actual drill is operator-run.

### 3.7 Audit log verification on full dataset

`apps/api/scripts/audit-log-verify.ts` already supports `--quiet`, `--check-backfill`, `--check-evidence`, `--check-sync`. 1.12 adds `--full`.

**`--full` flag behavior.** Walks the entire `audit_log` table from idx=0 to MAX(idx), recomputes `this_hash` for every row, and produces a structured report:

```json
{
  "ok": true,
  "rowCount": 12345,
  "highestIdx": 12344,
  "rowsByKind": {
    "auth.signin": 234,
    "hazard.created": 56,
    "action_item.created": 1234,
    "action_item.updated": 567,
    "action_item.moved": 89,
    "inspection.started": 12,
    "inspection.exported": 3,
    "recommendation.submitted": 8,
    "recommendation.exported": 5,
    "evidence.uploaded": 78,
    "excel_import.uploaded": 4,
    "excel_import.committed": 3,
    "excel_import.reversed": 0
  },
  "gaps": [],
  "payloadShapeMismatches": [],
  "durationMs": 4521
}
```

The `gaps` array is non-empty if any idx is missing (per existing T-AC3 — the existing `verify()` walks idx ASC; the `--full` flag surfaces gaps explicitly rather than failing on the first one). The `payloadShapeMismatches` array is non-empty if any row's payload is missing a field that the chain-kind's documented payload schema requires (per the per-milestone "PI-clean by construction" framing — e.g., `excel_import.uploaded` requires `{importId, sourceSha256, rowCount, schemaVersion}`; a row missing `sourceSha256` is a shape-mismatch).

**Synthetic full-dataset fixture.** `apps/api/test/fixtures/audit-log-full-dataset.sql` is a SQL dump that recreates a chain with ≥1000 rows covering every chain-kind landed in 1.2–1.11. The fixture is generated by a one-shot script (`apps/api/scripts/generate-audit-fixture.ts`) that walks the production chain (anonymized — IDs randomized, ciphertext zero-filled) and produces the SQL. The fixture is committed to the repo; CI runs `audit-log-verify.ts --full` against the fixture as part of the `verify` job.

**Exit codes.** 0 = chain verified + all checks pass; 1 = tamper detected OR gap found OR payload-shape mismatch; 2 = operational error.

**Backward compatibility.** The existing flags (`--quiet`, `--check-backfill`, `--check-evidence`, `--check-sync`) work unchanged. `--full` can be combined with `--quiet` for CI-friendly output. The default invocation (no flags) keeps the existing per-row spot-check behavior so daily cron jobs do not slow down.

**Why this is verification, not feature.** No new chain-kind, no new column, no new payload-shape requirement. The flag walks the chain that's already there. The "no new audit kinds" guardrail from the scope brief is honored — the milestone does not introduce a kind; it verifies the kinds that exist.

### 3.8 Mobile flow Playwright specs

`apps/web/playwright.config.ts` currently has a single `chromium` (Desktop Chrome) project (the comment in the file explicitly notes mobile + WebKit projects "land in Milestone 1.12 — Release 1 hardening — when device coverage matters for shipping"). 1.12 lands them.

**Config extension.** Three projects:

- `chromium` (existing) — Desktop Chrome viewport, runs the existing smoke + offline-sync + auth-setup specs.
- `mobile-safari` (NEW) — `devices['iPhone 15 Pro']` (WebKit + iOS Safari UA + 393×852 viewport + touch). Runs the new mobile-flow spec.
- `mobile-chrome` (NEW) — `devices['Pixel 9']` (Chromium + Android Chrome UA + 412×915 viewport + touch). Runs the new mobile-flow spec.

The existing specs (`smoke.spec.ts`, `offline-sync.spec.ts`, `auth-setup.spec.ts`) stay on `chromium` only; the new mobile specs run on both `mobile-safari` and `mobile-chrome`. The CI `e2e` job installs WebKit + Chromium browsers (`pnpm --filter @jhsc/web exec playwright install --with-deps chromium webkit`).

**`apps/web/tests/e2e/mobile-flow.spec.ts`** — the load-bearing flows under mobile-viewport + touch + mobile UA. The spec walks the rep's daily journey end-to-end:

1. **Sign in (1.2).** Password + TOTP fallback path (passkey-on-Playwright is not yet supported; the password+TOTP path is the universal one). Confirm the sign-in form fits the 393px viewport without horizontal scroll + the touch targets are ≥44pt + the keyboard activation does not break layout.
2. **First-run setup (1.2).** Walks the wizard — workplace identity (env-driven; the test uses the test-fixture workplace), first user creation, passkey enrollment skip, TOTP enrollment. Confirms `first_run_completed_at` lands.
3. **Hazard create (1.5).** Floating action button → capture-to-record (the camera intent is mocked at the Playwright level since real camera access is not scriptable); confirms the hazard lands in the list view + the chain anchor fires.
4. **Action-item move (1.6).** Swipe-left on a minutes-board card to move from `new_business` to `old_business`; confirms the swipe interaction lands + the `action_item.moved` chain row fires + the from/to state is in the chain payload.
5. **Inspection start + sign (1.8).** Pick a template; walk the zone-by-zone flow with a finding entered in one zone; sign as inspector; confirm the inspection lands at `status='signed'` + the chain anchor fires + the template version is pinned per non-negotiable #13.
6. **Recommendation submit + export (1.9).** Draft a recommendation against a corpus clause; insert a citation via the picker; submit; step-up gated export to PDF; confirm the chain anchors fire in order (`recommendation.submitted` → `recommendation.exported`) + the export document hash is recorded per non-negotiable #16.
7. **Excel import preview + commit (1.11).** Upload a fixture workbook from the file-picker; confirm the preview renders + the per-row sections collapse correctly on a 393px viewport + the per-row edit affordance opens + the step-up-gated commit lands + the import-history view shows the new row.
8. **Sync conflict resolution (1.10).** Trigger an offline write; toggle network back on; cause a conflict (the spec pre-populates a conflicting server-side row); confirm the three-way merge view renders correctly on mobile + the rep can resolve the conflict via touch.

**Per-flow assertions cover the mobile-primary specifics:**

- Touch targets ≥44pt (measured via `element.boundingBox()` comparisons).
- Sticky bottom primary action visible on every form (per CLAUDE.md mobile-primary patterns).
- Bottom tab bar visible + active-state correct (not the desktop left sidebar).
- Pull-to-refresh works on list views.
- The print stylesheet renders correctly at the mobile-print viewport (the print spec from §3.2 also runs at the mobile projects).

**iOS Safari particulars.** The spec accounts for the documented iOS Safari quirks: the PWA install path is the share-sheet → Add to Home Screen modal (not a programmatic install per ADR-0009 §3.13), the Service Worker scope behavior is iOS-17-specific, the WebAuthn passkey flow is unscripted but the password+TOTP fallback works.

**Android Chrome particulars.** The spec covers the programmatic PWA install path + the Chrome-specific Service Worker behavior + the address-bar URL hiding when the PWA is installed.

The specs run in CI as part of the existing `e2e` job (no new job; the `pnpm --filter @jhsc/web test:e2e` invocation runs all projects).

### 3.9 Deploy runbook

`docs/release-1-deploy-runbook.md` documents the full deploy procedure. The actual deploy runs post-merge by the operator; the milestone documents how to run it safely.

**Fly.io deploy procedure.** Three Fly Machines in `ca-central-1` (Toronto YYZ primary per CLAUDE.md tech-stack lock):

1. **`apps/api` machine.** Hono + Bun + Drizzle, runs on port 3000. Health check at `/api/health`. Scaling: single machine at single-tenant scale; auto-scaling deferred.
2. **`apps/web` machine.** Serves the React PWA static bundle + the vite-plugin-pwa-generated service worker. Could be served from Tigris + a CDN; the runbook documents both options and recommends the Fly Machine for the initial deploy (simpler ops; no CDN cache invalidation).
3. **`apps/ai-proxy` machine.** Holds the Anthropic API key per CLAUDE.md tech-stack. Inactive at Release 1 (no AI features ship; the proxy exists for the Release 3 Adversarial Lens). Provisioned at deploy time so the post-Release-1 milestones don't need a deploy churn.

The runbook documents the `fly.toml` per machine, the env var inventory, and the deploy command (`fly deploy --app jhsc-api` etc.).

**Neon Postgres production provisioning.** A new Neon project + a `production` branch + a single role for the API + a read-only role for the audit-verify cron. The migration run order is 0000..0010 in sequence — 11 migrations total, starting at `0000_auth_baseline.sql` and ending at `0010_excel_import.sql` (per S5 M-6 / F-R6 correction; the previous "0001..0010" wording was off by one). The runbook documents the migration command + the post-migration verification (the genesis row at idx=0 + the backfill anchor at idx=1 per ADR-0002).

**Tigris bucket provisioning.** Two buckets — `evidence-prod` and `exports-prod` — with SSE-AES256 enabled + versioning enabled + a lifecycle policy that retains versions for 30 days (matching the 1.11 reverse window). The bucket-creation command + the IAM credentials provisioning (the Tigris-generated access key + secret) + the credential storage in Fly Secrets are documented.

**DNS + TLS.** The production hostnames (`<rep-chosen-domain>` for the web app; `api.<domain>` for the API) + the Fly DNS configuration + the Let's Encrypt cert provisioning via Fly + the HSTS preload submission process (per SECURITY.md §8 — HSTS preload is on the pre-launch checklist). The runbook documents the "first-run before public DNS cutover" requirement per ADR-0001 T-A11 (the first-run route claims the co-chair account; exposing the hostname before first-run runs gives any attacker who reaches the URL first the ability to claim the account).

**Workplace-config env var inventory.** Per non-negotiable #1, the workplace identity lives in env vars loaded into `config/workplace.ts` at runtime. The inventory:

- `WORKPLACE_NAME` — the workplace display name (rendered in chrome + on print stylesheets).
- `WORKPLACE_JURISDICTION` — `ON-OHSA` or `CA-FED` (drives the s.9(21) clock semantics + the citation picker's corpus filter).
- `WORKPLACE_CO_CHAIR_DISPLAY_NAME` — optional display name for the co-chair.
- `WORKPLACE_TIMEZONE` — IANA tz string (`America/Toronto` for ON-OHSA; site-specific for CA-FED).
- The full list with descriptions + sample values + the "never commit these to git" warning is in the runbook.

**pg-boss worker setup.** Per ADR-0009 §"Follow-ups", the post-Release-1 milestones land the `sync_idempotency` TTL sweep + the dead-letter retry sweep + the legal-corpus snapshot refresh + the Tigris bucket orphan-ciphertext GC, all as pg-boss jobs. 1.12 provisions the pg-boss schema + the empty worker process so those sweeps drop in cleanly. The runbook documents:

1. The pg-boss `boss.schema_create` migration runs as part of the deploy (it's a separate migration outside the Drizzle 0001..0010 sequence).
2. The worker process is a separate Fly Machine command (`bun run apps/api/src/workers/index.ts`) that runs alongside the API but processes jobs from the `boss` schema.
3. Zero jobs are registered in 1.12; the worker idles. Post-Release-1 milestones register jobs as they ship.

**Rollback procedure.** If the deploy fails or the post-deploy smoke test fails, the rollback is:

1. `fly deploy --image <previous-image-sha>` to roll the API + web machines back to the prior known-good image.
2. The migration is one-way (Drizzle migrations are append-only per CLAUDE.md "migrations are append-only"); a rollback of the schema is NOT automated. If a 1.12-introduced migration breaks something, the operator runs a manually-crafted rollback migration. The runbook documents this as a "rare but possible" path — at single-tenant scale, the operator has full DB access and can write a one-shot fix migration.
3. The Tigris buckets are versioned; any objects written by the failed deploy can be reverted via version restore.

**Post-deploy smoke test.** A short manual procedure the operator runs after the deploy completes:

1. Sign in (passkey if enrolled; password+TOTP otherwise).
2. Complete first-run setup if this is the very first deploy (the test environment's first-run-completed-at is null on a fresh DB).
3. Capture one hazard via the floating action button.
4. Verify the hazard appears in the list view.
5. Open the hazard detail; confirm the chain anchor's idx is monotonically allocated + the reveal path works (the rep's plaintext is decryptable via the step-up-gated route).
6. Open the import-history view (empty on first deploy; confirms the route renders).
7. Print the hazard detail (browser-side print preview); confirm the print stylesheet renders the canonical pattern (Source Serif 4, hidden chrome, chain footer).
8. Sign out.

The smoke test is a manual procedure; the runbook documents each step + the expected outcome.

**The 4–6 week real-world-use window.** Per ROADMAP.md line 175, the rep uses the deployed app for 4–6 weeks before Release 2 starts. The deploy runbook calls this out explicitly: the post-deploy smoke test gates the start of the window; any HIGH-or-CRITICAL finding from the operator-run pen test (§3.4) within the window pauses Release 2 planning; the rep's daily use produces real audit-log volume that the daily cron-run of `audit-log-verify.ts` (per SECURITY.md §9) covers.

### 3.10 Slice plan

- **S0 — architect + threat-modeler.** This ADR + a `SECURITY.md` §2.12 "Release 1 Hardening" pass enumerating the verification surfaces (the threat-modeler appends short rows confirming each prior section's mitigations are still load-bearing post-audit + flagging any newly-surfaced threats from the WCAG audit's findings or the pen-test plan; the existing §2.1..§2.11 threats are unchanged in payload, only re-confirmed). The S0 commit pattern matches prior milestones — commit ADR + threat-model artifact together; no PR yet.
- **S1 — WCAG audit + fixes + print stylesheet checks.** `docs/audits/release-1-wcag-audit.md` produced per §3.1 methodology; MUST-FIX-FOR-RELEASE findings landed as small commits per view (one commit per view or a small handful per feature surface); `apps/web/tests/a11y.spec.ts` added as the automated scanning aid; `apps/web/tests/e2e/print.spec.ts` added per §3.2 (one spec per printable view × the canonical print pattern assertions). Design tokens unchanged unless a contrast finding forces a token-level change; in that case the change is the smallest possible diff. SHOULD-FIX findings landed if mechanical; else deferred to the audit document's "Documented residuals" section.
- **S2 — Excel parser fuzzing harness + audit-log-verify --full flag.** `packages/excel-import/src/__fuzz__/parser-fuzz.test.ts` per §3.5 (deterministic-seed adversarial workbook generator + 1000 cases per CI run + the assertion contract). `apps/api/scripts/audit-log-verify.ts` extended with `--full` per §3.7; `apps/api/test/fixtures/audit-log-full-dataset.sql` committed; `apps/api/scripts/generate-audit-fixture.ts` shipped (the fixture-generator script is the developer-side tool; the fixture is the CI-side input). CI `verify` job runs both the harness + the `--full` check against the fixture as part of `pnpm test`.
- **S3 — mobile Playwright specs.** `apps/web/playwright.config.ts` extended per §3.8 (the `mobile-safari` and `mobile-chrome` projects). `apps/web/tests/e2e/mobile-flow.spec.ts` ships the load-bearing flows. CI `e2e` job installs WebKit + Chromium browsers; runs all projects. The existing `smoke.spec.ts` + `offline-sync.spec.ts` + `auth-setup.spec.ts` stay on chromium only (no point in re-running them across all projects; the new mobile-flow spec is the cross-project coverage).
- **S4 — release-readiness docs.** Four new files in `docs/`:
  - `docs/release-1-security-checklist.md` per §3.3 (Sections A + B + C + operator sign-off block).
  - `docs/release-1-pentest-plan.md` per §3.4 (OWASP ZAP target list + manual test cases + triage runbook).
  - `docs/release-1-backup-restore-runbook.md` per §3.6 (Postgres + Tigris + Fly Secrets procedure + chain-of-custody verification + smoke-test script reference).
  - `docs/release-1-deploy-runbook.md` per §3.9 (Fly + Neon + Tigris + DNS + env vars + pg-boss + rollback + post-deploy smoke test).
    Plus the smoke-test script `apps/api/scripts/backup-restore-smoke.ts`. The existing nine runbooks in `docs/runbooks/` are NOT rewritten; they are cross-referenced from the new docs.
- **S5 — final review + sign-off.** Independent reviewer pass over the four release-readiness docs + the WCAG audit + the fuzzing harness + the mobile specs. The reviewer confirms: (a) every non-negotiable has a row in the security checklist; (b) every threat-model entry has a row; (c) every deferred item has a "lands in [post-Release-1 milestone X]" pointer; (d) the deploy runbook covers every machine + every secret + every env var; (e) the rollback procedure is exercisable. Findings land as small fixes; the milestone closes with the operator's sign-off on the security checklist.

## Consequences

### Positive

- **Release-readiness is a sign-off artifact, not a gut feeling.** The security checklist is concrete: 16 non-negotiable rows + ~150 threat rows + N residual rows + the operator's dated initial. The rep can read it from top to bottom, understand both what's enforced and what's accepted residual, and sign off explicitly. A reviewer six months later (an arbitrator, an MLITSD inspector, a successor co-chair) can read the same document.
- **Every shipped view is WCAG 2.2 AA verified.** The MUST-FIX bundle lands in S1; the SHOULD-FIX bundle lands where mechanical; the DOCUMENTED-FOR-V2 list is honest. The rep using assistive tech is not blocked from any critical flow.
- **The Excel parser attack surface is structurally bounded.** The fuzzing harness asserts the no-uncaught-throw contract across 1000 adversarial cases per CI run. The 1.11 threat model entries T-X3, T-X5, T-X6, T-X7, T-X9, T-X10, T-X11, T-X12, T-X15 — all of which describe parser robustness against malformed input — are now under active CI coverage rather than relying on the per-fixture unit tests alone.
- **The audit chain is verified end-to-end.** The `--full` flag walks every row; the synthetic fixture is the CI regression check; the per-deploy verification (the runbook step) is the production regression check. Tamper is detected, not assumed-absent.
- **Mobile-primary is verified, not asserted.** The mobile Playwright specs cover iOS Safari + Android Chrome on the load-bearing flows. A regression that breaks the 393px viewport or a touch interaction surfaces in CI before it reaches the rep.
- **The deploy is documented in the granular detail that single-tenant deploys require.** Fly + Neon + Tigris + Fly Secrets + DNS + the env var inventory + the migration order + the rollback + the post-deploy smoke. The operator (the rep) running the deploy has a step-by-step procedure; no tribal knowledge.
- **The 4–6 week real-world-use window is structured.** The deploy runbook's post-deploy smoke gates the window's start; the daily cron-run of `audit-log-verify.ts` covers the window's audit-chain health; any HIGH-or-CRITICAL pen-test finding within the window pauses Release 2 planning. The window is documented + gated, not vague.
- **No regression on prior milestones.** The 1.12 changes (WCAG fixes, print stylesheet fixes, mobile spec additions, fuzzing harness, `--full` flag, runbook docs) introduce ZERO new audit kinds, ZERO new tables, ZERO new API routes, ZERO new encryption boundaries. The chain payload contract is unchanged. The full-dataset audit-log-verify is the regression backstop.

### Negative / accepted tradeoffs

- **The pen test is operator-run, not CI-run.** The milestone ships the plan + the runbook; the actual scan runs post-merge against the deployed staging environment. The mitigation is the runbook's explicit triage procedure + the security checklist's "operator sign-off" line that explicitly confirms the operator will run the scan + the post-deploy smoke test does not gate on a clean pen-test report. A rep who deploys without running the scan is accepting documented risk.
- **The backup + restore drill is operator-run.** Same posture as the pen test. The smoke-test script + the runbook are the milestone artifact; the drill itself is operator-triggered. A rep who deploys without running the drill is accepting documented risk.
- **The WCAG audit is a one-shot at milestone close, not continuous.** Future feature PRs (Release 2.x) might regress the baseline. The mitigation is the per-PR Quality Bar checkbox ("WCAG 2.2 AA checks pass on new UI") + the automated `axe-core` Playwright spec from S1 covering the eight feature surfaces; new views added in Release 2 need their own audit, documented as a Release 2 standing item.
- **The `--full` flag is O(N) on chain length.** A future production chain with 100,000+ rows takes proportionally longer to verify. At single-tenant scale + Release 1's expected operation volume (single-co-chair + ~5–10 rep team + ~50 chain rows per quarter), the verifier completes in seconds. The runbook documents the bound; a chain that grows to 100,000+ rows would benefit from a paginated `--check-range` flag, deferred.
- **The mobile specs run in headless WebKit + headless Chromium, not on real devices.** A regression that only manifests on a specific iOS version or a specific Android OEM does not surface in CI. The mitigation is the post-deploy smoke test (manual, on the rep's own iOS Safari + Android Chrome devices); the runbook documents the rep's expected device coverage.
- **The pg-boss worker shell is provisioned in production but idles.** No jobs run in 1.12. A future PR could accidentally register a buggy job that runs on the production worker. The mitigation is the per-PR review discipline + the worker's separation as a distinct Fly Machine (rolling back the worker does not roll back the API or the web).
- **The deploy runbook's rollback is one-way for schema.** A migration introduced in 1.x that breaks the deploy requires a manually-crafted rollback migration. Append-only migrations is a CLAUDE.md non-negotiable; the runbook explicitly documents the rollback boundary.
- **`xlsx@0.18.5` HIGH advisories remain on the allowlist.** The CDN-version bump is on the post-Release-1 backlog. The 1.12 security checklist re-confirms the `scripts/audit-with-allowlist.mjs` mitigation posture (cellFormula:false + 10MB cap + browser-only + same-origin worker) is still load-bearing. The two advisories are documented residuals in the checklist's Section C.

### Out of scope (post-Release-1 backlog — explicit deferrals)

The following items are user-authorized deferrals to post-Release-1 hardening milestones. Each is enumerated in the security checklist's Section C with a "lands in" pointer. 1.12 does NOT land any of them:

- Workplace key pair rotation script (in-place rewrap of evidence + recommendation signing key) — source: ADR-0002 §"Follow-ups"; lands in post-Release-1 hardening.
- Workplace signing key rotation script — source: ADR-0008 + ADR-0009 forward seam; lands in post-Release-1 hardening.
- KEK rotation script — source: ADR-0002 + SECURITY.md §9 "annual key rotation"; lands in post-Release-1 hardening.
- Dexie at-rest encryption via WebAuthn PRF / session-derived key — source: ADR-0009 priv-F1 close-out + ADR-0010 T-X42 carry-forward; lands in post-Release-1 hardening.
- True per-action step-up binding (the action label becomes load-bearing) — source: ADR-0009 §3.6 honest stance + ADR-0010 T-X26 carry-forward; lands in post-Release-1 hardening.
- Conflict UI Apply pipeline (three-way merge currently view-only) — source: ADR-0009 priv-F4 + sec-F3 + sec-F4 close-outs; lands in post-Release-1 hardening.
- Tigris bucket orphan ciphertext GC — source: ADR-0006 + ADR-0007 + ADR-0008 forward seam; lands in post-Release-1 hardening (pg-boss job).
- Evidence / inspection_finding / recommendation redaction tables — source: ADR-0006 + ADR-0007 + ADR-0008 PIPEDA P9 stance; lands in Release 2 (the meeting module's P9 surface absorbs these).
- `audit-log-verify` forward-defense flags (`--check-inspections`, `--check-recommendations`, `--check-excel`) — source: ADR-0007 + ADR-0008 + ADR-0010 §"Follow-ups"; lands in post-Release-1 hardening.
- PAdES embedded signatures for recommendation exports — source: ADR-0008 §"Follow-ups"; lands in post-Release-1 hardening or Release 2 depending on the rep's evidentiary needs from the 4–6 week window.
- `excel_import.cancelled` audit kind — source: ADR-0010 §11 sec-F13 / priv-F9 follow-on; lands in post-Release-1 hardening.
- `recommendation.read` audit kind — source: ADR-0009 §12 item 8; lands in post-Release-1 hardening.
- `inspection_finding.read` chain anchor refinements — source: ADR-0007 §"Follow-ups"; lands in post-Release-1 hardening.
- pg-boss-backed sync_idempotency TTL sweep + the sync rate-limit — source: ADR-0009 §12 item 5; lands in post-Release-1 hardening (the pg-boss worker shell is provisioned in 1.12; the job registers in post-Release-1).
- SheetJS CDN upgrade past `xlsx@0.18.5` — source: `scripts/audit-with-allowlist.mjs` header + ADR-0010 T-X54; lands in post-Release-1 hardening (when the CDN-tarball install path becomes reachable from CI).
- Per-attendee encryption for inspection findings — source: ADR-0010 §"Out of scope" + T-X14 + T-X48; lands in post-Release-1 hardening.
- `before_state_json` envelope encryption — source: ADR-0010 §11 priv-F7 follow-on; lands in post-Release-1 hardening.
- Source workbook archival under the workplace KEK (1.11 follow-up) — source: ADR-0010 §11 T-X43 follow-on; lands in post-Release-1 hardening.
- Dexie preview persistence for excel-import — source: ADR-0010 §11 priv-F4 close-out posture; lands in post-Release-1 hardening (replaces the React-useState-only preview with `_excel_import_drafts`).
- Server-side EXIF strip for upload-from-file fallback — source: ADR-0006 §"Follow-ups"; lands in post-Release-1 hardening.

### Risks

- **A WCAG audit miss lets a load-bearing flow ship inaccessible.** Mitigation: the audit walks every view; the `axe-core` Playwright spec catches the common automated-checkable surfaces; the manual screen-reader pass catches the rest; the SHOULD-FIX bundle lands where mechanical. A genuine miss surfaces post-deploy when the rep or a screen-reader user reports it; the response is a fast-follow PR.
- **The fuzzing harness produces a false negative.** Mitigation: the seed is the commit SHA so each CI run gets fresh coverage; the 1000-case budget covers the documented threat scenarios; the quarterly re-fuzz under SECURITY.md §9 keeps the corpus relevant against SheetJS updates. A genuine parser bug under a different scenario surfaces in production via the existing error-handling code path (the parser's `try/catch` envelope is the worker's structured-clone result shape).
- **The pen test plan misses a surface the operator-run scan would catch.** Mitigation: the plan enumerates the surfaces ZAP cannot reach + the manual test cases beyond automated scanning; the triage runbook absorbs new findings into the threat model so future scans cover them. A genuinely-novel finding lands as a new T-# entry + a new mitigation; the post-Release-1 backlog absorbs structural fixes.
- **The backup + restore drill exposes a procedure gap.** Mitigation: the smoke-test script verifies the restored data is chain-consistent; the runbook covers the common failure modes; the operator runs the drill against staging before relying on the procedure for production recovery. A genuine procedure gap is documented + fixed in a fast-follow PR.
- **The mobile specs pass on emulated devices but the real device hits a quirk.** Mitigation: the post-deploy smoke test on the rep's own devices + the per-PR Quality Bar mobile-flow checkbox + the runbook's documented device coverage. A genuine real-device bug surfaces in the 4–6 week window; the response is a fast-follow PR.
- **The deploy runbook's env var inventory drifts from `config/workplace.ts` over time.** Mitigation: the env var loading code in `config/workplace.ts` is the canonical source; the runbook cross-references the code; a CI lint check (added in S4) asserts every env var documented in the runbook is referenced in `config/workplace.ts` and vice versa. A regression in either direction trips the lint.
- **A post-Release-1 backlog item lands in production without being unblocked from the milestone window.** Mitigation: each backlog item carries a "lands in [post-Release-1 milestone X]" pointer in the security checklist; the post-Release-1 milestones are sequenced + reviewed; nothing lands unreviewed. The 4–6 week window is for real-world use, not for sneaking deferrals into production.
- **The synthetic full-dataset audit fixture drifts from the production chain shape over time.** Mitigation: the fixture-generator script (`apps/api/scripts/generate-audit-fixture.ts`) walks the production chain (anonymized) so the fixture stays current; the post-Release-1 milestones that introduce new chain kinds re-generate the fixture as part of their slice plan; the `--full` flag's `payloadShapeMismatches` array surfaces drift in CI.

## Compliance check

- **#1 No specific names in source.** The 1.12 changes do not introduce any new hardcoded identifiers. The deploy runbook documents the env var inventory loaded by `config/workplace.ts`; the WCAG audit confirms no view leaks the workplace name outside the env-driven render path; the mobile Playwright specs use the test-fixture workplace identity. Verified.
- **#2 Chain-of-custody.** The `--full` flag is the structural verification of the chain on the entire dataset. The synthetic fixture is the CI regression check. The backup + restore drill confirms chain integrity survives a restore. No new chain kinds; no chain payload churn. Verified.
- **#3 No third-party data flows without opt-in.** The 1.12 changes introduce zero new dependencies that phone home. The `axe-core` Playwright dependency runs locally; no telemetry. The fuzzing harness runs locally; no telemetry. Verified.
- **#4 Privacy-by-default.** The WCAG audit re-confirms the reveal-path step-up gates are still load-bearing on every sensitive view. The print stylesheets do not leak plaintext beyond what the reveal already exposed. The backup + restore drill confirms ciphertext survives the restore as ciphertext. Verified.
- **#5 Legal citations accurate (corpus only).** The 1.12 changes do not touch the citation surface. The WCAG audit confirms the citation picker is accessible; the recommendation export print stylesheet renders citations correctly. Verified.
- **#6 No employer infrastructure dependencies.** The deploy runbook documents Fly + Neon + Tigris + a rep-chosen domain; no employer IdP, no employer email, no employer file storage. Verified.
- **#7 Rights-protective UI.** The WCAG audit walks every copy surface; the audit confirms no copy discourages s.43 refusal / s.50 reprisal / CLC s.128/s.147 exercise. Verified.
- **#8 No automated submission to regulators.** The recommendation export flow remains operator-triggered (the rep submits manually); the WCAG audit confirms the export modal copy is documentary, not automated-submission-implying. Verified.
- **#9 Mobile-primary.** The mobile Playwright specs cover iOS Safari + Android Chrome on the load-bearing flows. The WCAG audit at the mobile viewport confirms touch targets ≥44pt + sticky bottom actions + bottom tab bar + pull-to-refresh. Verified.
- **#10 Restrained legal-grade aesthetic.** The WCAG audit confirms no marketing flourish + no union iconography + the design tokens are unchanged unless a contrast finding forces a token-level change (in which case the change is the smallest possible diff). Verified.
- **#11 Excel imports sanitized.** The fuzzing harness is the structural hardening of the 1.11 attack surface; the security checklist's Section A row for #11 cites the harness + the existing browser-only-parse + envelope-encryption mitigations. Verified.
- **#12 Action items first-class.** No 1.12 change reshapes the action_items entity model. The WCAG audit covers the minutes-board view (the canonical action-items surface) on mobile. Verified.
- **#13 Inspections preserve template version at conduct time.** No 1.12 change reshapes the inspection lifecycle. The mobile spec covers the inspection-start + sign flow + confirms the template version is pinned. Verified.
- **#14 Zone IDs stable; display names configurable.** No 1.12 change reshapes the zone model. Verified.
- **#15 Inspection findings manually promoted.** No 1.12 change reshapes the promotion lifecycle. The WCAG audit confirms the promote-to-action-item affordance is accessible + the Status X/G non-promotable rule is clear in the copy. Verified.
- **#16 Exports require step-up + audit-logged with hash.** The mobile spec covers the recommendation export flow (step-up gated + chain-anchor confirmed); the deploy runbook + post-deploy smoke confirms the export flow lands in production. The WCAG audit confirms the export confirmation modal copy is clear + the step-up modal is accessible. Verified.

## Follow-ups

- [ ] Threat-modeler: append `SECURITY.md` §2.12 "Release 1 Hardening" with short verification rows confirming each prior section's mitigations are still load-bearing post-audit + flagging any newly-surfaced threats from the WCAG findings or the pen-test plan; the existing §2.1..§2.11 threats are unchanged in payload.
- [ ] S1: WCAG audit (`docs/audits/release-1-wcag-audit.md`) + MUST-FIX-FOR-RELEASE fix bundle (one commit per view) + `apps/web/tests/a11y.spec.ts` (axe-core scanning aid) + `apps/web/tests/e2e/print.spec.ts` (print-stylesheet verification per §3.2).
- [ ] S2: `packages/excel-import/src/__fuzz__/parser-fuzz.test.ts` (deterministic-seed adversarial-workbook fuzzing per §3.5) + `apps/api/scripts/audit-log-verify.ts --full` (per §3.7) + `apps/api/test/fixtures/audit-log-full-dataset.sql` (synthetic CI fixture) + `apps/api/scripts/generate-audit-fixture.ts` (developer-side fixture generator).
- [ ] S3: `apps/web/playwright.config.ts` extended with `mobile-safari` + `mobile-chrome` projects (per §3.8) + `apps/web/tests/e2e/mobile-flow.spec.ts` (load-bearing flows on iOS Safari + Android Chrome) + CI `e2e` job updated to install WebKit + Chromium browsers.
- [ ] S4: four release-readiness docs in `docs/` — `release-1-security-checklist.md` (§3.3), `release-1-pentest-plan.md` (§3.4), `release-1-backup-restore-runbook.md` (§3.6), `release-1-deploy-runbook.md` (§3.9) + `apps/api/scripts/backup-restore-smoke.ts` + a CI lint that confirms the env var inventory in the deploy runbook matches `config/workplace.ts`.
- [ ] S5: independent reviewer pass over the four release-readiness docs + the WCAG audit + the fuzzing harness + the mobile specs; findings land as small fixes; milestone closes with the operator's sign-off on the security checklist.
- [ ] **Post-Release-1 hardening backlog** (post-deploy, sequenced milestones): workplace key pair rotation script; workplace signing key rotation script; KEK rotation script; Dexie at-rest encryption via WebAuthn PRF / session-derived key; true per-action step-up binding; conflict UI Apply pipeline; Tigris bucket orphan ciphertext GC; evidence / inspection_finding / recommendation redaction tables (Release 2 absorbs); `audit-log-verify` forward-defense flags (`--check-inspections`, `--check-recommendations`, `--check-excel`); PAdES embedded signatures; `excel_import.cancelled` audit kind; `recommendation.read` audit kind; `inspection_finding.read` chain anchor refinements; pg-boss-backed sync_idempotency TTL sweep + sync rate-limit; SheetJS CDN upgrade past `xlsx@0.18.5`; per-attendee encryption for inspection findings; `before_state_json` envelope encryption; source workbook archival under workplace KEK; Dexie preview persistence for excel-import; server-side EXIF strip for upload-from-file fallback. Each item lands in a sequenced post-Release-1 milestone; the security checklist's Section C carries the pointers.
- [ ] **Release 2 absorbs:** the meeting module's native lifecycle (replaces the Excel-file workflow); reprisal, accommodation, refusal, critical injury, calendar surfaces; the meeting-module's offline support (extends the 1.10 sync queue to the meeting flows); the PIPEDA P9 redaction tables (evidence / inspection_finding / recommendation); the post-Release-1 hardening items that did not land before R2 starts.
- [ ] **Release 3 absorbs:** E2EE messaging surface (libsignal-protocol-typescript); AI-assisted Adversarial Lens (Anthropic via the ai-proxy machine — opt-in per non-negotiable #3); AI-assisted reconciliation for Excel imports.
- [ ] `.context/decisions.md` entry referencing this ADR.

## Post-Release-1 Backlog Ratchet

This section was appended in S5. The user authorized **ROADMAP scope
only** for 1.12; four HIGH findings from the S5 release-readiness
review were re-triaged as scope expansion and are deferred to the
post-Release-1 hardening backlog (not fixed in 1.12). The six LOW
prior-ADR forward-seam items the release-readiness reviewer surfaced
are also captured here so a future maintainer can pick each one up
without rediscovery.

### Deferred from S5 (originally tagged HIGH, re-triaged as scope expansion)

- **F-R3 — Audit-log full-dataset fixture + generator script.** ADR-0011 §3.7 promised `apps/api/test/fixtures/audit-log-full-dataset.sql` (synthetic ≥1000-row chain covering every kind from 1.2–1.11) + `apps/api/scripts/generate-audit-fixture.ts` (developer-side tool that walks the production chain anonymized to regenerate the fixture). S2 shipped in-test synthetic fixtures inside `audit-log-verify.test.ts` instead. The in-test coverage is functionally similar but does NOT run `--full` against a chain that mirrors the production-shape across every kind. **Lands in:** post-Release-1 hardening milestone — first slice of the post-Release-1 sweep, before the forward-defense flags land. **Mitigation in the interim:** documented in `release-1-audit-verify-gaps.md`; the in-test synthetic chains cover the structural surfaces the runbook depends on.

- **F-R4 — pg-boss worker shell provisioning.** ADR-0011 §3.9 said the deploy provisions `boss.schema_create` + the empty worker process so post-Release-1 sweeps drop in cleanly. The shipped deploy runbook §2 + §3 + §4 do NOT provision either. **Lands in:** post-Release-1 hardening, alongside the `sync_idempotency` TTL sweep job (which is the first job that needs the worker). The runbook for that milestone authors the `boss.schema_create` migration + the worker Fly Machine command together.

- **F-R5 — Recommendation public-verification page.** ADR-0008 §3 forward seam: "1.12 ships a public verification page" for recipients of a signed recommendation PDF to verify against the rep's audit chain without rep involvement. Neither shipped in 1.12 nor previously enumerated in the backlog. **Lands in:** post-Release-1 hardening (low priority for single-tenant scale; the rep's audit chain IS the trust anchor, and the rep can produce a `audit-log-verify --full` report on request). Surface design + JWS verification flow design is the bulk of the work.

- **F-R6 — `apps/api/scripts/backup-restore-smoke.ts`.** ADR-0011 §3.10 S4 deliverable list named this script; the file is not in the tree. The backup-restore runbook §3 walks the drill manually and reaches §3.6's `audit-log-verify --full` step, so the smoke-test script's absence is mitigated by the explicit manual procedure. **Lands in:** post-Release-1 hardening, alongside the `audit-log-verify` forward-defense flags (the script is a thin wrapper around `audit-log-verify --full` plus the per-table row-count + workplace-public-key fingerprint check enumerated in ADR-0011 §3.6).

### Prior-ADR forward seams surfaced by S5 release-readiness review (LOW priority backlog-ratchet)

- **Workplace env var canonical name.** ADR-0011 §3.9 text uses `WORKPLACE_NAME` in one place; the code-canonical name (in `config/workplace.ts` + the deploy runbook §3) is `WORKPLACE_DISPLAY_NAME`. A reader of ADR-0011 might set the wrong variable. **Lands in:** post-Release-1 cleanup commit alongside the env-var CI lint that ADR-0011's S4 follow-up calls for. Until the lint lands, this section is the canonical pointer that the code wins (`WORKPLACE_DISPLAY_NAME`). (Source: F-R7.)

- **WCAG audit doc path canonicalization.** ADR-0011 §3.1 specifies `docs/audits/release-1-wcag-audit.md`; S1 shipped it at `docs/release-1-wcag-audit.md` (root of docs/, not docs/audits/). Cross-references in the checklist follow the as-shipped path so no rep is blocked. **Lands in:** post-Release-1 cleanup — either relocate the doc to `docs/audits/` OR amend ADR-0011 §3.1 to reflect the as-shipped path. (Source: F-R8.)

- **Service-worker rotation procedure.** ADR-0009 §"Out of scope" forward seam: revoke stale SW on KEK rotation. Not in the 1.12 backlog. Will become load-bearing the day KEK rotation lands; until then the SW is keyed against the workplace public key that never rotates. **Lands in:** post-Release-1 hardening (alongside KEK rotation script). (Source: F-R13.)

- **Dead-letter Prometheus metric.** ADR-0009 §"Out of scope" forward seam: operational signal (Prometheus or equivalent) for the dead-letter queue depth. Not in 1.12 backlog. Operability degradation if the rep cannot see when sync is silently dead-lettering. **Lands in:** post-Release-1 hardening (alongside the pg-boss worker shell). (Source: F-R14.)

- **Excel-import forward seams (four).** ADR-0010 §"Out of scope" enumerates: (a) automated content_hash dedup detection across imports, (b) source-filename PII detector, (c) reverse-window admin UI for the co-chair past 30 days, (d) `.xls` (binary 97-2003) fallback parser. None enumerated in the 1.12 ADR backlog list. **Lands in:** post-Release-1 hardening. The reverse-window admin UI is the most operationally relevant — the rep needs a way past day 30 today and has only the operator script. (Source: F-R15.)

- **`inspection_finding_redactions` table Release-vs-1.12 scope.** ADR-0011 §"Out of scope" lumps this into "Evidence / inspection_finding / recommendation redaction tables — lands in Release 2." Adequate but coarse; the rep should know it's a Release 2 item (alongside the meeting module's P9 surface), not a post-Release-1-hardening item. Above list is now explicit. (Source: F-R16.)

- **pg-boss-backed cross-process export rate limiter.** ADR-0008 §3 forward seam: cross-process export rate limiter via pg-boss. At single-tenant scale the in-memory rate limiter holds; the deferral should still be explicit so a future PR doesn't re-discover it. **Lands in:** post-Release-1 hardening, alongside pg-boss worker shell + dead-letter metric. (Source: F-R12.)

### Mobile Playwright suite — gated until follow-up infrastructure milestone

- **Mobile-CI infrastructure.** The S3 mobile Playwright projects (`mobile-iphone-15-pro`, `mobile-pixel-9`) are checked in but gated behind `E2E_INCLUDE_MOBILE=1` in `apps/web/playwright.config.ts`. The S3 brief authorized `--list`-only verification; the first CI run after the PR opened surfaced ~40 failures across both projects (WebKit/iPhone-on-Linux dev-server interaction, and spec assumptions about dev-server-vs-production-build behavior). Two M1.12 S5 surgical fixes landed in the spec source (EXPECTED_TAB_LABELS regex for the `Recs` shortLabel, and removal of the `className="h-9"` overrides on minutes-view that defeated the F-P2 primitive fix at the call-site). **Lands in:** post-Release-1 mobile-hardening milestone — set up a `vite build && vite preview` Playwright job, seed a Dexie fixture, baseline WebKit on the Linux runner, then flip the gate. Documented in `docs/release-1-mobile-test-gaps.md` § "CI gating".
