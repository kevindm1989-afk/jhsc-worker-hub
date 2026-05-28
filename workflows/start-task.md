# Start of task

30 seconds. Every non-trivial task.

## Manual version

1. Open `.context/constraints.md`. Surface any rule that touches this task.
   Especially: personal information, auth, third parties, cross-border data.
2. Open `.context/preferences.md`. Glance at it.
3. Open `.context/glossary.md`. Note any project-specific terms relevant to the task.
4. Skim `decisions.md` and `patterns.md` for anything touching this task.
5. Skim `lessons.md` for anything that applies.
6. Paste the relevant bits into your prompt with: _"Read this first."_

## With Claude Code

Invoke the librarian agent with the task description. It does steps 1–5 and
returns a briefing. Pass that briefing along with the task to the agent
doing the actual work.

## If the friction is too high

The friction here is the whole point — but it should be 30 seconds, not five
minutes. If reading the files is hard, the files have grown too long or
disorganized. Fix the files, not the workflow:

- Split a file into a folder of topic files when it gets past ~500 lines.
- Archive old entries that haven't been referenced in 90+ days.
- Add a short index at the top of any file long enough to need one.
