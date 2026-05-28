# Prompt templates

Reusable prompts for the four most common tasks. Copy, fill in, paste.

These are starting points — adjust to fit each task. The goal is to surface
the right context to the orchestrator without you having to remember
everything every time.

---

## Build a new feature

```
TASK: Build a new feature

WHAT: [one sentence: what should this feature do]

WHO: [target user(s) — be specific]

WHY: [the user need it solves, or the business reason]

ACCEPTANCE:
- [user-visible behavior 1]
- [user-visible behavior 2]
- [edge cases or constraints]

NOT IN SCOPE: [things to explicitly defer]

CONTEXT:
- Touches: [files / modules / services if known]
- Personal data: [yes / no / what kind]
- Auth required: [yes / no / role-restricted]
- Public-facing: [yes / no]

ORCHESTRATOR NOTES:
- Run librarian first
- Phase 1 (architect, threat-modeler, designer if UI) before any code
- Phase 2 build loop per task
- Phase 3 deploy plan with feature flag
- If any specialist trigger applies (mobile, ML, multi-language, public UI,
  Quebec users, analytics), bring them in at the right phase
```

---

## Fix a bug

```
TASK: Fix a bug

SYMPTOM: [what's wrong from a user's perspective]

REPRO STEPS:
1. ...
2. ...
3. Expected: ... / Actual: ...

WHEN STARTED: [if known — first reported, first observed, last known good]

SUSPECTED CAUSE: [if any leads — recent deploy, config change, etc.]

IMPACT: [users affected, frequency, severity]

CONTEXT:
- Touches: [files / modules if known]
- Personal data: [does the bug expose or corrupt PII?]
- Severity: [P0/1/2/3 per playbooks/incident-response.md]

ORCHESTRATOR NOTES:
- Run librarian first
- If P0/P1: skip to incident-responder
- Test-writer writes a failing test that reproduces the bug FIRST
- Implementer fixes ONLY enough to make the test pass
- Full verifier + reviewers before merge
- Add a lessons.md entry after fix
```

---

## Refactor

```
TASK: Refactor

WHAT: [the area being refactored]

WHY: [the specific problem you're solving — performance, readability, removing
duplication, paying down debt. "Just cleaner" is not enough.]

SUCCESS CRITERIA:
- All existing tests still pass (no behavior change)
- [specific improvement metric: lines of code, complexity, query count, etc.]
- [reviewability: the refactor should be readable in one sitting]

OUT OF SCOPE:
- Behavior changes
- API changes
- New features

CONTEXT:
- Touches: [files / modules]
- Test coverage in the area: [strong / weak / unknown]
- Risk level: [low if pure rename / high if structural]

ORCHESTRATOR NOTES:
- Run librarian first
- DO NOT call test-writer for new tests (existing tests must hold)
- If existing tests are weak, recommend strengthening BEFORE refactoring
- Implementer makes minimal changes
- Adversarial-reviewer focus: did behavior actually stay the same?
- No deploy — refactors merge with normal PR review
```

---

## Investigate / spike

```
TASK: Investigate or spike

QUESTION: [the specific thing you want to know]

WHY IT MATTERS: [what decision depends on the answer]

TIME BUDGET: [how long you're willing to spend before deciding to stop]

DELIVERABLE: [a doc with findings / a working prototype / a decision recommendation]

CONSTRAINTS:
- This is exploratory; code may be thrown away
- Do NOT add to production paths
- Do NOT update .context/ files based on spike output (only on confirmed findings)

ORCHESTRATOR NOTES:
- Run librarian first
- This bypasses the full verification stack
- Output goes to /experiments or a draft branch
- After conclusion: if findings are durable, promote to a real task
  with full pipeline; if not, document what was learned and discard
```

---

## Tips for using these

- **The acceptance criteria are the most important section.** Vague acceptance produces vague code.
- **Be honest about scope.** "In scope" creep is the #1 cause of long tasks.
- **The orchestrator notes can be edited.** As you learn your project's needs,
  refine these prompts in this file rather than re-explaining each time.
- **One task per prompt.** If a prompt has multiple acceptance criteria across
  different concerns, split it.
