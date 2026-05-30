# Orchestration

How the 31 agents wire together. **You are the orchestrator** — read this and delegate.

---

## The agents (31 total)

**Core lifecycle (17):**

- librarian, scaffolder
- architect, threat-modeler, designer
- test-writer, implementer
- verifier, security-reviewer, privacy-reviewer, adversarial-reviewer, second-opinion-reviewer, performance-watcher, docs-keeper
- release-manager, migration-handler, deployer

**Operations (4):**

- observability-setup, incident-responder, rollback-orchestrator, dependency-manager

**Learning (1):**

- memory-curator

**Specialists, called when applicable (9):**

- mobile-specialist — for any mobile work
- ml-data-specialist — for ML, training, data pipelines
- product-analytics — for usage tracking and A/B testing
- cost-manager — for spend management
- accessibility-specialist — for deep a11y beyond automated checks
- localization-specialist — for multi-language, especially French/Canadian
- support-liaison — for incoming user reports
- sre-specialist — for mature systems needing SLO discipline
- tech-writer — for user-facing copy

---

## When to call specialists

Specialists are called by the orchestrator (or by core agents that recognize
the need) when the work crosses into their domain:

| Trigger                                   | Specialist                   |
| ----------------------------------------- | ---------------------------- |
| Building for iOS/Android (any)            | mobile-specialist            |
| Training a model, building a pipeline     | ml-data-specialist           |
| Adding analytics events or A/B test       | product-analytics            |
| Cloud/API spend trends growing            | cost-manager (weekly)        |
| Public-facing UI shipping                 | accessibility-specialist     |
| Quebec users, federal services, bilingual | localization-specialist      |
| User reports flowing in                   | support-liaison (continuous) |
| Production traffic, uptime commitments    | sre-specialist               |
| User-facing copy, onboarding, emails      | tech-writer                  |

Specialists don't replace core agents — they layer on. A mobile feature still
goes through test-writer, implementer, reviewers, verifier, deployer; the
mobile-specialist provides platform-specific input at each step.

---

## The full flow with specialists

```
User prompt
   │
   ▼
┌─ Phase 0: Initialize (once per project) ────────┐
│  scaffolder  → repo setup, CI, tooling          │
│  observability-setup → instrumentation          │
└─────────────────────────────────────────────────┘
   │
   ▼
┌─ Phase 1: Plan ─────────────────────────────────┐
│  librarian / architect / threat-modeler /       │
│  designer                                       │
│  + mobile-specialist (if mobile)                │
│  + ml-data-specialist (if ML)                   │
│  + localization-specialist (if multi-language)  │
│  + accessibility-specialist (if public UI)      │
│  ❗ HUMAN GATE: approve plan                    │
└─────────────────────────────────────────────────┘
   │
   ▼
┌─ Phase 2: Build (loop per task) ────────────────┐
│  test-writer → implementer                      │
│  + tech-writer (for user-facing copy)           │
│  → verifier + security + privacy + adversarial  │
│    + performance-watcher (if hot path)          │
│    + second-opinion (if critical)               │
│    + accessibility-specialist (if UI)           │
│    + mobile-specialist (if mobile)              │
│    + ml-data-specialist (if ML)                 │
│  → docs-keeper                                  │
│  ❗ HUMAN GATE: PR review                       │
└─────────────────────────────────────────────────┘
   │
   ▼
┌─ Phase 3: Ship ─────────────────────────────────┐
│  release-manager → migration-handler → deployer │
│  + product-analytics (set up tracking)          │
│  ❗ HUMAN GATE: deploy approval if regulated    │
└─────────────────────────────────────────────────┘
   │
   ▼
┌─ Phase 4: Operate (continuous) ─────────────────┐
│  incident-responder, rollback-orchestrator,     │
│  dependency-manager                             │
│  + support-liaison (triage user reports)        │
│  + cost-manager (weekly cost review)            │
│  + sre-specialist (when mature)                 │
│  + product-analytics (interpret usage)          │
└─────────────────────────────────────────────────┘
   │
   ▼
┌─ Phase 5: Learn (weekly + post-incident) ──────┐
│  memory-curator → propose .context/ updates    │
│  ❗ HUMAN GATE: approve each update             │
└─────────────────────────────────────────────────┘
```

---

## Decision logic for orchestrator

Per prompt, decide:

**Domain triggers:**

- Mobile platform mentioned → mobile-specialist
- ML/training/inference/data pipeline mentioned → ml-data-specialist
- "Quebec," "French," "bilingual" → localization-specialist
- Public-facing UI → accessibility-specialist
- "Track," "metric," "A/B test" → product-analytics
- User-facing strings/onboarding/emails → tech-writer

**Phase triggers:**

- New project → start at Phase 0
- Feature → Phase 1 + 2 + 3
- Bug fix → Phase 2 with specific failing test
- Incident → Phase 4 immediately, root cause to Phase 5
- Production launch milestone → bring in sre-specialist

**Operational rhythm:**

- Weekly: memory-curator, dependency-manager, cost-manager
- Monthly: reliability scorecard, accessibility-specialist sweep
- Continuous: incident-responder, support-liaison

---

## Disagreement resolution

- security-reviewer / privacy-reviewer findings cannot be overridden by other agents
- verifier on mechanical gates is final
- accessibility-specialist findings against AODA cannot be overridden
- Specialist findings in their domain trump generalist agents
- All else: surface to user

---

## Autonomy levels

| Action                                                 | Autonomy                          |
| ------------------------------------------------------ | --------------------------------- |
| Run verifier                                           | Full                              |
| Apply lint/format/dependency-patch fixes               | Full                              |
| Merge after all gates pass + PR template complete      | Human approval (low friction)     |
| Deploy to staging                                      | Full (auto on main)               |
| Deploy to production (flag-off code)                   | Full (feature stays dark)         |
| Enable feature flag to 1%                              | Full if auto-rollback wired       |
| Enable feature flag to 10%/50%/100%                    | Full if metrics show healthy      |
| Apply critical-CVE security patch                      | Full after verifier passes        |
| Apply major version dependency bump                    | Human approval                    |
| Run a database migration in staging                    | Full                              |
| Run a database migration in production                 | Human approval, always            |
| Roll back on auto-rollback trigger                     | Full                              |
| Roll back on human decision                            | Full after authorization          |
| Restore from backup                                    | Human approval, always            |
| Send breach notification                               | Human (with legal review)         |
| Apply translation updates from translation pipeline    | Human approval                    |
| Run a chaos test in staging                            | Full                              |
| Run a chaos test in production                         | Human approval, always            |
| Roll out an A/B test                                   | Human approval (product decision) |
| Respond to a user support ticket                       | Never — humans only               |
| Make a cost optimization recommendation                | Full (recommendation, not action) |
| Apply a cost optimization (e.g., delete unused volume) | Human approval                    |

---

## What the orchestrator NEVER does

Even with 31 agents:

- Talk directly to end users (support-liaison drafts; humans send)
- Make product strategy decisions
- Commit to commercial terms
- Respond to regulators (OPC, IPC, CAI)
- Hire, fire, or evaluate team members
- Decide what features matter
- Make hiring or vendor decisions (cost-manager recommends; humans decide)
- Send breach notifications (drafted by humans with legal)
- Make accessibility decisions about reading level, language coverage, etc. without product input
