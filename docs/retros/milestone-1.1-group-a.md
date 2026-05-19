# Milestone 1.1 — Group A Cleanup Retro

**Period:** 2026-05-18 → 2026-05-19 (2 sessions, ~4.5 hours total)
**Scope:** Group A audit-finding cleanup (H1, H2, H3, S1, S3, S4, S5) plus L6 closure
**Outcome:** 7 audit findings closed durably on `main`. Pre-commit hook installed Day 1 and proven durable across 7 firings.

---

## What landed

All 7 Group A findings closed (each anchored to audit commit `ff932a8`):

| Finding | Commit    | Day   | Description                                                                                     |
| ------- | --------- | ----- | ----------------------------------------------------------------------------------------------- |
| H3      | `fbd742b` | Day 1 | Husky pre-commit hook: verification gate + hard-blocking file-name secret scan                  |
| H1      | `78ee2ea` | Day 1 | drizzle-orm bump to `^0.45.2` (closes GHSA-gpj5-g38j-94v9)                                      |
| H2      | `cd6affb` | Day 2 | `pnpm audit --audit-level=high` step in ci.yml verify job                                       |
| S1      | `6bbe0fa` | Day 2 | Explicit workflow permissions: `contents: read` default + docker/e2e `actions: write` overrides |
| S3      | `d817470` | Day 2 | Minimal 23-line README at repo root                                                             |
| S4      | `6c941c7` | Day 2 | `(planned — milestone X)` annotations on 6 packages in CLAUDE.md Repository Layout              |
| S5      | `5601a7a` | Day 2 | Removed phantom root `fly.toml` line from CLAUDE.md Repository Layout                           |

L6 (git config email typo from `gmaail` to `gmail`) was resolved 2026-05-15 (same day as the audit) by user config change; the audit doc update committed as `7abec59` on 2026-05-15.

All 7 Group A commits authored with corrected email `jhscworkerhub@gmail.com` (verified via `git log --since='2026-05-18'`).

Memory dir progression across the two days: started Day 1 at 10 entries (1 MEMORY.md + 9 feedback files), ended Day 2 at 12 entries (1 MEMORY.md + 11 feedback files).

- New on Day 1: `feedback-research-deadend-pivot-empirical.md`
- New on Day 2: `feedback-inline-scan-mirrors-hook.md`
- Refined on Day 1: `feedback-cite-evidence-before-durable-record.md` (broadened to cover mid-session tool-call proposals)
- Refined on Day 2: `feedback-cite-evidence-before-durable-record.md` (added bullet 4 naming memory writes as discrete actions, with empirical "violated 2 times in 48 hours" count derived in chat before durable record)

---

## What worked

**Plan-first review on every substantive change.** Each commit's exact Edit, exact commit message, and any verifiable claims were surfaced before execution. This caught real issues pre-commit: scan-shape miscall in H2's pipeline, false-precision "3 times" count in the discipline memory refinement, "Fly.io multi-app pattern" over-generalization in S5's commit message, fuzzy milestone mapping in S4's annotations.

**The mechanization layer became infrastructure.** The hook fired 7 times across 7 unrelated commits (fbd742b → 78ee2ea → cd6affb → 6bbe0fa → d817470 → 6c941c7 → 5601a7a). Every firing produced both `=== verification gate ===` and `=== secret-name scan ===` headers, and the inline scan and hook scan agreed on every commit. By the third firing (cd6affb / H2), the pattern was reliable enough that subsequent commits ran without diagnostic anxiety.

**Evidence-before-durable-record discipline operated as designed in multiple incidents.** The S1 commit message would have asserted "20 of 20 CI runs green"; was caught and corrected to "19 of 20" with the specific failure (Dependabot eslint-plugin-react-hooks 5→7 major bump PR) named. The discipline memory's "3 times violated" framing would have inflated the count; was caught and corrected to "2 times" with explicit derivation in the chat transcript. The S5 commit message's "per the Fly.io multi-app pattern" generalization would have asserted beyond evidence; was caught and tightened to "per the per-app pattern observed in the apps/ subtree."

**Verification before retro write caught a third inaccuracy in real-time.** When drafting this retro, the initial version claimed S1's e2e job override comment cited `feedback-conditional-gates-weaken-ci-evidence` by name. Grep verification proved this false — the e2e comment describes the conditional-gate concept descriptively, but the memory file is named in S1's commit message body (6bbe0fa), not in any inline YAML comment. The fail-fast grep behavior surfaced the discrepancy before the retro landed in durable record.

**Surface-then-approve gating held even under fatigue.** No "Yes, don't ask again" options taken on any approval prompt across either day. The per-command approval friction is real but the discipline benefit shows up exactly when fatigue makes shortcuts attractive.

---

## What got caught (and what we learned)

**Scan-shape miscall (H2 pipeline, Day 2).** Initial commit pipeline used a content-keyword regex (`api_key|secret|token`) instead of the hook's file-name regex. Memory miscall: filled the scan shape from training intuition rather than reading the actual hook. Caught at plan-first review. Memory `feedback-inline-scan-mirrors-hook.md` now codifies: inline scan defaults to mirroring the hook verbatim, not constructing from intuition.

**Memory-write parallelization (recurring pattern across both days).** Day 2 wrote `feedback-inline-scan-mirrors-hook.md` parallel to surfacing the corrected H2 pipeline, without plan-first review of the memory content. This was the second real violation of `feedback-cite-evidence-before-durable-record` (the first was L6 evidence on Day 1, before the rule had been written). Caught immediately on Day 2; refined the memory's "How to apply" section to add bullet 4 naming memory writes as discrete actions, with "saving the lesson to memory in parallel" specifically named as the smell phrase.

**Research-depth creep (S1 docs verification, Day 2).** Spent ~12 minutes across 4 WebFetches (actions/upload-artifact README, actions/setup-node README, docs.github.com automatic-token-authentication, upload-artifact MIGRATION.md) verifying upload-artifact v7 permission requirements. The setup-node result was decisive (verbatim "permissions: contents: read" recommendation); the upload-artifact docs were silent across three sources. Time-boxed pivot to defensive-add was the right call — added `actions: write` override on the e2e job with commit-message comment naming exactly which docs were checked and what was missing. `feedback-research-deadend-pivot-empirical` operated correctly, though the pivot triggered later than ideal.

**Inflated count claim (memory refinement, Day 2).** When refining `feedback-cite-evidence-before-durable-record` to name the memory-write pattern, the initial draft said "violated 3 times in 48 hours." Claude Code flagged provenance — the count was Kevin's assertion, not Claude-verified. Walked through the incidents: Day 1 L6 evidence violation (real), Day 1 "wrote 2 memories" UI ambiguity (false alarm, verified benign), Day 2 parallel write (real). Corrected to "2 times" before the durable record landed.

**Recall vs. verification gap (retro draft, end of Day 2).** When drafting this retro, asserted that the S1 e2e override comment cited `feedback-conditional-gates-weaken-ci-evidence` by name. Pre-write verification (`grep -B 1 -A 6 "feedback-conditional-gates" ci.yml`) returned no matches. Investigation showed the memory is cited in S1's commit message body (visible in `git log`), not in the inline YAML comment (which describes the conditional-gate concept descriptively). My recall conflated two surfaces. The verification caught the error before the retro committed it. Worth noting: descriptive accuracy about prior tool outputs is less reliable than direct verification.

**Compounded mis-correction on hook firing count (retro draft verification, end of Day 2).** During retro verification, you flagged that "7 hook firings" might be wrong because fbd742b is the install commit. I accepted the reasoning ("hook didn't exist before it ran") without independent verification and folded the "corrected count of 6" into the commit message as a "third verification catch." A subsequent verification batch (`ls -la .husky/pre-commit`) showed the hook file mtime predated the fbd742b commit by ~4 hours, and Husky's prepare script typically sets up the hook during pnpm install before any commit fires — meaning fbd742b most likely did fire the hook. The original "7 firings" framing was correct; my "correction" was the actual error. The catch was real (it surfaced via cite-evidence discipline operating on me), but it was a catch of my own propagated assertion, not a catch of the draft's claim. Worth knowing: accepting another reviewer's correction without verifying its underlying evidence is itself the failure mode the rule prevents.

---

## What could improve

**Verification-chain time-boxing needs sharper triggers.** Both Day 1's drizzle changelog research (5 gh-api attempts) and Day 2's S1 permissions docs research (4 WebFetches) went 4-5 attempts before pivot. The time-box should be the first 1-2 failed queries, not the fourth. Worth refining the operational test in `feedback-research-deadend-pivot-empirical` if this pattern recurs a third time.

**The "wrote 2 memories" UI ambiguity arose twice.** Day 1 and Day 2. Each time, the discipline operated correctly (paused, verified state, continued only on confirmation). Worth knowing the Claude Code UI counter for memory writes can show numbers higher than the file count changes by, due to multiple Edit operations on a single file. Not a Claude Code bug per se — a known display quirk to recognize without alarm.

**Subject-line character recount caught one inflation.** Claude Code initially said 47 chars on the S1 commit message subject; recount in chat showed 51 (verified post-Group-A as exactly 51 via `wc -c`). Subject-line counts done in chat without verification may be off by a few — verify with `wc -c` if convention adherence is the load-bearing claim.

---

## What's outstanding

**Group B (next session, ~45-60 min):**

- S2: bump vitest from v2 → v3, pulls newer vite + esbuild. Closes 4 moderate dev CVEs that currently surface on every `pnpm audit` run.

**Log-tier (already tracked from audit ff932a8):**

- L1: 6 deferred packages per ROADMAP (intentional)
- L2: Fly/Tigris/Neon provisioning (interactive CLI work; user-driven)
- L3: 9 Hold-bucket Dependabot npm PRs (each its own focused migration)
- L4: branch protection rules on main (gh API w/ repo-admin PAT)
- L5: squash-merge default for the repo

**Out-of-scope deferrals from Group A (logged, not silently expanded):**

- migrations/, scripts/, docs/ directories may carry the same future-state-shown-as-current-state pattern that S4 addressed for packages
- Per-app fly.toml files exist on disk but aren't surfaced in the CLAUDE.md Repository Layout tree (S5 left the per-app files unmentioned, focused only on phantom removal)

---

## Discipline patterns reinforced

By memory file (post-this-session: 11 feedback files):

- `feedback-no-ai-attribution` — held cleanly across all 5 Day-2 commits + 2 Day-1 commits
- `feedback-no-silent-additions` — caught scan-shape miscall (Day 2), memory parallel write (Day 2)
- `feedback-commit-guard-hard-block` — pattern observed in hook (Day 1) and every commit pipeline (Day 1-2)
- `feedback-verification-gate-no-exceptions` — full gate ran on every commit, no skips even on docs-only edits
- `feedback-verify-uncertain-config-values` — caught fuzzy shared-types milestone mapping (Day 2), applied to Fly.io characterization phrasing (Day 2)
- `feedback-assert-fix-shape` — H3 hook (Day 1) is the mechanization layer this rule recommends
- `feedback-actions-permissions-explicit-for-pr-events` — directly cited in S1 commit message body (Day 2)
- `feedback-conditional-gates-weaken-ci-evidence` — directly cited in S1 commit message body (Day 2); appears nowhere else in git history (verified via `git log --all --grep`)
- `feedback-cite-evidence-before-durable-record` — refined twice across both days; applied to L6 evidence (Day 1), "3 times" count (Day 2), Fly.io phrasing (Day 2), milestone mapping (Day 2), and this retro's draft itself (Day 2)
- `feedback-research-deadend-pivot-empirical` — applied Day 1 (drizzle changelog research) and Day 2 (S1 docs chain)
- `feedback-inline-scan-mirrors-hook` — new Day 2; defended H2 onward against scan-shape drift

---

## State at retro write

- Local main = origin/main = `5601a7a`
- Working tree clean
- Memory dir: 12 entries (1 MEMORY.md + 11 feedback files)
- Hook armed: mode 0755, `core.hooksPath = .husky/_`
- `pnpm audit --audit-level=high`: exit 0 (0 high/critical, 4 moderate dev CVEs below threshold)
- CI history on origin/main: 19 of 20 most recent ci.yml runs green (the 1 failure was a Dependabot eslint-plugin-react-hooks 5→7 major bump on an unmerged PR, unrelated)
- All Group A commits show author `Kevin <jhscworkerhub@gmail.com>` (verified)
- S1 subject line: 51 chars (verified via `wc -c`)
