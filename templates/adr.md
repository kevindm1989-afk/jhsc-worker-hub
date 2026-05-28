# ADR-NNNN: [Title]

**Status:** Proposed / Accepted / Deprecated / Superseded by ADR-XXXX
**Date:** YYYY-MM-DD
**Decider(s):** [name(s)]

---

## Context

[What is the problem we're solving? What constraints apply? What's the
current situation? Be specific. An ADR without context is just a decree.]

## Decision drivers

- [Driver 1: e.g., "Must support Canadian data residency"]
- [Driver 2: e.g., "Must be reversible within 30 days"]
- [Driver 3: ...]

## Options considered

### Option A: [Name]

**Description:** ...

**Pros:**

- ...

**Cons:**

- ...

### Option B: [Name]

**Description:** ...

**Pros:**

- ...

**Cons:**

- ...

### Option C: [Name]

[...]

## Decision

**We choose Option [X].**

### Rationale

[Why this option over the alternatives. Reference the decision drivers.
Explain the tradeoffs accepted.]

### Reversibility

- **Easy** / **Medium** / **Hard** to reverse
- [Explain what reversal would entail]

## Consequences

### Positive

- [What this enables]
- ...

### Negative / accepted tradeoffs

- [What this gives up or makes harder]
- ...

### Risks

- [What could go wrong with this choice]
- [Mitigation plan if any]

## Compliance check

- [ ] Aligns with `.context/constraints.md` (PIPEDA, Ontario regimes)
- [ ] Threat model updated if architectural
- [ ] No cross-border transfer added without human approval
- [ ] No new subprocessor without DPA

## Follow-ups

- [ ] [Specific action item]
- [ ] [Another]

---

## How to use this template

1. Number ADRs sequentially: ADR-0001, ADR-0002, ...
2. Store in `docs/decisions/` or copy the accepted text into `.context/decisions.md`
3. **Don't delete superseded ADRs** — mark them, link to the new one
4. Keep them short — a one-page ADR beats a five-page one that nobody reads
5. The architect agent uses this format; you can use it manually too
