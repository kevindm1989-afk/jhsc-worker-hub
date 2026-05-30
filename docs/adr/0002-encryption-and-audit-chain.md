# ADR-0002: Encryption (production XChaCha20-Poly1305 + envelope) and tamper-evident audit chain

**Status:** Accepted
**Date:** 2026-05-29
**Decider(s):** architect (this session) — to be reviewed by user

---

## Context

Milestone 1.3 of `ROADMAP.md` closes two CLAUDE.md non-negotiables that 1.2 ran against partial implementations:

- **#2 "Worker data is evidentially sensitive."** 1.2 emits auth events into a flat `auth_events` table. The reviewers' Slice 9 verdicts both flagged the absence of a tamper-evident chain as the documented residual risk that has to close in 1.3.
- **#4 "Privacy-by-default. Encrypt sensitive fields with keys you control."** 1.2 ships a documented stub: libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305) with a wire-format version byte (`0x01`). SECURITY.md §3 mandates XChaCha20-Poly1305 in production.

Plus three deferred-from-1.2 items now in scope:

- security-reviewer F6 — multi-kid JWT verifier (ledger entry 2026-05-29).
- `auth_events` backfill anchor (ADR-0001 §"Audit during the 1.2 → 1.3 gap").
- TOTP reset path (runbook §4 step 3) — depends on the step-up modal landing.

  1.4 (Legal Corpus) wants `packages/crypto` for citation-hash provenance; 1.5 (Hazards) needs both `packages/crypto` and `packages/audit` for sensitive writes. 1.3 is the gate.

## Decision drivers

- Keep the 1.2 wire format readable so existing rows decrypt without a data migration step.
- Make `packages/audit` verifiable from a cold shell with no app code loaded (the nightly `scripts/audit-log-verify.ts` runs in CI / cron).
- Envelope encryption — a per-record data-encryption-key sealed by the workplace key-encryption-key — for the heavyweight tables landing 1.5+ (hazards, evidence files, witness statements). Auth-surface fields keep the single-key path: rotation cost is proportional to a handful of rows.
- Decouple `packages/crypto` from `process.env`. Callers inject a `KeyProvider`. Makes the package unit-testable without env munging and lets the AI proxy (Milestone 3.2) hold a different key.
- Audit chain entries must carry enough context to satisfy a PIPEDA s.10.1 RROSH determination without dragging PI into the payload.

## Options considered

### Option A: Two packages — `packages/crypto`, `packages/audit` — both depending on `packages/shared-types`

Land `packages/shared-types` now too (one milestone earlier than the CLAUDE.md note allows, mirroring how Slice 6 of 1.2 deferred it inline). Crypto exports the wire-format + envelope helpers. Audit exports the append/verify primitives. Both consume types from shared-types. Apps/api routes import audit via a `getAudit()` factory that takes a `KeyProvider`.

**Pros:**

- Shared-types finally lands; the `apps/api/src/auth/enums.ts` deferral note (CLAUDE.md "shared-types planned 1.3+") closes.
- Clean dependency layering. `packages/legal-corpus` and `packages/calculators` (later milestones) can consume shared-types without pulling crypto.
- Crypto is independently auditable — no app imports inside the package.

**Cons:**

- Three new workspace packages in one milestone. Slight ceremony cost.

### Option B: A single `packages/security` containing both crypto and audit

Avoid the three-package fan-out; bundle the related primitives.

**Pros:** Fewer package boundaries.

**Cons:**

- Conflates two concerns with different review surfaces. The security-reviewer will want to look at crypto independently; the audit chain has its own protocol.
- Wires legal-corpus (1.4) into a security blob it does not need.
- "One big package" pattern is the worst when external code needs to depend on half of it.

### Option C: Stay inline in `apps/api` — keep crypto-stub, add an audit module under `apps/api/src/audit/`

**Pros:** Zero new packages.

**Cons:**

- CLAUDE.md non-negotiable: shared-types and crypto are explicitly planned as packages. Skipping them is a roadmap edit, not a 1.3 milestone choice.
- The AI proxy (3.2) needs the same crypto primitives — duplicating inside `apps/ai-proxy/src/` is exactly the pattern packages are supposed to prevent.
- Audit verification from a cold shell now has to load the whole apps/api compile target.

## Decision

**Option A.** Land `packages/shared-types`, `packages/crypto`, `packages/audit`.

### Rationale

The deferral on `shared-types` was operational, not architectural — 1.2 ship cost was the constraint. With the auth surface stable, landing it now removes the inline-enum hack in `apps/api/src/auth/enums.ts` and unblocks 1.4's citation-type sharing. The crypto/audit split keeps the security-review surface focused: each package has a single threat model, a single test fixture, a single dependency graph.

### Reversibility

- **Easy** to inline-collapse if a future stack edit calls for it: the public APIs are small and each package would fold back into apps/api with a single move + import rewrite.
- **Hard** to reverse the wire-format version byte. Once 1.3 ships v=0x02 envelopes, downgrading to a non-versioned format would invalidate every row.

## Crypto wire format (production)

```
v   nonce                     ciphertext-with-mac
0x02 || 24 bytes (XChaCha)    || libsodium output
```

- `v = 0x01` (XSalsa20-Poly1305, 1.2 stub) — `open()` accepts on read, never written.
- `v = 0x02` (XChaCha20-Poly1305) — written by every 1.3 call, accepted on read.
- Future versions reserve `v = 0x03+`. Unknown versions fail loud (not a parse error — `CryptoOpenError(unsupported_version)`).
- `rewrap(sealed, key) → sealed_v2` — opens a v=0x01 blob and re-seals as v=0x02. The Drizzle field-encryption hook calls `rewrap` on read for any v=0x01 row, queues a no-payload UPDATE, and emits an `audit.crypto.rewrap` event.

The 24-byte nonce on v=0x02 is the extended-nonce property XChaCha provides; rotation safety extends to ~2^96 messages per key (effectively unbounded for a single workplace).

## Envelope encryption (heavyweight tables — 1.5+)

For tables where the payload is large (hazard descriptions, witness statements, evidence file metadata) or where per-record key rotation is a future requirement:

```
record.dek         = randomBytes(32)
record.ciphertext  = seal_v2(plaintext, record.dek)
record.dek_sealed  = seal_v2(record.dek, workplace_kek)
```

The workplace KEK is the existing `MASTER_KEY` from 1.2 (re-keyed in 1.3 by an ops procedure documented in the runbook). On read:

```
record.dek         = open(record.dek_sealed, workplace_kek)
plaintext          = open(record.ciphertext, record.dek)
```

DEK is held in memory only for the duration of the request. KEK rotation re-seals every `dek_sealed` row without touching the ciphertext column.

Auth-surface tables (user_profiles, totp_credentials) **do not** adopt the envelope pattern. The rows are small (<256 bytes), few (one per user — single co-chair), and the KEK rotation cost is the same one psql UPDATE. Adding envelope here would be ceremony without payoff.

## Audit chain

### Table `audit_log`

```
audit_log (
  idx           bigint primary key,    -- monotonic; gen=0
  ts            timestamptz not null default now(),
  actor_id      uuid null references users(id) on delete set null,
  kind          text not null,         -- e.g. 'session.login', 'export.generated'
  resource_type text null,             -- table name or domain noun
  resource_id   text null,             -- stringified PK
  prev_hash     bytea not null,        -- SHA-256 of previous row's this_hash; \x00..0 for genesis
  this_hash     bytea not null unique, -- SHA-256(prev_hash || canonical_json(headers || payload))
  payload       jsonb not null default '{}'::jsonb
);
create unique index audit_log_idx_unique on audit_log(idx);
```

`this_hash` is `SHA-256(prev_hash || canonical_json({idx, ts (epoch ms), actor_id, kind, resource_type, resource_id, payload}))`. Canonical JSON is RFC 8785 (deterministic key ordering, no whitespace). The package vendors a tiny canonical-JSON serializer rather than pulling a dep.

### Append protocol

`audit.append(entry)`:

1. BEGIN; SELECT idx, this_hash FROM audit_log ORDER BY idx DESC LIMIT 1 FOR UPDATE.
2. Compute next idx = prev.idx + 1.
3. Compute this_hash = SHA-256(prev.this_hash || canonical_json({...})).
4. INSERT INTO audit_log VALUES (...).
5. COMMIT.

The `FOR UPDATE` serializes appends. Throughput is single-machine — single co-chair makes the rate ≤ 1 event/second realistically. If a future milestone needs concurrent appenders (1.10 sync engine), they batch through a single appender or move to advisory-lock keyed by `'audit_log'`.

### Verify protocol

`audit.verify({fromIdx?, toIdx?}) → { ok: true } | { ok: false, firstDivergence: idx }`:

1. SELECT idx, ts, actor_id, kind, resource_type, resource_id, payload, prev_hash, this_hash FROM audit_log WHERE idx BETWEEN $from AND $to ORDER BY idx ASC.
2. For each row, recompute this_hash and compare. First mismatch → `firstDivergence: row.idx`.
3. Walk-from-zero: if `fromIdx` is omitted, start at genesis and require prev_hash to be `\x00 × 32`.

`scripts/audit-log-verify.ts` calls `verify()` with no args (full chain), exits 0 on success and non-zero with the diverging idx on failure. The runbook adds a §7 "tamper response" entry pointing operators at the runbook → backup → incident-response flow.

### Genesis + 1.2 backfill anchor

The migration inserts two rows immediately after creating the table:

- `idx=0, kind='system.genesis', prev_hash=\x00..0, payload={created_at: <ts>, schema_version: '1.3.0'}`. `this_hash` computed from those values.
- `idx=1, kind='audit.backfill.1_2_auth_events', payload={rows_sha256: '<hex>', row_count: <int>, oldest_ts: <iso>, newest_ts: <iso>}`. The `rows_sha256` is SHA-256 of the RFC 8785 canonical JSON of the array `[{id, ts, actor_id, kind, ip, user_agent, metadata}]` in `(ts ASC, id ASC)` order, computed by the migration script. After the anchor lands, every new auth event writes to `audit_log` directly; `auth_events` becomes read-only legacy preserved for historical-fidelity reasons.

Re-running `scripts/audit-log-verify.ts` after the backfill anchor lands recomputes `rows_sha256` from `auth_events` and matches it against the payload. Any post-backfill tamper of `auth_events` is detected at next verify.

### Resource references and PI

Audit payloads carry **typed metadata only** — never PI strings. Conventions:

- `kind` taxonomy lives in `packages/shared-types` and follows `'<domain>.<verb>'` (`'session.login'`, `'export.generated'`, `'hazard.promoted'`).
- `resource_type` is the table name (`'sessions'`, `'hazards'`).
- `resource_id` is the stringified UUID — opaque, not PI.
- `payload` is jsonb with kind-specific shape, all enums + IDs + numeric counts. The shared-types package exports per-kind discriminated unions so the typechecker rejects PI fields.
- Where actor IP/UA are needed (auth path), the existing `ip` / `user_agent` columns hold them; they are not in `payload`.

## Multi-kid JWT verifier (closes security-reviewer F6)

`packages/crypto`'s job stays small; the JWT helpers live in `apps/api/src/auth/jwt.ts` and gain a kid registry:

```
AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1   <-- active issuer until rotation grace
AUTH_JWT_ED25519_PUBLIC_KEY_B64_K1
AUTH_JWT_ED25519_PRIVATE_KEY_B64_K2   <-- next issuer; verifier accepts both
AUTH_JWT_ED25519_PUBLIC_KEY_B64_K2
AUTH_JWT_ACTIVE_KID                   <-- 'k1' or 'k2'; signs new tokens with this
```

Issuance reads `AUTH_JWT_ED25519_PRIVATE_KEY_B64_<AUTH_JWT_ACTIVE_KID>`. Verification reads the JWT header's `kid`, looks up `AUTH_JWT_ED25519_PUBLIC_KEY_B64_<kid>`, rejects when missing. Backward-compat keys without a kid suffix (the 1.2 path) read into a synthetic `kid='legacy'` so existing tokens continue to validate until they expire (≤ 30 min).

Runbook §3 updated to remove the "TODO" gate; rotation becomes the documented kid-suffix dance.

## TOTP reset endpoint (closes runbook §4 step 3)

`POST /api/auth/totp/reset` — authenticated + step-up required. Generates a fresh TOTP secret, returns the otpauth URI + Base32 + a 5-minute provisioning blob (same shape as first-run). `POST /api/auth/totp/reset-confirm` consumes the blob with the first code. Emits `totp.reset` into the chain. The Account → Security UI gains a "Reset authenticator" panel that drives the two endpoints.

The 1.2-deferred step-up modal lands here as a side effect — the global modal listens to `stepUpEmitter`, opens on a 401-StepUp, runs passkey or TOTP step-up, retries the original request.

## Tables added in 1.3

| Table       | Purpose                                           |
| ----------- | ------------------------------------------------- |
| `audit_log` | The chain. Genesis + backfill anchor preinserted. |

No other table additions; the auth tables persist and `auth_events` becomes read-only legacy.

## Consequences

### Positive

- The CLAUDE.md non-negotiables on encryption (#4) and audit (#2) close.
- Every 1.4+ feature inherits a tested append + verify primitive — the security-reviewer for 1.4 (legal corpus citation provenance), 1.5 (hazards), 1.7 (evidence files) gets a single audit surface to cross-check.
- The crypto stub's deliberate-bridge status retires. The 1.2 `auth_events` table is locked into the chain by hash.
- Multi-kid JWT closes one of the open Slice 9 follow-ups; rotation can happen without breaking sessions.

### Negative / accepted tradeoffs

- Three new packages. Ceremony cost during 1.3 only; pays off from 1.4 onward.
- The `FOR UPDATE`-serialized appender caps audit throughput at ≤ ~hundreds/sec — fine for single-tenant, would need rework for a multi-rep concurrent-write scenario. Documented; not a 1.x concern.
- Migration of v=0x01 rows is lazy (rewrap on read), so a long-untouched row may persist with the 1.2 wire format until first access. Acceptable: the format is still authenticated; rotation pressure is years out for fields no one reads.

### Risks

- A botched migration of the genesis/backfill rows would invalidate the chain on day one. Mitigation: the migration is idempotent — it skips genesis if `idx=0` already exists. The `rows_sha256` for the backfill anchor is captured by the migration script with explicit `psql -v ON_ERROR_STOP=1` ordering.
- KEK rotation involves re-sealing every `dek_sealed` and every auth-surface ciphertext. Runbook §3 (JWT rotation) gets a §3a (master-key rotation) sibling that lays out the dance.

## Compliance check

- [x] Aligns with `.context/constraints.md` (PIPEDA Principle 7 safeguards; Ontario residency unchanged).
- [ ] Threat model updated — **follow-up: threat-modeler appends §2.2 "Audit chain threats" to SECURITY.md before slice 4.**
- [x] No cross-border transfer.
- [x] No new subprocessor.

## Follow-ups

- [ ] Threat-modeler: SECURITY.md §2.2 with T-AC1..T-ACn for chain-specific threats (genesis tamper, gap, replay, race).
- [ ] Test-writer: contract tests for `verify()` (genesis, sequence, tamper-detect, partial-range).
- [ ] Implementer slices (recommend 4):
  - S1: `packages/shared-types` + `packages/crypto` + tests + replace `apps/api/src/auth/crypto-stub.ts` re-exports.
  - S2: `packages/audit` + tests + `audit_log` migration with genesis + 1.2 backfill anchor.
  - S3: Wire audit into the auth routes; `scripts/audit-log-verify.ts` filled in; events emitter delegates to the chain.
  - S4: Multi-kid JWT + TOTP reset endpoint + step-up modal.
- [ ] Security-reviewer + privacy-reviewer: parallel pass after S4.
- [ ] Runbook: §3a master-key rotation, §7 tamper response, §3 multi-kid update.
- [ ] Update `.context/decisions.md` with the one-liner pointing here.
