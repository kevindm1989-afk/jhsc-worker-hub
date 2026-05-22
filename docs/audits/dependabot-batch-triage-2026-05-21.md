# Dependabot Batch Triage — 2026-05-21

**Date:** 2026-05-21
**Scope:** Status snapshot of 7 open Dependabot PRs after today's S6 closure + #7/#11 merges. Successor to 2026-05-20 triage.
**Outcome:** Audit 2 moderate → 0 moderate via S6 (drizzle-kit 0.28.1 → 0.31.10 + pnpm.overrides). 2 of yesterday's 9 open PRs merged (#7 globals 17, #11 jsdom 29). 7 PRs carry forward.

---

## Context

Yesterday's triage (`4f31523`) categorized 9 open PRs and proposed an ordering — low-risk devDeps first. Today executed that ordering's top tier:

- S6 closure committed at `6006131` (drizzle-kit bump + pnpm.overrides; closes 2 moderate esbuild advisories — GHSA-67mh-4wv8-2f99 via drizzle-kit transitive chains)
- PR #11 jsdom 25 → 29 merged at `0291c48` (devDep, defensive matchMedia polyfill held)
- PR #7 globals 15 → 17 merged at `3eac400` (devDep, audioWorklet split no-impact on our 3 keys: browser/node/es2022)

This triage records what's executed, what remains, and updated risk framing for the 7 carry-forward PRs.

---

## Open PRs (status snapshot)

| PR  | Bump                                    | Created    | Scope                |
| --- | --------------------------------------- | ---------- | -------------------- |
| #6  | tailwindcss 3.4.19 → 4.3.0              | 2026-05-13 | Major                |
| #9  | eslint-plugin-react-hooks 5.2.0 → 7.1.1 | 2026-05-13 | Major devDep         |
| #10 | zod 3.25.76 → 4.4.3                     | 2026-05-13 | Major                |
| #12 | react-dom + @types/react-dom            | 2026-05-13 | Unspecified versions |
| #14 | tailwind-merge 2.6.1 → 3.6.0            | 2026-05-13 | Major                |
| #17 | lucide-react 0.469.0 → 1.16.0           | 2026-05-20 | Major                |
| #18 | react-router-dom 6.30.3 → 7.15.1        | 2026-05-20 | Major                |

Mergeable state: most likely shifted since `main` moved 3 commits today (`6006131`, `0291c48`, `3eac400`). Not all 7 were re-checked individually this session; state may be `UNKNOWN` or `CONFLICTING` and require Dependabot rebase before merge attempt — same pattern observed for #7 and #11 today.

---

## Closed/merged today

- **PR #11 merged** as `0291c48` by squash (Dependabot returned same SHA after rebase request — no actual rebase needed since branch was already cleanly mergeable against current main)
- **PR #7 merged** as `3eac400` by squash (same pattern: Dependabot's overnight rebase already mergeable against current main, no force-push needed)
- **S6 closure** landed at `6006131` (direct commit, not a Dependabot PR — drizzle-kit version bump + root `pnpm.overrides` block targeting `@esbuild-kit/core-utils>esbuild` ≥0.25.0)

Both PR merges retained `dependabot[bot]@users.noreply.github.com` as commit author rather than the repo owner doing the squash. Observed across both of today's squash-merges; consistent with `gh pr merge --squash` preserving PR author.

Carry-forward from yesterday's "Closed/superseded today" section: #8 and #13 remain closed (Dependabot supersession 2026-05-20T07:30:41Z and 07:28:35Z respectively).

---

## Risk categorization (per PR)

- **#6 tailwindcss 3 → 4** — known major-version migration (new engine, CSS-first config); touches every component; needs design-system block research before merge
- **#9 eslint-plugin-react-hooks 5 → 7** — caused a Group A CI failure (named in Group A retro `6e4f12b`); needs careful pre-flight
- **#10 zod 3 → 4** — runtime; documented breaking transition (new schema API in places); affects React Hook Form + Zod surface per CLAUDE.md
- **#12 react-dom + @types/react-dom** — version detail not in PR title; could be React 18 → 19; needs `gh pr view` investigation before assessment
- **#14 tailwind-merge 2 → 3** — companion to #6; needs matching tailwindcss major
- **#17 lucide-react 0.469 → 1.16** — icon library; scope auditable via grep for icon imports
- **#18 react-router-dom 6 → 7** — routing major; v7 future-flag warnings already surface in `apps/web` tests (visible in test output today)

---

## Empirical pattern from today's merges

Today's two devDep merges (#7 globals 15 → 17, #11 jsdom 25 → 29) both landed cleanly with no test or lint regressions. Notable patterns:

- **jsdom 4-major-jump** held under our defensive matchMedia polyfill (`apps/web/src/__tests__/setup.ts`). The polyfill's `if (typeof window.matchMedia !== 'function')` guard makes it safe across both "jsdom ships native matchMedia" and "jsdom doesn't" outcomes. 13/13 tests passed under jsdom 29.1.1.
- **globals 2-major-jump** had zero impact on lint despite the audioWorklet-split breaking change in v17, because our 3 imported keys (`globals.browser`, `globals.node`, `globals.es2022`) didn't touch the audioWorklet surface. ESLint clean under globals 17.6.0.

This is a 2-sample observation, not a rule. The pattern: **low-risk devDep majors with narrow usage surface tend to merge cleanly**. Does not generalize to:

- Runtime majors (#10 zod, #12 react-dom, #18 react-router-dom) — broader breaking-change surface
- Design-system block (#6 tailwindcss, #14 tailwind-merge) — touches every component
- #9 eslint-plugin-react-hooks — has documented CI-failure history in Group A retro

Empirical precedent does narrow expected risk for similar future devDep majors with narrow usage but should not substitute for per-PR pre-flight on broader-surface bumps.

---

## Natural groupings

- **Design-system block:** #6 tailwindcss + #14 tailwind-merge — unchanged from yesterday; must merge together to avoid version mismatch
- **Test infrastructure block:** #9 eslint-plugin-react-hooks (alone now; #7 and #11 cleared today)
- **Runtime/schema:** #10 zod 3 → 4 — own scope; breaking changes documented upstream
- **Framework:** #12 react-dom — version detail still needed before grouping; possibly couples with #18 if React 19
- **Routing:** #18 react-router-dom — independent; v7 future-flag warnings provide pre-laid migration path
- **Independent UI:** #17 lucide-react — independent of design-system block

---

## Suggested next-session ordering (re-ordered for today's reality)

1. **#9 eslint-plugin-react-hooks** — has CI-failure history (Group A retro); pre-flight research required; was yesterday's #2 priority
2. **#17 lucide-react** — independent UI; scope grep-auditable via icon imports; likely low-risk based on package class
3. **#6 + #14 tailwindcss block** — design-system pair; must merge together; major-version migration with new engine
4. **#10 zod 3 → 4** — runtime; schema migrations may be needed
5. **#12 react-dom** — version detail check needed first
6. **#18 react-router-dom** — v7 future-flag warnings provide migration breadcrumbs

Ordering shifted vs yesterday: #7 + #11 cleared today (was yesterday's #1). #9 promoted to #1 of remainder. Rest follows yesterday's shape minus completed items.

---

## Caveats

- Triage is a point-in-time snapshot dated 2026-05-21 evening. Dependabot may rebase PRs, supersede them, or add new PRs daily — re-check before acting on any specific PR.
- Mergeable status for 7 remaining PRs not re-checked individually this session — most likely require Dependabot rebase before attempt (same pattern as today's #7 and #11).
- Same depth caveat as yesterday's doc applies: no PR investigated in depth this session beyond what the S6 / #7 / #11 closures required.
- The "low-risk devDep majors merge cleanly" pattern is a 2-sample observation, not a rule. #9 broke CI in Group A — empirical evidence that breakage is possible even in devDep classes.

---

## State at write

- Local main = origin/main = `3eac400` (post-#7 globals merge)
- Working tree: pending this doc write
- Memory dir: 13 entries (was 12 yesterday; +feedback-surface-state-before-drilldown)
- `pnpm audit --audit-level=moderate`: exit 0, "No known vulnerabilities found" (was: 2 moderate per S6 pre-flight at `7fa4bb2`)
- 7 open Dependabot PRs; 2 merged this session (#7, #11); S6 closed; no new PRs since 2026-05-20
