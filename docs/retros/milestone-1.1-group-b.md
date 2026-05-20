# Milestone 1.1 — Group B Cleanup Retro

**Period:** 2026-05-19 (closed within the same extended ~6.5-hour session as Group A's Day 3 closure work)
**Scope:** Group B audit-finding cleanup (S2, L5, L4) plus L4 post-closure addendum
**Outcome:** 3 audit findings closed durably on `main` (S2, L5, L4). L4 post-closure state ambiguous due to subsequent visibility revert; addendum documents this honestly.

---

## What landed

3 Group B findings closed (each anchored to audit commit `ff932a8`):

| Finding     | Commit    | When  | Description                                                                                                                                                     |
| ----------- | --------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2          | `aefe6a5` | 19:35 | vitest `^2.1.8` → `^3.2.4` across 4 workspaces; pulls vite 7.x + esbuild 0.27.7 transitively; closes 2 of 4 moderate dev CVEs (reframed at closure — see below) |
| L5          | `22f74c6` | 20:07 | `allow_merge_commit: false` already enforced; docs-only closure commit, same shape as L6                                                                        |
| L4          | `b112b24` | 21:04 | Branch protection PUT'd with Baseline A config (linear history + no force-pushes + no deletions)                                                                |
| L4 addendum | `0cde5fc` | 21:20 | Post-closure: visibility reverted private → protection endpoint returns 403; closure stands, post-closure state ambiguous                                       |

All 4 commits landed on 2026-05-19 between 19:35 and 21:20, within the same extended session that closed Group A.

Memory dir unchanged across Group B: 12 entries before (1 MEMORY.md + 11 feedback files), 12 after. No new feedback memories were triggered by this audit-arc.

---

## What worked

**Pre-flight enumeration caught S2's audit miscall.** The audit (`ff932a8`) characterized S2 as "closes 4 moderate CVEs"; the Group A retro (`6e4f12b`) carried that framing forward. Pre-flight `pnpm audit` enumeration at S2's closure time showed only 2 of the 4 CVEs are actually closed by the vitest bump (vite + transitive esbuild via vitest). The other 2 stem from `apps/api > drizzle-kit@0.28.1`'s stale `@esbuild-kit/esm-loader` and direct esbuild dependencies. S2's commit body (`aefe6a5`) reframed honestly with the corrected count and named drizzle-kit as the residual.

**Empirical-already-satisfied closure pattern (L5).** Pre-flight `gh api repos/.../jhsc-worker-hub` showed `allow_merge_commit: false` was already set. No PATCH was required — the audit's specific concern (merge-commit-driven non-linear history) was impossible to recur under the current setting. Same closure shape as L6 (Group A Day 1: email typo resolved by user config change). Documenting "found in target state at closure time" beats fake-PATCH theater.

**L4's blocker shape was reframed honestly.** The audit's "repo-admin PAT" framing misdiagnosed the obstacle — it implied an auth-scope problem when the actual blocker was plan-tier (different category entirely). Classic branch protection requires GitHub Pro for private repos; resolution required a visibility flip to public (separate decision, not L4-scoped). The commit body (`b112b24`) named both the reframing and the dependency on the visibility decision.

**`allow_fork_syncing` discrepancy investigated rather than glossed.** The PUT'd `true` came back as `false` on the GET. Initial reading might have been "PUT partially failed." Docs check showed the field is gated on `lock_branch: true`, which we left `false` per Baseline A. The commit body captured this as a known-and-explained discrepancy.

**L4 addendum named the post-closure ambiguity instead of resolving it falsely.** After `b112b24` landed, visibility was reverted private → the protection endpoint started returning 403 (plan-locked on free-tier). Three options were considered: (a) reopen L4 and redo with private-tier-compatible config, (b) leave the closure intact and not mention the revert, (c) commit an addendum naming the ambiguity. Option (c) was chosen because (a) commits to private-tier config research not in L4's scope, and (b) would leave a false positive in the audit trail. The addendum (`0cde5fc`) says L4's closure stands at the time of the PUT, but the post-closure state is ambiguous.

---

## What got caught (and what we learned)

**Propagated count assertion (S2).** The "4 CVEs" framing originated in the audit doc itself (`ff932a8`) and was repeated in the Group A retro (`6e4f12b`). It survived two retellings before someone enumerated the underlying `pnpm audit` output. Caught at S2's closure-time, not earlier. Same shape as Group A Day 2's "7 hook firings" mis-correction — assertions about counts in upstream documents can survive multiple retellings before the underlying data is checked.

**L4 PUT response interpretation risk.** The `allow_fork_syncing: true → false` discrepancy could have read as "PUT failed partially." Reading the docs before writing the commit body was the difference between an accurate characterization (field-gated-on-`lock_branch`) and a misleading one (PUT-misbehaved).

**L4 addendum decision-shape.** After visibility revert, the operational impulse was to do something — redo L4 with new config, or quietly leave it. Naming three options explicitly and choosing the addendum path required treating "do nothing in the API but document the state" as a legitimate option. Worth knowing: when an external change invalidates a verification surface, the audit-trail-preserving move is often a documentation-only commit, not a remediation commit.

---

## What could improve

**Audit-time count verification.** S2's "4 CVEs" framing came from the audit document itself. If the audit had enumerated CVE-by-CVE at write time rather than asserting a count, the miscall would have been caught at audit time (2026-05-15), not 4 days later at closure time.

**Audit-time blocker-shape verification.** L4's "repo-admin PAT" framing was similarly authored without checking against GitHub's plan-tier reality. A plan-tier check at audit time would have surfaced the real blocker.

**Both patterns above are the same pattern.** Audit findings that assert a shape — a CVE count, a blocker name, a permission requirement — should verify that shape against the canonical tool output at audit time. This is `feedback-cite-evidence-before-durable-record` applied to audit authoring, not just to closure-time commits. Refinement candidate, not a new rule yet — if a third instance surfaces, deserves codification.

---

## What's outstanding

**Group C / future audit candidate:**

- drizzle-kit bump past 0.28.1 to close the remaining 2 moderate esbuild CVEs (residual from S2's reframing)

**Log-tier (carried from audit `ff932a8`):**

- L1: 6 deferred packages per ROADMAP (intentional)
- L2: Fly/Tigris/Neon provisioning (interactive CLI work; user-driven)
- L3: as of retro write, 6 older Hold-bucket Dependabot PRs from 2026-05-13 plus 4 added overnight 2026-05-19/05-20
- L4: post-closure state ambiguous by design (per addendum `0cde5fc`); not pursuing re-publicizing repo to resolve

---

## Discipline patterns reinforced

Memory dir status: 11 feedback files at retro write (unchanged from Group A close).

- `feedback-no-ai-attribution` — held cleanly across all 4 Group B commits
- `feedback-cite-evidence-before-durable-record` — caught the S2 count framing, drove the L4 PUT field reading, and shaped the L4 addendum's "ambiguous" framing instead of an overclaimed closure
- `feedback-no-silent-additions` — L4's audit-blocker reframing surfaced in the commit body, fork_syncing discrepancy named explicitly
- `feedback-verify-uncertain-config-values` — L4 PUT response checked against GitHub docs before commit; L5 empirical state checked against `gh api` before PATCH'ing nothing
- `feedback-verification-gate-no-exceptions` — full gate ran on all 4 commits including the 3 docs-only ones (L5, L4, L4 addendum)

---

## State at retro write

- Local main = origin/main = `e90a0c7`
- Working tree clean
- Memory dir: 12 entries (unchanged from Group A retro close: 1 MEMORY.md + 11 feedback files)
- Branch protection state: API-inaccessible (private repo on free tier); state ambiguous per L4 addendum
- `pnpm audit --audit-level=high`: exit 0 (2 moderate remain via drizzle-kit chain, below threshold)
- Hook armed: mode 0755, `core.hooksPath = .husky/_`
