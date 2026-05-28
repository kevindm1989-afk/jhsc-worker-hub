# New project workflow

Use this when starting from scratch with a new project. For new features in
an existing project, use `orchestration.md` directly.

---

## 0. Pre-flight (one-time, 10 minutes)

Before the first task, set up:

1. **Edit `.context/preferences.md`** — fill in the blanks under code style,
   architecture taste, and risk posture. Be specific.
2. **Review `.context/constraints.md`** — confirm which regimes apply:
   - PIPEDA: always
   - Ontario PHIPA: only if health information
   - Ontario FIPPA/MFIPPA: only if government data
   - AODA: only for public-facing services
   - Quebec Law 25: only if Quebec users in scope
   - Other provinces: BC PIPA, Alberta PIPA, etc. if users there
   Remove sections that don't apply. Add any project-specific rules.
3. **Set up Claude Code** (if using):
   - The `.claude/agents/` directory is already in place
   - Verify subagents load: run `/agents` in Claude Code
4. **Install verification tooling** as the project takes shape:
   - Node: `eslint`, `prettier`, `typescript`, run `npm audit` regularly
   - Python: `ruff`, `mypy`, `pytest`
   - Cross-language: `semgrep`, `gitleaks`
5. **Verify the gate script runs**: `bash scripts/verify.sh`

---

## 1. Receive the prompt

User describes what they want. The prompt becomes the seed PRD.

Example: *"Build a small web app where members of my union local can submit
hazard reports anonymously. Reports should be visible to JHSC co-chairs only."*

**Orchestrator's first move**: ask clarifying questions before delegating.
Common gaps:
- Who are the users? How many? Authenticated how?
- What data is collected? What's the sensitivity?
- Where will it run? Who pays for hosting?
- What's the timeline? Is this a prototype or production-bound?
- Any existing systems to integrate with?

**Do not call any specialist agent until the spec is clear.** The architect
will refuse a vague spec; the threat-modeler will produce nonsense from one.

---

## 2. Phase 0: Initialize the project

Before any planning, set up the project skeleton:

```
1. scaffolder         → repo structure, CI, tooling, .gitignore, .env.example
                       → asks the user for stack/framework/hosting decisions
                       → outputs runnable verify.sh and CI workflows
2. observability-setup → logging, error tracking, metrics, alerts
                       → flags any required API keys (Sentry, etc.)
```

Phase 0 is run once per project, before Phase 1.

---

## 3. Phase 1: Plan

Once the spec is firm, run the planning agents in sequence:

```
1. architect       → system design, ADRs, task list
   → outputs to .context/decisions.md
2. threat-modeler  → threat model, data flows, PIPEDA mapping
   → outputs to .context/threat-model.md
3. designer        → design tokens, visual direction
   → outputs to design-tokens.json
```

**Synthesize for the user**:
- One-page summary of what we're building
- The flagged human-gate items
- Estimated task list
- Anything still ambiguous

**❗ HUMAN GATE: approval to proceed**

Don't move to Phase 2 until the user explicitly approves.

---

## 4. Phase 2: Build (loop per task)

For each task from the architect's task list:

```
For each task:
  1. test-writer       → failing tests
  2. implementer       → code to pass tests
  3. verifier          → run gate stack
     If fail → loop to step 2 (max 3 retries before escalating)
  4. security-reviewer ┐
     privacy-reviewer  │ parallel
     adversarial-review┘
     If any block → loop to step 2 (max 3 retries before escalating)
  5. Open PR
  ❗ HUMAN GATE: PR review and approval
  6. Merge
```

Default to **feature flags** for anything user-facing, so individual tasks
can ship to production behind a flag without user impact. This lets Phase 3
run mostly autonomously.

---

## 5. Phase 3: Ship

Once a coherent slice is ready:

```
1. deployer → deploy plan
   - Identifies safe-autonomous vs human-gate type
2. ❗ HUMAN GATE if regulated/irreversible
3. Execute deploy
4. Post-deploy verification
```

For first-time deploys (new project), always human-gate. Once the deploy
pipeline is proven and feature-flagged, subsequent deploys can be more
autonomous.

---

## 6. After shipping

- Append outcome to `.context/feedback-log.md` (the file is gitignored;
  seed it with `cp .context/feedback-log.template.md
  .context/feedback-log.md` if you haven't yet)
- If anything notable happened (bug found, surprise, new pattern), add
  to the appropriate `.context/` file — these *are* committed, so
  paraphrase and scrub names rather than pasting raw entries
- Continue with next task

---

## 7. Weekly

```
1. Run workflows/weekly-review.md (manual)
2. memory-curator → proposed updates
3. ❗ HUMAN GATE: approve each proposed update
4. User applies approved updates to .context/ files
```

This is the loop that makes the system actually learn. **Don't skip it.**

---

## What "prompt → app" actually looks like

Realistic timeline for a small project (say, the hazard-report app above):

- **Day 0**: prompt → clarifying questions → Phase 1 plan → human approval (1-2 hours of focused conversation)
- **Day 1-3**: Phase 2 loop, ~5-10 tasks, mostly autonomous with PR reviews
- **Day 3**: first feature-flagged deploy to staging
- **Day 4-5**: refinements, testing, second deploy
- **Day 5+**: human gate for production user enablement

That's ~5 days for a small project. Of those 5 days, you're actively engaged
maybe 4-6 hours total — clarifying the spec, approving the plan, reviewing
PRs, approving the deploy. The agents do the volume work.

The 4-6 hours are exactly where your judgment is most valuable. The system
is doing what you want.
