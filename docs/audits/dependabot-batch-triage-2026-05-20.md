# Dependabot Batch Triage — 2026-05-20

**Date:** 2026-05-20
**Scope:** Status snapshot of 9 open Dependabot PRs (all major-version bumps). Triage-only review; no merges this session.
**Outcome:** Risk-categorized 9 PRs across design-system / test-infrastructure / runtime / framework / routing groupings. Suggested ordering for future merge sessions.

---

## Context

Group B retro (commit `8083644`) named the older Dependabot batch as outstanding for future sessions. Today's session-close ledger missed `#6` (tailwindcss) — accounting correction surfaced during this triage. Full older batch = 7 PRs (`#6`, `#7`, `#9`, `#10`, `#11`, `#12`, `#14`), not the 6 previously listed. Combined with today's 2 newer arrivals (`#17`, `#18`), total open = 9 PRs.

This triage is the point-in-time snapshot captured in remaining budget after today's S6 pre-flight commit (`7fa4bb2`), before session close. No PR was investigated in depth (no PR diffs, no changelog reads); risk categorization is from titles + general package knowledge.

---

## Open PRs (status snapshot)

| PR  | Bump                                    | Created    | Scope                |
| --- | --------------------------------------- | ---------- | -------------------- |
| #6  | tailwindcss 3.4.19 → 4.3.0              | 2026-05-13 | Major                |
| #7  | globals 15.15.0 → 17.6.0                | 2026-05-13 | Major devDep         |
| #9  | eslint-plugin-react-hooks 5.2.0 → 7.1.1 | 2026-05-13 | Major devDep         |
| #10 | zod 3.25.76 → 4.4.3                     | 2026-05-13 | Major                |
| #11 | jsdom 25.0.1 → 29.1.1                   | 2026-05-13 | Major devDep         |
| #12 | react-dom + @types/react-dom            | 2026-05-13 | Unspecified versions |
| #14 | tailwind-merge 2.6.1 → 3.6.0            | 2026-05-13 | Major                |
| #17 | lucide-react 0.469.0 → 1.16.0           | 2026-05-20 | Major                |
| #18 | react-router-dom 6.30.3 → 7.15.1        | 2026-05-20 | Major                |

All 9 show `mergeable=UNKNOWN state=UNKNOWN` at time of triage — GitHub recomputing after today's 4 commits to `main` (`40ecabc`, `e90a0c7`, `8083644`, `7fa4bb2`). Same UNKNOWN-after-base-shift pattern observed with #16 yesterday; will settle to `MERGEABLE` or `CONFLICTING` after a refresh. Not investigated this session.

---

## Closed/superseded today

- **#8 closed** 2026-05-20T07:30:41Z (3 seconds after #18 created at 07:30:38Z) — superseded by #18 (newer react-router-dom version)
- **#13 closed** 2026-05-20T07:28:35Z (4 seconds after #17 created at 07:28:31Z) — superseded by #17 (newer lucide-react version)

Both closed without merge by Dependabot's "newer version available" supersession behavior. Neither was user-rejected.

---

## Risk categorization (per PR)

- **#6 tailwindcss 3 → 4** — known major-version migration (new engine, CSS-first config); touches every component; needs design-system block research before merge
- **#7 globals 15 → 17** — devDep; eslint globals registry; flat config compatibility check needed
- **#9 eslint-plugin-react-hooks 5 → 7** — caused a Group A CI failure (named in Group A retro `6e4f12b`); needs careful pre-flight
- **#10 zod 3 → 4** — runtime; documented breaking transition (new schema API in places); affects React Hook Form + Zod surface per CLAUDE.md
- **#11 jsdom 25 → 29** — devDep; ~4 majors in one bump; test env shift
- **#12 react-dom + @types/react-dom** — version detail not in PR title; could be React 18 → 19; needs `gh pr view` investigation before assessment
- **#14 tailwind-merge 2 → 3** — companion to #6; needs matching tailwindcss major
- **#17 lucide-react 0.469 → 1.16** — icon library; scope auditable via grep for icon imports
- **#18 react-router-dom 6 → 7** — routing major; v7 future-flag warnings already surface in `apps/web` tests (visible in test output today)

---

## Natural groupings

- **Design-system block:** #6 tailwindcss + #14 tailwind-merge — must merge together to avoid version mismatch; #17 lucide-react is adjacent UI but independent
- **Test infrastructure block:** #7 globals + #9 eslint-plugin-react-hooks + #11 jsdom — all devDeps, all touch test/lint pipeline
- **Runtime/schema:** #10 zod 3 → 4 — own scope; breaking changes documented upstream
- **Framework:** #12 react-dom — version detail needed before grouping; possibly couples with #18 if React 19
- **Routing:** #18 react-router-dom — independent; has known migration path via v7 future flags

---

## Suggested next-session ordering (low-risk first, not prescriptive)

1. #7 globals + #11 jsdom — both devDeps, narrow impact
2. #9 eslint-plugin-react-hooks — has CI-failure history; pre-flight research required
3. #17 lucide-react — icon library; scope auditable via grep
4. #6 + #14 tailwind block — design-system pair, requires together
5. #10 zod 3 → 4 — runtime; schema migrations may be needed
6. #12 react-dom — version detail needed first
7. #18 react-router-dom — future-flag warnings provide pre-laid migration path

---

## Caveats

- Triage is a point-in-time snapshot dated 2026-05-20 evening. Dependabot may rebase PRs, supersede them, or add new PRs daily — re-check before acting on any specific PR.
- `mergeable=UNKNOWN` across all 9: not investigated this session. Will settle on next query after GitHub recomputes against current `main`.
- Ordering is suggestive, not prescriptive. Specific session circumstances (CI status, time budget, schema complexity) may dictate different sequence.
- No PR was investigated in depth (no PR diff, no changelog reads, no version-detail check for #12). Risk categorization is from titles + general package knowledge.

---

## State at write

- Local main = origin/main = `7fa4bb2` (post-S6 pre-flight)
- Working tree clean prior to this commit
- Memory dir: 12 entries (unchanged this session)
- `pnpm audit --audit-level=high`: exit 0 (2 moderate remain via drizzle-kit path 1 per S6 pre-flight `7fa4bb2`)
- 9 open Dependabot PRs at triage; 2 Dependabot-superseded today (#8, #13)
