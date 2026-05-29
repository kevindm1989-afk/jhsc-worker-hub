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

## 2026-05-29 — Milestone 1.3: production XChaCha20-Poly1305 envelope + tamper-evident audit chain

- **Decision:** Land `packages/shared-types`, `packages/crypto`, `packages/audit` per ADR-0002. `packages/crypto` adds the wire-format v=0x02 (XChaCha20-Poly1305) writer + v=0x01 backward-read + lazy `rewrap()` migration. Envelope encryption (per-record DEK sealed by workplace KEK) lands for heavyweight tables (1.5+); auth-surface tables stay on the single-key path. `packages/audit` provides hash-chained `append()` and `verify()`. The `audit_log` migration preseeds genesis (idx=0) and the 1.2 `auth_events` backfill anchor (idx=1) so the chain is verifiable from the first deploy of 1.3.
- **Why:** Closes CLAUDE.md non-negotiables #2 (tamper-evident logging) and #4 (encryption with operator-controlled keys), retires the 1.2 crypto stub on the documented version-byte path, and locks the 1.2 auth_events table into the chain by hash — addressing the Slice 9 reviewers' "documented residual" on the 1.2 → 1.3 audit gap.
- **Also closes:** security-reviewer F6 (multi-kid JWT verifier via kid-suffix env-var registry), runbook §4-step-3 gap (TOTP reset endpoint + UI), and the step-up modal that was deferred from Slice 6 (lands as a side effect of TOTP-reset's step-up requirement).
- **Alternatives ruled out:**
  - Single `packages/security` bundling crypto + audit — conflates two review surfaces with different protocols; legal-corpus (1.4) would pull a security blob it doesn't need.
  - Stay inline in `apps/api` — violates CLAUDE.md's "shared-types/crypto/audit are packages" lock and forces the AI proxy (3.2) to duplicate the primitives.
- **ADR:** [`docs/adr/0002-encryption-and-audit-chain.md`](../docs/adr/0002-encryption-and-audit-chain.md).

## 2026-05-29 — Defer per-IP auth rate-limit middleware (security-reviewer F3)

- **Decision:** Ship Milestone 1.2 without the SECURITY.md §3 "10 req/min/IP on auth endpoints" rate-limit middleware. Track as a Milestone 1.12 (Release 1 Hardening) follow-up.
- **Why:** Three layers already hold the line in the pre-Release 1 window: (a) the lockout ladder (slice 2, `auth/lockout.ts`) trips at 5/10/20 failures across per-id OR per-IP; (b) Argon2id at SECURITY.md §3 params (64 MB / 3 ops) caps the per-attempt CPU at ~50 ms per IP; (c) the CSRF header guard (security-reviewer F1, shipped) blocks the simple form-spray case. A distributed attacker can still grind ~20 tries/s, but cannot avoid tripping the per-identifier ladder for a targeted account. Adding a Postgres-or-memory rate-limiter mid-milestone introduces a new dep + a per-request DB hop that wasn't planned for 1.2; better to land it during 1.12's hardening pass when the threat-modeler reviews against expected production traffic shape.
- **Alternatives ruled out:**
  - Hand-rolled in-memory ring buffer per Hono process — restarts and multi-machine deploys silently drop the counter; not honest.
  - Add `hono-rate-limiter` now — small dep but a meaningful behavioral change one milestone before the hardening pass that would re-evaluate the limits anyway.
- **ADR:** none. Follow-up tracked as a ROADMAP 1.12 line item: "Add per-IP auth-endpoint rate-limit middleware (closes security-reviewer Milestone 1.2 F3)."

## 2026-05-29 — Defer multi-kid JWT verifier (security-reviewer F6)

- **Decision:** `apps/api/src/auth/jwt.ts` continues to consult exactly one Ed25519 keypair via the bare `AUTH_JWT_ED25519_PRIVATE_KEY_B64` / `_PUBLIC_KEY_B64` env vars. The `kid` header is set on issuance but the verifier does not consult a registry. JWT key rotation therefore remains a hard cut in 1.2 (every in-flight session breaks; reps re-sign-in).
- **Why:** Multi-kid verification is operationally only useful when there's nontrivial active-session volume; with a single co-chair in 1.2 the calendar cost of "re-sign-in once" during the annual rotation is ~30 seconds. Adding the per-kid env-var convention now would push churn into the runbook (`docs/runbooks/auth.md` §3 already documents the multi-kid path as a TODO so the procedure does not pretend it exists). Land the registry alongside the 1.3 `packages/crypto` work where key-handling churn is already on the docket.
- **Alternatives ruled out:** Ship multi-kid now — risk/value trade is poor against an audience-of-one for the rotation window.
- **ADR:** none. Follow-up tracked as part of Milestone 1.3 "Encryption + Audit" alongside `packages/crypto` and the chain backfill.

## 2026-05-29 — Defer recovery-code generation endpoint (security-reviewer F9)

- **Decision:** Ship 1.2 without `POST /api/auth/recovery-codes/regenerate` and without the matching Account → Security UI panel. The primitives (`auth/recovery-codes.ts`, the `recovery_codes` table, the `password/recovery` login endpoint) all land in 1.2; only the generation path is deferred. The 1.2 setup-view "done" copy was updated in the same Slice-9-fixup commit to not promise the missing endpoint — reps are told to keep the authenticator backed up and that an administrator can reset access via the runbook.
- **Why:** Generation is gated by step-up auth. Step-up requires either a passkey assertion or a TOTP — both of which the rep already has in 1.2. The forgot-everything path is the admin-CLI logout-all + re-enrollment runbook (auth.md §4). Recovery codes are an additional convenience layer the project can land in 1.12 hardening alongside passkey rename/delete and TOTP reset UI, all of which need the same step-up wiring.
- **Alternatives ruled out:** Ship the endpoint without UI — half-finished; violates CLAUDE.md "no half-finished implementations." Ship the endpoint AND a minimal UI now — adds ≥ 1 day to the milestone, plus a step-up modal component (deferred from Slice 6) it would need first.
- **ADR:** none. Follow-up tracked as a ROADMAP 1.12 line item: "Recovery-code regeneration endpoint + Account → Security UI (closes security-reviewer Milestone 1.2 F9). Requires step-up modal component (deferred from Slice 6)."

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
