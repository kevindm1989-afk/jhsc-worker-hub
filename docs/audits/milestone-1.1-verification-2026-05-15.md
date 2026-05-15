# Milestone 1.1 Verification Audit — 2026-05-15

**Repo:** jhsc-worker-hub
**Branch / HEAD:** `main` @ `e32de29`
**Auditor:** Claude Code (read-only, plan-first discipline)
**Scope:** 10 categories (G1–G6 gap audit, E1–E5 error scanning), per the
verification plan approved at session start.

---

## Executive summary

**0 blockers. 3 HIGH-priority findings. 5 should-fix. 6 log-as-outstanding.**
Discipline patterns held cleanly across the sampled commits (G6).

### Top 3

1. **HIGH CVE `drizzle-orm@0.36.4` (SQL injection, GHSA-gpj5-g38j-94v9)** —
   has an active codepath in `apps/api/src/db/client.ts`, though zero queries
   exist today. Patched in `>=0.45.2`. Becomes load-bearing in Milestone 1.3.
2. **`pnpm audit` not wired into CI.** `SECURITY.md` §3 declares
   "`pnpm audit` runs on every CI build; high/critical vulns block merge."
   Reality: `ci.yml` has no audit step. The drizzle CVE above would have
   been caught and blocked if the documented policy existed in code.
3. **Discipline mechanization gap.** No pre-commit hooks anywhere (no husky,
   no lefthook, no `prepare` script, no custom `core.hooksPath`). Every
   discipline pattern in `~/.claude/.../memory/` is currently enforced by
   inline construction in Claude Code sessions, not by automation. One
   missed step next session reintroduces the bug class. **Memory-based
   defense is necessary but insufficient.**

### Green areas (worth naming)

- `pnpm typecheck`, `lint`, `format:check`, `test`, `build` all pass.
- All 24 config files parse (5 YAML, 2 TOML, 12 JSON, plus pnpm-lock).
- Gitleaks has executed on every commit on `main` and on every recent
  Dependabot PR. 17 of 20 most recent runs `success`; the 3 failures are
  the documented bug-fix sequence (v-prefix → permissions → green).
- Cross-workspace imports (`@jhsc/ui` → `apps/web`) all resolve.
- 0 AI-attribution trailers in commit history.
- All 8 sampled commits used focused, explicit file staging.
- Memory cross-references all resolve; no contradictions across 8 memory
  files.

---

## Method recap

- **Wave 1 (inventory):** directory walk, git state, file existence vs.
  spec, memory directory listing, install state.
- **Wave 2 (parallel E1+E2+E3):** ran the verification gate, parsed every
  config, `pnpm audit` prod+dev, searched for pre-commit hook in 5
  candidate locations, listed open PRs.
- **Wave 3 (parallel G2-G6 + E4):** read all spec docs, all 4 placeholder
  `docs/` files, all 8 memory files, all workspace `package.json`s, all
  workspace entrypoints. Pulled CI run history for both workflows.
  Sampled 8 commits for G6 discipline audit.

Note: D5 decided to skip local gitleaks scan in favor of CI evidence.
Local `gitleaks` binary is not installed. CI evidence below.

---

## Findings — HIGH priority

### H1 — `drizzle-orm@0.36.4` has HIGH-severity SQL injection CVE

- **Category:** E3 Security / Dependencies
- **Severity:** HIGH
- **Advisory:** GHSA-gpj5-g38j-94v9 — SQL injection via improperly escaped
  SQL identifiers
- **Patched in:** `>=0.45.2` (current: `^0.36.4` in `apps/api/package.json`)
- **Codepath status:** drizzle IS instantiated:
  `apps/api/src/db/client.ts → return drizzle(sql, { schema });`. The
  schema is empty (comment cites deferral to Milestones 1.3 / 1.5). No
  queries exist yet — **exploit surface is zero today** but becomes
  load-bearing in Milestone 1.3.
- **Recommendation:** dedicated cleanup session before Milestone 1.3
  begins. Bump to `^0.45.2` or latest stable, re-run E1, commit. Bundle
  with H3 and S1 (see below).

### H2 — `pnpm audit` not wired into CI; SECURITY.md drift

- **Category:** G2 Spec reconciliation / E3 Security
- **Severity:** HIGH (spec contradicted)
- **Spec claim:** `SECURITY.md` §3 — "`pnpm audit` runs on every CI build;
  high/critical vulns block merge."
- **Reality:** `.github/workflows/ci.yml` runs typecheck + lint +
  format:check + test + web build. No `pnpm audit` step in any job.
  Root `package.json` defines `"audit": "pnpm audit --audit-level=high"`
  but nothing invokes it.
- **Connection to H1:** if the documented policy were implemented, the
  drizzle CVE would be blocking the build right now.
- **Recommendation:** add `pnpm audit --audit-level=high` step to the
  `verify` job in `ci.yml`. Decide: gate `merge` on it (per spec) or
  start as a warning while H1 and S2 are pending. Bundle with the
  cleanup session.

### H3 — No pre-commit hooks; discipline lives only in inline pipelines

- **Category:** E3 Security / Process
- **Severity:** HIGH (escalated from should-fix per user direction)
- **Detail:** Exhaustive search confirmed absence: no `.husky/`, no
  `lefthook.*`, no `simple-git-hooks` config, no `prepare` script, no
  custom `core.hooksPath`.
- **Why this matters more than typical should-fix:** every commit this
  session ran the verification gate and the hard-blocking secret-name
  scan because Claude Code constructed the pipeline inline from memory.
  The discipline is real but fragile across sessions. A single forgotten
  inline step reintroduces:
  - the visual-only `grep || echo` bug class (caught & fixed in
    `feedback-commit-guard-hard-block`),
  - the "docs-only, skip format:check" bug class (caught & fixed in
    `feedback-verification-gate-no-exceptions`),
  - the `git add -A` blast-radius bug class (avoided to date, but
    untracked-file accidents would commit silently).
- **Recommendation:** install `husky` or `lefthook` in a dedicated
  Milestone 1.2 prep task (or as part of the cleanup session). The hook
  should run the same gate the inline pipeline runs today:
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`,
  followed by the hard-blocking secret-name scan. Wire the secret-name
  scan as a separate hook so a green gate doesn't mask a failed scan.

---

## Findings — should-fix

### S1 — `ci.yml` missing `permissions:` block

- **Category:** E3 Security / Memory-rule application
- **Severity:** should-fix
- **Detail:** `.github/workflows/ci.yml` has no `permissions:` declaration
  at workflow or job level. `gitleaks.yml` does (added in `dfea37d`).
- **Memory rule:** `feedback-actions-permissions-explicit-for-pr-events`
  says PR-event workflows should explicitly declare minimum permissions
  because Dependabot PR events run with a restricted `GITHUB_TOKEN`.
- **Acknowledgment:** `ci.yml` doesn't call the GitHub API, so the
  failure mode is less acute than gitleaks.yml's. But the memory rule
  applies as least-privilege practice regardless. Empirical CI runs (20
  most recent) are all green — the gap is preventive, not active.
- **Recommendation:** add `permissions: contents: read` at workflow
  level. Bundle with H1+H2+H3 cleanup session.

### S2 — 4 moderate dev CVEs via `vitest@2.1.9` chain (vite, esbuild)

- **Category:** E3 Security / Dependencies
- **Severity:** should-fix (dev-only, never runs in production)
- **Detail:**
  - vite GHSA-4w7w-66w2-5vf9 — path traversal in optimized-deps `.map`,
    patched in `>=6.4.2`. Current: `5.4.21` (transitive via vitest).
  - esbuild GHSA-67mh-4wv8-2f99 — patched in `>=0.25.0`. Current:
    `0.21.5` (transitive via vite).
- **Fix path:** bump `vitest` to `^3` or matching latest; pulls newer
  vite + esbuild.
- **Acknowledgment:** none of the 9 open Hold-bucket Dependabot PRs
  cover vitest/vite/esbuild — these CVEs are below Dependabot's PR
  threshold and need a manual bump.
- **Recommendation:** dedicated dependency-modernization session (own
  PR), not bundled with H1/H2/H3 cleanup, because vitest v3 may have
  test API changes worth verifying.

### S3 — README.md missing

- **Category:** G4 Documentation
- **Severity:** should-fix
- **Detail:** No `README.md` at repo root. Project has substantial spec
  docs (CLAUDE.md, ARCHITECTURE.md, SECURITY.md, ROADMAP.md,
  BOOTSTRAP_PROMPT.md) but no entry-point doc for "what is this and
  where do I start."
- **Acknowledgment:** for a personal worker-side tool, the bar for a
  README is lower. But CLAUDE.md and the cluster of spec files are
  internal-orientation; a one-page README explaining purpose, status,
  and "read CLAUDE.md first" is still worthwhile.
- **Recommendation:** add a 30-line README pointing at CLAUDE.md
  (purpose), ROADMAP.md (current milestone), SECURITY.md (threat
  model). Defer until cleanup session — low urgency.

### S4 — `CLAUDE.md` Repository Layout shows future-state, not current-state

- **Category:** G2 Spec reconciliation
- **Severity:** should-fix (doc drift)
- **Detail:** `CLAUDE.md §Repository Layout` lists 7 packages
  (shared-types, legal-corpus, crypto, audit, ui, calculators,
  excel-import); only `packages/ui` exists. The layout reads as
  prescriptive of the current state, but is actually the eventual state
  after Milestones 1.3–1.11.
- **Recommendation:** annotate the layout block with `(planned)` per
  deferred package, OR split the section into "Current scaffold" and
  "Planned packages" with each planned line tagged with its owning
  milestone. The second form is more useful for orientation. Bundle
  into the cleanup session OR handle as its own one-line doc commit.

### S5 — `CLAUDE.md` Repository Layout shows root `fly.toml` that doesn't exist

- **Category:** G2 Spec reconciliation
- **Severity:** should-fix (doc drift)
- **Detail:** `CLAUDE.md §Repository Layout` lists `fly.toml` at root.
  Reality: per-app `fly.toml` at `apps/api/fly.toml` and
  `apps/ai-proxy/fly.toml`. The per-app pattern is correct for the
  multi-Fly-Machine architecture; CLAUDE.md is stale.
- **Recommendation:** remove the root `fly.toml` line from the layout
  block; the per-app files are mentioned correctly elsewhere. Bundle
  with S4.

---

## Findings — log-as-outstanding (no urgency, already known)

### L1 — 6 of 7 packages from `CLAUDE.md` layout missing

- **Category:** G1 / G2
- **Detail:** `packages/{shared-types,legal-corpus,crypto,audit,calculators,excel-import}`
  are absent. **Intentional deferral per ROADMAP.md** — they map to
  Milestones 1.3 (crypto, audit), 1.4 (legal-corpus), 1.11
  (excel-import), and Release 3 (calculators). Shared-types isn't
  scoped to a specific milestone but follows Milestone 1.3+ work.
- **No action.** This is the answer S4 will reflect.

### L2 — Milestone 1.1 infrastructure items not provisioned

- **Category:** G2 / ROADMAP reconciliation
- **Detail:** ROADMAP.md Milestone 1.1 includes "Fly.io project
  provisioned (YYZ region)" and "Tigris bucket provisioned." Neither
  is done; both are documented in the retro's Outstanding Follow-ups
  with the interactive-CLI constraint.
- **Acknowledgment:** the retro is honest about this. The Milestone is
  effectively "Code Foundation: complete" not "Infrastructure
  Foundation: complete." Worth keeping in mind when the next milestone
  starts depending on real DB or Tigris.
- **No new action.** Already tracked in retro.

### L3 — 9 open Hold-bucket Dependabot npm PRs

- **Category:** E5 Git state
- **Detail:** PRs #6–#14, all created 2026-05-13, all npm majors,
  matching yesterday's Hold-bucket triage list verbatim. **Cross-check
  vs. CVE findings:** none of these PRs would address H1, S2.
- **No new action.** Already tracked in retro.

### L4 — Branch protection rules on `main` not set

- **Category:** Process
- **Detail:** Retro Outstanding Follow-up. Needs `gh api` with
  repo-admin PAT.
- **No new action.** Already tracked.

### L5 — Repo merge-strategy default not switched to squash

- **Category:** Process
- **Detail:** Retro Outstanding Follow-up. The 5 GitHub Actions
  Dependabot PRs merged on 2026-05-14 used "Create a merge commit"
  producing non-linear history; should switch to squash before next
  merge batch.
- **No new action.** Already tracked.

### L6 — Git config `user.email` typo (`gmaail.com` vs `gmail.com`)

- **Category:** G6 Discipline / Process
- **Severity:** log-as-outstanding (trivial fix, but worth flagging in
  the durable record because authorship integrity matters on a
  worker-side advocacy tool)
- **Detail:** Both local (`.git/config`) and global (`~/.gitconfig`)
  `user.email` are set to `jhscworkerhub@gmaail.com` — note `gmaail`
  with a double 'a'. Every commit since this was configured (including
  all 8 sampled in G6) is authored to that address. The commit history
  also shows one earlier commit authored as `kevindm1989@gmail.com`
  (the user's personal address per session context), suggesting the
  JHSC email was set later and the typo went unnoticed at the time.
- **Why this matters:** if the typo address does not resolve to a real
  GitHub account, the commits will not be linked to the user's verified
  GitHub identity — they appear as an unknown contributor on
  github.com. For a repo whose git history may surface as evidence
  (MLITSD complaints, OLRB hearings, arbitration), an author email
  that doesn't route to the user weakens the chain of "authored by
  Kevin acting in their JHSC capacity."
- **Recommendation:** `git config --global user.email "<correct address>"`
  (likely `jhscworkerhub@gmail.com`, but verify before setting). Local
  config inherits from global once cleared, or set explicitly:
  `git config --local user.email "<correct address>"`. Existing commits
  cannot be retroactively re-attributed without a history rewrite —
  not worth a force-push on `main`. New commits will carry the
  corrected email going forward.
- **No new action this session.** Flagged in the durable record;
  user-driven config fix.
- **Resolution (2026-05-15):** User corrected via
  `git config --global user.email` shortly after audit commit
  `ff932a8`. Current config on both local (`.git/config`) and
  global (`~/.gitconfig`) resolves to the correct address
  (`jhscworkerhub@gmail.com`). Past commit history on `main`
  retains the typo'd email permanently (force-push to rewrite
  not worth it on shared `main`). No further action needed.

---

## G6 — Discipline pattern audit (the novel category)

Sampled **8 commits** (per user direction, 5-8 range): `e32de29`,
`096beac`, `dfea37d`, `6da7ce0`, `5369ded`, `70d185c`, `6fb9aca`,
`5ef7779`.

### Audit dimensions and verdicts

| #   | Dimension                                        | Method                                                                                                                                                                                                                           | Verdict                                                                                                                                                       |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No AI-attribution trailers in commits            | `git log --all --format='%H %s%n%b' \| grep -iE 'Co-Authored-By\|Claude\|🤖\|Generated with'`                                                                                                                                    | ✓ 0 hits in commit metadata (the few matches were content references inside docs to the spec file `CLAUDE.md`, not trailers)                                  |
| 2   | Hard-blocking commit guard (not visual-only)     | Indirect: no secret-named files anywhere in tracked history; retro documents the broken→fixed transition (Groups A/B → C+); all 8 sampled commits are post-fix                                                                   | ✓ Pattern held in 8/8 sampled commits                                                                                                                         |
| 3   | Explicit file paths in `git add` (no `-A` / `.`) | Inspected `--stat` of each commit — diff content matches stated subject; no stray `tsbuildinfo`, no IDE config, no `.DS_Store`                                                                                                   | ✓ 8/8 commits show focused staging                                                                                                                            |
| 4   | Full verification gate run per commit (no skips) | CI run history (20 most recent runs): all `success`; the documented historical skip on `fd09b9a` (format:check waived on retro commit) was caught and amended out of `45eedcb`; that violation is **not** in the 8-commit sample | ✓ 8/8 sampled commits clean; 1 documented historical violation, caught and corrected by the lesson now codified in `feedback-verification-gate-no-exceptions` |
| 5   | Memory cross-references intact                   | Read all 8 memory files; verified each `[[link]]` resolves                                                                                                                                                                       | ✓ All 7 cross-references resolve to existing memory files                                                                                                     |
| 6   | Single author of record                          | All sampled commits authored by `Kevin <jhscworkerhub@gmaail.com>`                                                                                                                                                               | ✓ Sole author; consistent with `feedback-no-ai-attribution`                                                                                                   |

### Discipline drift detected: none in sample

The discipline patterns codified in memory **held across all sampled
commits**. The two documented historical violations (visual-only
`grep || echo` in Groups A/B; format:check skip on `45eedcb`/`fd09b9a`)
predate the memory entries that fixed them. No new drift was detected
in the post-lesson window.

### The fragility H3 names

What G6 _cannot_ prove: that the patterns will hold next session. The
patterns held because Claude Code constructed them inline from memory.
Memory is read at session start; if the relevant entry is missed,
forgotten, or contradicted by a new prompt, the discipline silently
lapses. This is the concern H3 escalates.

---

## E4 — Integration audit

### Cross-workspace imports

- `apps/web/tailwind.config.ts` imports `@jhsc/ui/tailwind-preset` → resolves
  to `packages/ui/src/tailwind-preset.ts` ✓
- `apps/web/src/lib/utils.ts` imports `cn` from `@jhsc/ui` → resolves to
  `packages/ui/src/index.ts` which exports `cn` ✓

### Exports vs consumers

- `packages/ui/src/index.ts` exports: `cn` (value), `ClassValue` (type).
  `apps/web` consumes `cn`. Match: ✓
- `packages/ui/src/tailwind-preset.ts` default-exports the preset. `apps/web`
  consumes via default import. Match: ✓

### Deep-relative cross-workspace imports

- `grep -rE "from '\.\./\.\./\.\./" apps packages` → 0 hits. Good — no
  consumer is bypassing workspace boundaries.

### `package.json` scripts validity

- All script binaries present in dep tree (vitest, tsc, eslint, prettier,
  vite, playwright, drizzle-kit, bun). Spot-checked via `pnpm -r`.

### Verdict

Integration is clean. Only one workspace package (ui) is currently
consumed by another (web); all paths resolve correctly.

---

## E1 — Verification gate results

| Check        | Command             | Result                                                                                   |
| ------------ | ------------------- | ---------------------------------------------------------------------------------------- |
| Typecheck    | `pnpm typecheck`    | ✓ exit 0 (root + 4 workspaces)                                                           |
| Lint         | `pnpm lint`         | ✓ exit 0                                                                                 |
| Format check | `pnpm format:check` | ✓ exit 0 (all files prettier-clean)                                                      |
| Unit tests   | `pnpm test`         | ✓ exit 0 — **13 tests** across 4 test files (config: 5, web: 5, api: 2, ai-proxy: 1)     |
| Build        | `pnpm build`        | ✓ exit 0 — `apps/web` builds; other workspaces have no `build` script (silently skipped) |

**Observation:** `packages/ui` has no `test` script. Per its package.json
description it is "tokens-only in milestone 1.1." The cn helper and the
preset object have no runtime behavior worth testing today. Acceptable
gap; not a finding.

---

## E2 — Configuration validity

All files parse successfully:

| Type | Files                                                                                                        | Result        |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| YAML | `.github/workflows/{ci,gitleaks}.yml`, `.github/dependabot.yml`, `docker-compose.yml`, `pnpm-workspace.yaml` | ✓ all parse   |
| TOML | `apps/api/fly.toml`, `apps/ai-proxy/fly.toml`                                                                | ✓ both parse  |
| JSON | `tsconfig*.json` (5), `package.json` (5), `tsconfig.base.json`, `tsconfig.json` (root)                       | ✓ 12/12 parse |

### .env.example coverage

- Env vars actually read in source: `process.env.CI`,
  `process.env.DATABASE_URL`, `process.env.WEB_PORT`, plus the full
  `process.env` passed through Zod in `apps/api/src/env.ts` (DATABASE_URL,
  WORKPLACE_DISPLAY_NAME, API_PORT, NODE_ENV) and
  `apps/ai-proxy/src/env.ts` (AI_PROXY_PORT, NODE_ENV).
- All names covered in `.env.example`. Additional placeholder entries
  for future milestones (VAPID, TIGRIS, MASTER*KEY, AI_PROXY*\*) are
  marked with deferral notes. **Coverage: complete.**

---

## E5 — Git state

- Working tree: clean.
- Stash: empty.
- Branch: `main` at `e32de29`, matches `origin/main` (no divergence).
- Remote branches: `main` + 9 Dependabot npm branches (#6–#14).
- `git ls-files --others --exclude-standard`: empty (no untracked files
  outside `.gitignore`).

### CI evidence (per D5)

Pulled `gh run list` for both workflows, 20 most recent.

**Gitleaks workflow:**

- 17 / 20 runs `success`. 3 failures, all explained by the bug-fix
  sequence documented in the retro and CI memory entries:
  - `25834098758` (commit `70d185c`) — failed because `v8.30.1` →
    `vv8.30.1` 404; fixed by `5369ded`.
  - `25833344216` (PR #6 tailwind-merge first scan) — failed pre-permissions
    fix; fixed by `dfea37d`.
  - `25894614678` (PR #4 setup-buildx first scan) — same root cause as
    above; the next scan of the same PR succeeded after `dfea37d`.
- **Every commit on `main` has a corresponding green gitleaks run on
  push.** Substitutes adequately for local full-history scan (D5).

**CI workflow:**

- 20 / 20 runs `success`. No CI failures since the workflow was added in
  `6fb9aca`.

---

## Triage recommendation

Three groups, sized for distinct sessions:

### Group A — Cleanup session (before Milestone 1.3 begins)

Bundle, coherent unit:

- **H1** bump `drizzle-orm` to `^0.45.2`
- **H2** wire `pnpm audit --audit-level=high` into `ci.yml verify` job
- **H3** install `husky` (or `lefthook`) with verification-gate +
  secret-name-scan hooks
- **S1** add `permissions: contents: read` to `ci.yml`
- **S4** annotate / split `CLAUDE.md §Repository Layout`
- **S5** remove root `fly.toml` line from `CLAUDE.md` layout
- **S3** add minimal `README.md`

Sequence within the session: H3 first (so subsequent commits run through
the hook), then H1, then H2 (verifies the new pipeline catches the
no-longer-vulnerable drizzle), then S1, then S3-S5 docs.

### Group B — Dependency modernization session

Standalone:

- **S2** bump `vitest` to v3 (pulls newer vite + esbuild, addresses both
  moderate CVEs). Verify test API compatibility.

### Group C — No new action; already tracked in retro

- L2 (Fly/Tigris provisioning)
- L3 (9 Dependabot npm PRs)
- L4 (branch protection)
- L5 (squash-merge default)
- L1 (6 deferred packages)

---

## What this audit did not cover

- **Local gitleaks scan over full git history.** Skipped per D5; replaced
  with CI evidence.
- **Penetration testing / fuzzing.** Out of audit scope; tracked for
  Milestone 1.12 hardening.
- **Production infrastructure verification.** Fly + Neon + Tigris not
  provisioned; nothing to verify.
- **Runtime behavior on iOS/Android.** Audit is read-only; no device or
  browser testing performed.
- **`packages/ui` test coverage gap.** Acceptable for tokens-only
  package; revisit when React components land.

---

## Audit metadata

- **Wall time:** ~50 min across 3 waves.
- **Tool calls:** ~40 (parallel where possible).
- **Files read in full:** 20 (spec docs, memory files, workspace package
  configs, key source files).
- **Decisions surfaced for user triage during audit:** D1–D6 (memory:
  user resolved each before next wave).
- **Write actions performed:** 1 — this report file + parent directory.

End of audit.
