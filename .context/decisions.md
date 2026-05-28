# Decisions Ledger — JHSC Worker Hub

Append-only. Each entry: date, decision, why, alternatives ruled out, link to ADR if one exists. Never edit a past entry; supersede it with a new dated entry.

The locked tech stack and non-negotiables in `CLAUDE.md` are the canonical project-level decisions. This ledger records decisions that refine, extend, or supersede them.

---

## 2026-05-28 — Adopt agent-os pack into the repo
- **Decision:** Vendor `.claude/agents/`, `.context/`, `workflows/`, `templates/` from the agent-os pack into this repo.
- **Why:** Locks orchestration, sub-agent roster, and quality gates into source control so contributors and Claude sessions share the same playbook. Avoids drift between the pack and the project.
- **Alternatives ruled out:**
  - Reference the pack out-of-tree via a symlink — fragile in CI and remote sessions.
  - Reimplement agent prompts ad-hoc per task — defeats the point of the pack.
- **ADR:** none (operational, not architectural).

## 2026-05-28 — Build security substrate before Auth
- **Decision:** Implement `packages/shared-types`, `packages/crypto`, `packages/audit`, `audit_log` table, and `scripts/audit-log-verify.ts` before standing up Lucia Auth.
- **Why:** Auth events (signup, login, step-up, key rotation) are the first thing that needs to be audit-logged and crypto-bound. Building Auth first would either skip audit (creating an evidentiary gap from day one) or require rework. The substrate is also the gate that every later sensitive module (Minutes, Inspections, Exports) depends on.
- **Alternatives ruled out:**
  - Auth first, retrofit audit later — leaves a forensic gap covering the most sensitive lifecycle events.
  - Audit log as plain table — fails CLAUDE.md non-negotiable #2 (tamper-evident).
- **ADR:** pending (architect to draft `docs/adr/0001-security-substrate-first.md` in Chunk 1).

---

## How to add an entry

Use this template:

```
## YYYY-MM-DD — <one-line decision>
- **Decision:** what we will do.
- **Why:** the forcing function, in 1–3 sentences.
- **Alternatives ruled out:** name them and say why they lost.
- **ADR:** link to `docs/adr/NNNN-*.md` if one exists; otherwise "none" with reason.
```
