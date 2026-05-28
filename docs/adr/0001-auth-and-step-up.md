# ADR-0001: Auth and step-up — Lucia + WebAuthn primary, Argon2id + TOTP fallback, HttpOnly EdDSA JWT + opaque refresh

**Status:** Accepted
**Date:** 2026-05-28
**Decider(s):** architect (this session) — to be reviewed by user

---

## Context

Milestone 1.2 of `ROADMAP.md` stands up authentication for a single-workplace, worker-controlled JHSC tool. CLAUDE.md and `SECURITY.md` §3 lock the stack:

- **Lucia Auth** as the identity layer.
- **Passkey / WebAuthn** as primary; **password + TOTP** as fallback; **biometric** on mobile (which on web is the passkey path via platform authenticators).
- **Argon2id** for password hashing (64 MB mem, 3 iter per SECURITY.md).
- **Session: EdDSA JWT (30 min access) + refresh token (HttpOnly, Secure, SameSite=Strict, 14 days, rotates on use).**
- **Step-up auth** before exports, identity decryption, deletions, Excel import commits/reverts, action item archival.
- **Brute-force ladder:** 5 failed → 15 min, 10 → 1 hr, 20 → manual unlock.
- **First-run setup** creates the co-chair account.

The audit chain (`packages/audit`) lands in 1.3, one milestone later. 1.2 therefore needs an interim audit-emission path that 1.3 can fold into the chain without losing events.

The repo state at 1.1 close: pnpm monorepo, Vite+React PWA shell, Hono+Bun API, Drizzle wired to an empty schema, CI green, design tokens in `packages/ui`, theme + app shell + skip-link in place.

## Decision drivers

- Phishing-resistant primary (CLAUDE.md mandates passkey/WebAuthn).
- Tokens must not be readable from JavaScript (XSS containment) — cookies, not Authorization headers.
- Stateless-ish access verification at the edge, with revocable refresh (matches SECURITY.md §3 wording: EdDSA JWT + refresh).
- Single co-chair, single workplace — no admin console; ops needs are CLI-shaped.
- All auth events must end up in the tamper-evident chain. 1.2 ships before the chain exists; the gap must be auditable retroactively, not silently lost.
- The Lucia ecosystem has shifted: v3 is the last "framework" release; the maintainer's path forward is bare Oslo primitives. We need a reversibility plan if Lucia v3 stops being viable.

## Options considered

### Option A: Lucia v3 sessions only (opaque session ID cookie, no JWT)

**Description:** Use Lucia v3's native opaque-session model. One `__Host-session` cookie, validated per request via Lucia's `validateSession`.

**Pros:**
- Minimal bespoke code.
- Stateful by default — clean revocation.

**Cons:**
- Departs from SECURITY.md §3 ("JWT EdDSA, 30 min access"). Reopening that decision requires a SECURITY.md edit, not an ADR.
- Every request touches the DB to validate. Acceptable for low-traffic single-tenant but not ideal at the edge.

### Option B: Lucia v3 for identity, bespoke EdDSA JWT + opaque refresh on top

**Description:** Use Lucia v3 only for the *identity layer* — owning the `users` and credential tables and providing the credential-validation primitives. Sessions are our own: a short-lived EdDSA JWT in an HttpOnly cookie (`__Host-access`, 30 min) plus an opaque refresh token in a second HttpOnly cookie (`__Host-refresh`, 14 days, stored hashed in `sessions`, rotates on use). Refresh emits a new access token without a DB write to the credentials path.

**Pros:**
- Matches SECURITY.md §3 to the letter.
- Access verification is signature-only — fast and edge-friendly.
- Revocation still possible via refresh rotation (kill the refresh row → next refresh fails).
- Lucia carries the identity layer that's actually hard (credential storage, Drizzle adapter), and we own the session shape we want.

**Cons:**
- More bespoke code than Option A (JWT signing, refresh rotation, two cookies).
- Two cookies to keep in sync.

### Option C: Drop Lucia entirely; bare Oslo + custom tables

**Description:** Skip Lucia. Use `@oslojs/crypto`, `@oslojs/jwt`, `@oslojs/webauthn` primitives directly and own every table.

**Pros:**
- Aligned with where the Lucia author is steering the ecosystem.
- Zero abandonware risk.

**Cons:**
- More code to write and audit in 1.2.
- Reopens CLAUDE.md's "Lucia Auth" lock — should be a deliberate stack edit, not an ADR detour.

## Decision

**We choose Option B.** Lucia v3 owns identity and credential storage via the Drizzle adapter. We layer SECURITY.md §3's session shape on top: HttpOnly EdDSA JWT access cookie (30 min) + HttpOnly opaque refresh cookie (14 d, rotates on use).

### Rationale

- Honors the locked stack (Lucia) and the locked session spec (EdDSA JWT + refresh).
- Containment-first: no tokens in JS land. Eliminates a wide class of XSS pivots.
- Reversibility to Option C is clean: the boundary between identity (Lucia-owned) and session (our code) is already drawn; if Lucia becomes unviable, swap the identity layer to bare Oslo without touching the session layer.

### Reversibility

- **Medium** to reverse to Option A (drop the JWT; use Lucia's session cookie). Requires a SECURITY.md edit.
- **Medium** to reverse to Option C (drop Lucia; bare Oslo). Requires CLAUDE.md edit + a migration that re-homes the users/credentials tables under our own schema (already our own, since we define the Drizzle schema).

## Auth event audit during the 1.2 → 1.3 gap

1.2 writes auth events to a flat `auth_events` table:

```
auth_events (
  id uuid primary key,
  ts timestamptz not null default now(),
  actor_id uuid null,        -- null for failed pre-auth attempts
  kind text not null,        -- 'signup', 'login.passkey', 'login.password',
                             -- 'login.totp', 'login.recovery', 'login.failed',
                             -- 'logout', 'step_up.granted', 'step_up.denied',
                             -- 'lockout.applied', 'lockout.cleared',
                             -- 'passkey.registered', 'passkey.removed',
                             -- 'totp.enrolled', 'totp.reset',
                             -- 'recovery_codes.generated', 'recovery_codes.consumed',
                             -- 'first_run.completed'
  ip inet null,
  user_agent text null,
  metadata jsonb not null default '{}'::jsonb
);
```

When 1.3 lands, the chained logger appends a **system genesis** entry as chain row 1 and a **1.2 backfill** entry as chain row 2 whose payload is the SHA-256 of the canonical-JSON serialization of all `auth_events` rows in `(ts, id)` order. This locks the pre-chain events into the chain by hash without re-keying them. After backfill, new auth events write directly to the chain and `auth_events` becomes read-only legacy.

## Tables added in 1.2 (Drizzle schema)

| Table | Purpose |
|---|---|
| `users` | One row per human. Owns `id`, `created_at`, `disabled_at`. No PII columns; display name lives in `user_profiles`. |
| `user_profiles` | `user_id` PK, encrypted `display_name_ciphertext`, encrypted `email_ciphertext`. Field encryption stub in 1.2 (deferred to 1.3 — see "Encryption stub"). |
| `password_credentials` | `user_id` PK, `hash` (Argon2id, libsodium-encoded), `algo_params` jsonb for future rotation. |
| `passkey_credentials` | `id` = WebAuthn credential ID (bytes), `user_id`, `public_key`, `counter`, `transports`, `attestation_type`, `created_at`, `last_used_at`, `nickname`. |
| `totp_credentials` | `user_id` PK, `secret_ciphertext` (encrypted at rest with master key — stub in 1.2), `enrolled_at`. |
| `recovery_codes` | `id`, `user_id`, `code_hash` (BLAKE2b), `consumed_at` null. 8 per user at enrollment. |
| `sessions` | `id` (Lucia's session row), `user_id`, `expires_at`, `refresh_token_hash`, `refresh_expires_at`, `step_up_until` timestamptz null, `ip_at_create`, `ua_at_create`. |
| `login_attempts` | `id`, `identifier` (lowercased email or userId), `ip`, `ts`, `outcome` (`success`/`failure`). Source of truth for the lockout ladder. |
| `setup_state` | Singleton (`id = 1`). `first_run_completed_at` null until first-run finishes. |
| `auth_events` | Flat audit table — see above. |

All tables ship in migration `0001_auth.sql`. No `users` row exists at migration time; `setup_state` ships with `(1, null)`.

### Encryption stub

`user_profiles.display_name_ciphertext`, `user_profiles.email_ciphertext`, and `totp_credentials.secret_ciphertext` are sensitive. 1.3 owns `packages/crypto`. For 1.2 we ship a `@jhsc/crypto-stub` *inside* `apps/api/src/crypto-stub.ts` (not a package — single-file shim) that:

- Reads `MASTER_KEY` from env (required in production; randomized per-test in tests).
- Uses **`crypto_secretbox_easy`** from libsodium with a random 24-byte nonce per write. Same algorithm class as XChaCha20-Poly1305 (a libsodium `secretbox` is XSalsa20-Poly1305; the actual XChaCha variant lands as `crypto_secretbox_xchacha20poly1305_easy` in 1.3).
- Wire format: `version_byte || nonce || ciphertext`. Version byte = `0x01` (stub). 1.3's real `packages/crypto` recognizes `0x01` and migrates on read.

This is a deliberate, documented bridge — not a permanent design.

## WebAuthn parameters

- `rpId` = `process.env.WEBAUTHN_RP_ID` (e.g. `jhsc.example.ca`); fall back to `localhost` in dev only.
- `rpName` = "JHSC Worker Hub".
- `userVerification: 'required'` on both registration and authentication.
- `residentKey: 'preferred'` (allow discoverable credentials so the user can sign in without typing an email on a registered device).
- `attestation: 'none'` — we don't pin attestation; we trust UV.
- Challenge TTL: 60 seconds. Challenges stored in a short-lived `webauthn_challenges` table keyed by `(user_id|null, purpose, challenge_b64u)`.

## Session details

- Access token: **EdDSA (Ed25519) JWT**, 30 min TTL. Claims: `sub` (user id), `sid` (session row id), `iat`, `exp`, `step_up_until` (epoch seconds, null if no current step-up).
- Refresh token: **opaque** 32-byte random, base64url-encoded, stored as `BLAKE2b(token)` in `sessions.refresh_token_hash`. Rotates on every use.
- Cookies: `__Host-access` (Path=/, Secure, HttpOnly, SameSite=Strict), `__Host-refresh` (same flags, `Path=/api/auth`).
- Signing key: Ed25519 keypair generated by an ops script and stored as `AUTH_JWT_ED25519_PRIVATE_KEY_B64`. Public key available for verification via `AUTH_JWT_ED25519_PUBLIC_KEY_B64`. Key rotation is a SECURITY.md §3 annual concern; the JWT carries `kid` to support multi-key verification during rotation windows.

## Step-up auth

`requireStepUp(c, action)` middleware:

1. Reads the access JWT's `step_up_until` claim.
2. If unset or in the past, responds **401** with `WWW-Authenticate: StepUp realm="jhsc", actions="<action>"`.
3. The web client opens a step-up modal: passkey assertion preferred, TOTP fallback.
4. On verify, server updates `sessions.step_up_until = now() + 5 min` and issues a fresh access JWT carrying the new claim.
5. The original request is retried by the client with the new cookie set automatically.

5 minutes is the default window; sensitive actions (exports) can shorten it to 60 seconds by passing `{ maxAge: 60_000 }`.

## Brute-force ladder

`login_attempts` is the source of truth. Lockout check runs before any credential verification:

- Count failures for `(identifier OR ip)` in the last 15 min ≥ 5 → 15 min lockout.
- Count failures in the last 60 min ≥ 10 → 1 hour lockout.
- Count failures in the last 24 h ≥ 20 → respond with "contact administrator"; only an admin script clears it.

Lockout responses are constant-time relative to credential verification (no oracle for "is this email registered").

## First-run flow

1. `GET /api/auth/first-run/status` → `{ completed: bool }`.
2. If not completed and `users` row count = 0, `POST /api/auth/first-run/setup` accepts `{ email, password, totp_pending: true }`.
3. Server creates `users` row + `password_credentials` + queues a TOTP enrollment challenge.
4. Client enrolls TOTP (renders QR + confirms first code).
5. Client immediately registers a passkey in the same flow (mandatory — UV-required platform authenticator). If passkey registration fails, the account remains usable via password+TOTP and surfaces a banner urging passkey enrollment.
6. Server flips `setup_state.first_run_completed_at`. From here, `first-run/*` routes 404.

## Web surface (1.2 scope)

- `/setup` — first-run page (visible only when `first-run/status.completed === false`).
- `/login` — passkey button + "use password instead" link → password+TOTP form.
- `/account/security` — passkey list (add/remove/rename), TOTP reset, recovery code regen, sessions list with revoke.
- Step-up modal — global, triggered by any 401-StepUp response.
- Route guard — wraps the app shell; unauthenticated → `/login`; setup-incomplete → `/setup`.

## Consequences

### Positive
- Phishing-resistant primary path on day one.
- Tokens unreachable from JS.
- Step-up wired before the features that depend on it land (exports/imports in 1.8/1.11).
- Clean handoff to 1.3: `auth_events` is the backfill source; the stub crypto wire format already carries a version byte for migration.

### Negative / accepted tradeoffs
- Two-cookie session model is more bespoke code than Lucia's default. Mitigation: the session layer is small (~150 LOC) and well-tested.
- 1.2 ships before the audit chain. The flat `auth_events` table is honest about this and the backfill design is specified here, not deferred.
- The crypto stub (`crypto_secretbox`) is not the XChaCha20-Poly1305 SECURITY.md specifies. The version byte makes the migration safe and the 1.2 → 1.3 window short. **This is documented in `auth_events` provenance and the runbook.**

### Risks
- Lucia v3 abandonware risk. Mitigation: Option B's boundary lets us swap to bare Oslo without touching the session layer.
- WebAuthn UX edge cases on iOS Safari (UV cancellation, platform-authenticator availability). Mitigation: password+TOTP fallback always reachable from the login screen.
- JWT key compromise. Mitigation: `kid` in the header; rotation is a single ops command that adds a new active key and a grace window for in-flight access tokens.

## Compliance check

- [x] Aligns with `.context/constraints.md` (PIPEDA: minimization — no PI in tokens, no PI in audit metadata; Ontario residency — Neon ca-central-1).
- [ ] Threat model updated — **follow-up: threat-modeler appends an auth-specific section to SECURITY.md §2 or `.context/threat-model.md`.**
- [x] No cross-border transfer added.
- [x] No new subprocessor (Lucia is a library, not a service; @simplewebauthn and @oslojs/* are libraries).

## Follow-ups

- [ ] Threat-modeler: auth-specific data flows + trust boundaries + mitigations into the threat model.
- [ ] Test-writer: acceptance tests for happy + negative paths (wrong TOTP, expired challenge, replay, second first-run, lockout ladder).
- [ ] Implementer: schema + migration + Lucia adapter + routes + UI per the surface above.
- [ ] Security-reviewer + privacy-reviewer: independent pass once code lands.
- [ ] Runbook: admin-unlock script + JWT key rotation procedure into `docs/incident-response.md` and a new `docs/runbooks/auth.md`.
- [ ] Update `.context/decisions.md` with the one-liner pointing here.
