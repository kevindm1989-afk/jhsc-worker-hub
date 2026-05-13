## Summary

<!-- 1–3 bullets: what changed and why -->

## Test plan

- [ ]

## Quality bar (CLAUDE.md)

- [ ] Tests pass (unit + e2e if applicable)
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm format:check` clean
- [ ] No `console.log` in committed code
- [ ] No hardcoded workplace/person identifiers; identity reads from `config/workplace.ts`
- [ ] No legal citations outside `packages/legal-corpus`
- [ ] If touching sensitive paths: encryption + audit event emitted
- [ ] If touching UI: WCAG 2.2 AA verified; mobile flow tested at 390px
- [ ] If migration: append-only, never edits existing migrations
