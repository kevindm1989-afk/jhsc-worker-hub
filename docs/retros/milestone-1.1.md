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

## Follow-ups for tomorrow

**gitleaks allowlist.** Dependabot's PR runs are tripping gitleaks on
`apps/api/.env.example` — likely on the `jhsc_dev_local_only` placeholder
password or another low-entropy string. Add a `.gitleaks.toml` with an
allowlist scoped to `.env.example` files:

```toml
[allowlist]
paths = [
  '''(^|/)\.env\.example$''',
]
```

Verify by re-running gitleaks against the existing PRs. Confirm CI on
commit `6fb9aca` itself stays green (it already is).

**Dependabot PR triage.** ~15 PRs opened the moment `dependabot.yml`
landed. Most are major-version bumps that need real review:

- `tailwindcss` 3 → 4 — breaking change (config format, content syntax).
  Defer; pin to `^3` in `packages/ui` and `apps/web` if needed.
- `jsdom` 25 → 29 — breaking change to test environment. Check vitest
  setup before merging.
- React 18 → 19, react-router-dom 6 → 7, vite 7 → 8 (if surfaced) —
  each is its own evaluation.
- Patch and minor bumps — likely safe-merge after CI passes.

Triage approach: group by ecosystem, evaluate breaking-change notes for
each major, merge patch/minor in batches, defer or close majors that need
follow-up work.

**Pending infrastructure for Milestone 1.1 that did not land as code:**
Fly.io project provisioning, Tigris bucket provisioning, branch protection
on `main`. These need the user's CLIs and credentials; out of scope for
the scaffold groups.
