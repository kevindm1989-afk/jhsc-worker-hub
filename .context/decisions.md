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
- **SUPERSEDED 2026-05-28 — see entry below.**

## 2026-05-28 — Auth + step-up: Lucia v3 for identity, EdDSA JWT + opaque refresh for sessions

- **Decision:** Use Lucia v3 with the Drizzle adapter as the _identity layer_ (owns users + credential validation). Build sessions on top per SECURITY.md §3: HttpOnly `__Host-access` EdDSA JWT (30 min) + HttpOnly `__Host-refresh` opaque token (14 d, rotates on use). Step-up via short-lived `step_up_until` claim. Passkey-primary; password (Argon2id, libsodium) + TOTP fallback; 8 recovery codes. Brute-force ladder 5/10/20 from SECURITY.md §3.
- **Why:** Honors the locked stack (Lucia, EdDSA JWT, Argon2id, refresh-rotation) without re-opening either spec. Containment-first: no tokens in JS. Reversibility to bare-Oslo if Lucia v3 stops being viable is clean because the identity/session boundary is already drawn.
- **Audit during 1.2 → 1.3 gap:** flat `auth_events` table; 1.3's chained logger backfills via a hash-of-canonical-JSON anchor entry as chain row 2. Crypto stub uses libsodium `crypto_secretbox` with a `0x01` version byte for clean migration to real `packages/crypto` (XChaCha20-Poly1305) in 1.3.
- **Alternatives ruled out:** Lucia-default opaque-session-only (departs from SECURITY.md §3); bare Oslo (reopens CLAUDE.md stack lock without justification).
- **ADR:** [`docs/adr/0001-auth-and-step-up.md`](../docs/adr/0001-auth-and-step-up.md).

## 2026-05-28 — Retract substrate-before-Auth; follow ROADMAP 1.2 → 1.3 ordering

- **Decision:** Withdraw the prior entry. Build order follows `ROADMAP.md` as written: 1.1 Foundation → 1.2 Auth (Lucia, passkeys, password+TOTP, step-up helper, first-run setup) → 1.3 Encryption + Audit (`packages/crypto`, `packages/audit`, audit log table, verify script) → 1.4 Legal Corpus.
- **Why:** The ROADMAP is the canonical plan the project started from. Reordering it requires explicit deliberation, not a unilateral architect call. Auth-first introduces a documented gap (auth events not in the hash chain until 1.3 lands) that is acceptable because:
  1. 1.3 lands the same release and is sequenced immediately after 1.2.
  2. The first-run setup flow in 1.2 creates exactly one co-chair account; the window of unlogged auth events is tiny and pre-production.
  3. When 1.3 lands, the audit logger backfills a synthetic "system genesis" entry covering the 1.2 setup so the chain has no real gap from any auditor's perspective.
- **Alternatives ruled out:** Substrate-first (the retracted entry) — defensible on security grounds, but rewriting the ROADMAP sequencing belongs to a ROADMAP edit + approval cycle, not a `.context/` ledger entry that hides the change.
- **ADR:** none. The previous "pending ADR 0001-security-substrate-first" is cancelled. If, when 1.3 lands, the genesis-backfill design needs an ADR, the architect will draft one then.

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
