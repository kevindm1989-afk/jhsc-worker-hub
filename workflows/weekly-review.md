# Weekly review

10 minutes. Once a week. **Without this, nothing learns.**

## 1. Read the feedback log

Open `.context/feedback-log.md`. Read every entry since last review.

> The feedback log is **gitignored on purpose** — it accumulates raw
> entries that may include ticket excerpts, names, and incident
> specifics. First-time setup: `cp .context/feedback-log.template.md
> .context/feedback-log.md`. If the file isn't there, you haven't
> seeded it yet.

## 2. Find the patterns

For each task, ask:

- Did I correct the agent? What did I correct?
- Did this correction come up before?
- Is there a rule that would have prevented the correction?

## 3. Update the files

Sort each insight into one bucket:

| Insight type | Goes in |
|---|---|
| A correction about how I want things done | `preferences.md` |
| A reusable code or design pattern | `patterns.md` |
| A project-wide architectural choice | `decisions.md` |
| A mistake worth not repeating | `lessons.md` |

Don't write essays. Three sentences and an example is enough for most entries.

## 4. Prune

Once a month, not weekly:

- Patterns not referenced in 90 days → delete or move to `archive.md`.
- Preferences that have been overridden by your actual behavior → update.
- Decisions superseded by newer ones → mark them, don't delete.

Pruning is more valuable than adding. A bloated knowledge base is worse than
a sparse one, because the librarian retrieves stale rules and agents follow them.

## 5. Measure (optional, but useful)

Track three numbers monthly:

- **First-pass acceptance rate** — % of agent outputs you ship unchanged. Should rise.
- **Time-to-merge** for an average task. Should fall.
- **Mapped corrections** — % of your corrections that match an existing entry.
  High = system is working. Low = entries are stale or the librarian isn't
  retrieving them.

If the numbers are flat or worsening after a few months, the system has a problem.
The usual culprits: bloated files, stale patterns, or entries the librarian
isn't surfacing when it should. Audit and prune.

---

## When the weekly review starts feeling heavy

The **memory-curator** agent is built specifically for this. Invoke it with:

```
"memory-curator: review feedback from the past 7 days and propose updates
to .context/"
```

It produces a structured proposal of additions and prunings. You approve each
one explicitly — it never auto-applies — and then you make the actual edits.
This shifts the weekly review from "pattern hunting" to "approving proposals,"
which is faster and more honest about what's signal vs. noise.
