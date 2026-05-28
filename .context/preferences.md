# Working Preferences

How I like to work. Every agent reads this before any task.

Fill in the blanks. Update it whenever you correct an agent for something
that wasn't a one-off mistake but a taste mismatch.

---

## Communication

- Be direct and objective. Skip filler, sycophancy, and "great question!"
- Lead with an executive summary for any answer over ~300 words.
- Bold key terms; use bullets for procedures and checklists, not for prose.
- Show reasoning step by step for non-trivial decisions.
- Flag tradeoffs, weaknesses, and uncertainties proactively. Don't pretend
  confidence I shouldn't have.
- If a request is ambiguous, ask before assuming.

## Code style

- Language: TypeScript (Node.js runtime by default; framework chosen per project).
- Formatter / linter: Prettier + ESLint with project-level config.
- Naming: camelCase for variables and functions, PascalCase for types and classes.
- Comments: only when the WHY isn't obvious from the code — hidden constraints,
  invariants, workarounds. No restating what the code does.
- Tests: colocated with source, named `*.test.ts`.

## Architecture taste

- Simple over clever, unless the clever version is documented.
- Dependency tolerance: pragmatic — popular, well-maintained libraries are fine
  when they save real time. Avoid niche or single-author packages.
- Database choice for new work: SQLite for local and small projects; Postgres
  once scale (concurrent writers, multi-host, or real data volume) demands it.
- When I accept duplication vs. abstraction: rule of three — two copies is fine,
  extract on the third occurrence. A wrong abstraction is worse than duplication.

## Risk posture

- Reversible changes: ship direct for trivial work; flag only risky or
  high-blast-radius changes (new user-facing flows, perf-sensitive paths,
  anything touching money or auth UX).
- Irreversible changes require my explicit approval before agents act:
  schema migrations, deletes, auth/permission changes, billing logic.
  Never auto-apply.
- Production data: agents may read non-PII tables freely; any query touching
  PII requires explicit per-query approval. No writes to prod without approval.

## What I want surfaced

- Security concerns: always.
- Accessibility concerns: always.
- Performance implications: when changing hot paths or bundle size.
- Cost implications (API calls, infra): when non-trivial.

---

*This file grows. Every time you correct an agent for not matching your taste,
ask whether the correction belongs here.*
