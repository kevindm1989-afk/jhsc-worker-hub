# Feedback Log — TEMPLATE

This is the **template** for the feedback log. The live file
(`.context/feedback-log.md`) is **gitignored on purpose**: raw entries
often contain real ticket excerpts, customer names, incident specifics,
or other content that should not land in version control. Only the
curated, sanitized output (in `lessons.md`, `patterns.md`,
`decisions.md`) gets committed.

## Setup (once per project)

```
cp .context/feedback-log.template.md .context/feedback-log.md
```

Then start appending entries to the live file. The librarian and
memory-curator read `.context/feedback-log.md`, not this template.

---

# Feedback Log

Raw outcomes of agent tasks. The signal everything else feeds on.

Append newest on top. Keep entries short — one line is fine if that's all the
task warrants. The weekly review reads this file to find patterns.

**Do not paste secrets, full PI records, or anything you wouldn't want
read aloud at a stand-up.** Use IDs and short paraphrases. The curated
lessons that come out of the weekly review are what should travel; the
raw log is local context.

---

## Format

```
## YYYY-MM-DD HH:MM — Task name

**Asked for:** brief.
**Got:** brief.
**Signal:** shipped-as-is / fixed-then-shipped / rejected.
**Note:** anything worth surfacing in the weekly review.
```

---

## Entries
