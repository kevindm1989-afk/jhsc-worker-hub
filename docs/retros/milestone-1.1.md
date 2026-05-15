# Milestone 1.1 — Foundation retro

**Date:** 2026-05-13
**Scope:** Repository scaffold for the JHSC Worker Hub. No product features
yet; this milestone establishes the workspace, services, design tokens, and
CI so subsequent milestones can land focused diffs.

## What shipped

Six commits on `main`, all pushed to `origin/main`:

| Group | Commit    | Title                                                                   |
| ----- | --------- | ----------------------------------------------------------------------- |
| A     | `7ad7c6f` | chore: scaffold pnpm workspace and tooling                              |
| B     | `535a8c5` | feat(web): scaffold app shell with theme provider and five primary tabs |
| C     | `04685a3` | feat(api): scaffold Hono service with health and workplace endpoints    |
| D     | `fd19c48` | feat(ai-proxy): scaffold Hono service with health endpoint              |
| E     | `5ef7779` | feat(ui): extract design tokens into @jhsc/ui workspace package         |
| F     | `6fb9aca` | ci: add GitHub Actions CI, gitleaks, dependabot, and PR template        |

The first CI run on commit `6fb9aca` (CI #1 and gitleaks #1) was green
across all jobs — verify, e2e (chromium), docker build, and gitleaks scan.

## Patterns that worked

**Plan-first review.** Every group started with a written plan covering
folder structure, dependencies, endpoint shapes, verification gate, commit
message, and silent-addition preemption. The plan was reviewed and
explicitly approved before any file write. Catches design mistakes when
they're cheap to fix.

**Silent-additions audit.** After each group's file writes, before
proposing the commit, we surfaced every deviation from the approved plan —
type alias exports, comment-text changes, dependency moves between
packages. Made implicit choices explicit and reviewable. The audit caught
real deltas (the lazy `getDb()` singleton in Group C, the
`@jhsc/ui` `ClassValue` re-export in Group E) that would otherwise have
been buried in diffs.

**Hard-blocking secret-name scan in commit pipelines.** Every commit ran
the same shell pipeline: stage explicit files → `git status --short` → scan
for `.env` / `*.key` / `secret`-named files → abort with `exit 1` on match
→ commit. Made it impossible to accidentally commit credential-named files
without the scan being noticed.

## The bug we found and fixed

Groups A and B used a secret-name scan with the wrong shape:

```bash
git diff --cached --name-only | grep -iE '(^\.env$|\.key$|secret)' || echo "(none — confirmed)"
```

The `|| echo` pattern is **visual-only** — when grep finds a match, it
exits 0, prints the offending filename, and the chain proceeds to
`git commit`. The "guard" wasn't blocking anything; it was just printing.
Both Group A and B happened to be clean so no harm occurred, but the
pattern wasn't doing the work it appeared to.

Caught in Group C when proposing the next commit pipeline. Fixed by
switching to:

```bash
SECRETS=$(git diff --cached --name-only | grep -iE '(^\.env$|\.key$|secret)' || true) && \
if [ -n "$SECRETS" ]; then echo "=== SECRET-NAMED FILES STAGED — ABORTING ==="; echo "$SECRETS"; exit 1; else echo "(none — confirmed)"; fi
```

The `if [ -n "$SECRETS" ]; then exit 1` block is what blocks. Groups C
through F all used this corrected form. The pattern is saved to
`feedback-commit-guard-hard-block` in auto-memory so future groups inherit
the working shape.

Lesson: when a shell pipeline's "check" relies on `|| echo`, ask whether
the chain still proceeds on a positive match. If yes, the check is
informational, not enforcement.

## Follow-up session: gitleaks allowlist

Two commits during the follow-up session on 2026-05-13:

- `70d185c` — `ci(gitleaks): allowlist local dev placeholder password`
- `5369ded` — `ci(gitleaks): drop v prefix from GITLEAKS_VERSION pin`

### Path-based vs regex-based allowlist

The plan going in proposed a path-based allowlist:

```toml
[allowlist]
paths = [
  '''(^|/)\.env\.example$''',
]
```

Rejected in favor of a regex-based allowlist scoped to the literal
placeholder string:

```toml
[allowlist]
regexes = [
  '''jhsc_dev_local_only''',
]
```

Reasoning: path-based allowlisting unconditionally exempts the entire
file. If a real credential were ever pasted into `.env.example` by
accident, gitleaks would not flag it — the path would be allowed
regardless of contents. The regex form keeps the rest of `.env.example`
(and any other file containing the same placeholder, e.g.
`docker-compose.yml`) under the default ruleset and exempts only the
known-fake string. Tighter blast radius for the same false-positive
suppression.

### Two lessons from the follow-up session

**`GITLEAKS_VERSION` `v` prefix.** Commit `70d185c` pinned
`GITLEAKS_VERSION: v8.30.1`. `gitleaks-action@v2` prepends `v` to the
`GITLEAKS_VERSION` value when constructing the release-download URL, so
`v8.30.1` became `vv8.30.1` and the download returned 404. The action
exited successfully without actually running gitleaks — a silent skip,
not a visible failure. Fixed in `5369ded` by pinning the bare semver
`8.30.1` and letting the action normalize it.

The pre-commit plan had flagged the `v`/no-`v` choice as "not 100% sure"
and we shipped without checking the action source. Lesson captured in
auto-memory as `feedback-verify-uncertain-config-values`: when a plan
marks a config value uncertain, read the upstream documentation or
source before picking — don't ship and find out from CI.

**`format:check` skip on the retro commit.** The pre-commit verification
gate was waived on `fd09b9a` (the retro itself) under "docs only"
reasoning. The gate is meant to run unconditionally — typecheck, lint,
`format:check`, and test on every commit, including docs-only commits.
Lesson captured in auto-memory as
`feedback-verification-gate-no-exceptions`: "docs only" is not a skip
reason. Markdown can drift past Prettier the same as TypeScript can.

## Outstanding follow-ups

State at end of session 2026-05-13:

- **~15 Dependabot PRs** open against `main`
  ([pulls](https://github.com/kevindm1989-afk/jhsc-worker-hub/pulls)). Most
  are major-version bumps that need real review and migration work:
  tailwindcss 3→4, zod 3→4, react-router-dom 6→7, jsdom 25→29,
  lucide-react 0→1, react 18→19 if present, tailwind-merge 2→3, globals
  15→17, eslint-plugin-react-hooks. Triage approach: group by ecosystem,
  evaluate breaking-change notes for each major, merge patch/minor in
  batches, defer or close majors that need follow-up migration work.
- **Fly.io provisioning.** Needs Fly CLI + credentials. Run `fly launch`
  against `apps/api/fly.toml` and `apps/ai-proxy/fly.toml` interactively.
- **Tigris bucket provisioning.** Needs `flyctl storage create`. Same
  interactive constraint as Fly.
- **Branch protection rules on `main`.** Require status checks (CI verify,
  CI e2e, CI docker, gitleaks scan), require linear history, restrict
  direct pushes. Run via `gh api` with a PAT scoped for repo
  administration.
