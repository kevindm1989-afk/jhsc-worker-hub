# Runbook — Auth (Milestone 1.2)

Operational procedures for the auth surface introduced in Milestone 1.2 (per ADR-0001 and SECURITY.md §2.1). All commands assume an operator with shell access to a Fly Machine running `apps/api` (or, for local recovery, a developer with `psql` access to the production DB through a Neon read-write console).

When in doubt, default to **worker safety, worker privacy, evidentiary defensibility** (CLAUDE.md "When in doubt").

---

## 1. Pre-deploy: first-run-before-DNS cutover (mitigates T-A11)

**Threat:** `T-A11 First-run hijack` — if the production hostname is reachable before the singleton co-chair account is created, the first stranger to load `/setup` claims the account.

**Procedure on every fresh deploy:**

1. Provision the Fly app and Neon DB. Do **not** create the public DNS record yet.
2. From a controlled location (the co-chair's device on a trusted network), open the app via the Fly-issued `*.fly.dev` URL — never the eventual public hostname.
3. Complete the `/setup` flow end-to-end: email + password + display name → scan TOTP → confirm the first code.
4. Verify:
   ```sh
   curl -s https://<app>.fly.dev/api/auth/first-run/status
   # → {"completed":true}
   ```
5. **Only now** create the public DNS record pointing at the Fly app.
6. (Optional) Sign in once via the public hostname and add a passkey from `/account/security` so the password+TOTP path is the fallback, not the primary.

**Verification after cutover:**

```sh
curl -s https://<public-hostname>/api/auth/first-run/status
# → {"completed":true}
curl -s -X POST https://<public-hostname>/api/auth/first-run/setup \
  -H 'content-type: application/json' \
  -d '{"email":"x@x.invalid","password":"WhateverDoesNotMatter1!","displayName":"x"}'
# → 404 not_found  (gate closed)
```

If the second call does **not** 404, the singleton was not flipped and the gate is open. Roll back the DNS record and investigate before any further user-facing exposure.

---

## 2. Admin: clear a hard-tier lockout (mitigates T-A13)

**Threat:** `T-A13 Lockout used as DoS against the rep` — the 20-failure hard-tier lockout requires a CLI ops action to clear. A targeted attacker can keep a rep locked out by spraying failed logins.

**Procedure when a rep reports being locked out:**

1. Confirm identity out-of-band (phone, in-person — never trust the locked-out account's email).
2. Confirm the lockout from the API host. The script reads the email at a silent prompt — never typed in argv:

   ```sh
   bun run /app/apps/api/scripts/auth-unlock.ts --check --email-from-stdin
   ```

   Expected output:

   ```
   identifier_hash: <hex>
   failures in the last 24h: 23
   tier: hard
   action required: confirm with the rep, then run --unlock
   ```

3. Clear the hard-tier failures only (short/long tiers self-clear in their windows). Either pass a precomputed identifier hash (preferred — compute it on a separate workstation), or read the email at a silent prompt:

   ```sh
   # Preferred: hash computed offline.
   bun run /app/apps/api/scripts/auth-unlock.ts --unlock \
     --identifier-hash 35e614f525803925f520750a5c8ca7467d395c848594c248d49caba74d800cfa \
     --reason "phone-confirmed identity 2026-05-29 14:02 EDT" \
     --operator "$(whoami)"
   # Fallback: read the email at a silent prompt (no argv exposure).
   bun run /app/apps/api/scripts/auth-unlock.ts --unlock --email-from-stdin \
     --reason "phone-confirmed identity 2026-05-29 14:02 EDT" \
     --operator "$(whoami)"
   ```

   The script:
   - Deletes the failure rows in the hard-tier window for the identifier hash.
   - Emits a `lockout.cleared` row into `auth_events` carrying the reason and operator strings (metadata only — no PI).

4. Tell the rep to try again. If they still see a 423/429, wait the short-tier window (15 min default) and they will recover automatically.

**Do not** simply `DELETE FROM login_attempts` from a SQL console — the action would not be audit-logged, and you would lose the chain-of-custody evidence that the lockout was intentional.

---

## 3. JWT key rotation (annual cadence + on suspected compromise)

**Why:** SECURITY.md §3 calls for annual rotation. The access JWT is signed with the Ed25519 keypair in `AUTH_JWT_ED25519_PRIVATE_KEY_B64` / `_PUBLIC_KEY_B64`. The `kid` header lets the verifier accept multiple active keys during the grace window.

**Procedure:**

1. Generate a fresh keypair on a workstation with no shell history capture:
   ```sh
   node -e "const c = require('crypto');
   const { privateKey, publicKey } = c.generateKeyPairSync('ed25519');
   console.log('priv:', privateKey.export({format:'der',type:'pkcs8'}).toString('base64'));
   console.log('pub:',  publicKey.export({format:'der',type:'spki'}).toString('base64'));"
   ```
2. On the API host, set the new keys **alongside** the old ones (Fly Secrets carries both):
   ```sh
   flyctl secrets set \
     AUTH_JWT_ED25519_PRIVATE_KEY_B64_K2='<new priv>' \
     AUTH_JWT_ED25519_PUBLIC_KEY_B64_K2='<new pub>' \
     AUTH_JWT_ACTIVE_KID='k2'
   ```
   This rotates **issuance** to `k2`. Verification still accepts `k1` because the verifier (Slice 2 `jwt.ts`) consults `AUTH_JWT_ED25519_PUBLIC_KEY_B64_<KID>` per token. Existing access JWTs signed by `k1` continue to validate until they expire (≤ 30 min) or the refresh forces a re-issue.
3. Wait at least 35 minutes (≥ access-token TTL + safety margin). All in-flight tokens have rotated.
4. Remove the old key from Fly Secrets:
   ```sh
   flyctl secrets unset \
     AUTH_JWT_ED25519_PRIVATE_KEY_B64 \
     AUTH_JWT_ED25519_PUBLIC_KEY_B64 \
     AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1 \
     AUTH_JWT_ED25519_PUBLIC_KEY_B64_K1
   ```
5. Verify only `k2` is live:
   ```sh
   flyctl secrets list | grep AUTH_JWT
   ```

**On suspected compromise:** skip the 35-min wait. Immediately rotate the active kid and call `/api/auth/logout-all` for every active user from the API (single-tenant: one user, so a single curl). Then revoke the old kid.

**Implemented in Milestone 1.3** (security-reviewer F6 closure). The verifier walks a kid registry built from `AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1` through `_K4` plus the legacy bare-form keys (mapped to `kid='legacy'`). Issuance reads the keypair for `AUTH_JWT_ACTIVE_KID`, falling back to `legacy` when the active kid has no keypair. Sessions issued under `k1` keep validating after a flip to `k2` because both kids' public keys are present in the registry until `flyctl secrets unset` removes `k1`.

---

## 4. Emergency: revoke all sessions for the co-chair

Use case: lost device, suspected device compromise, suspected credential capture.

**From an authenticated browser:**

`/account/security` → "Sign out" — this single-session sign-out is fine for routine departure.

**From a CLI when the browser isn't available** (lost device path):

```sh
bun run /app/apps/api/scripts/auth-unlock.ts --logout-all --email-from-stdin \
  --reason "device lost 2026-05-29 09:15 EDT — reissue passkey on arrival" \
  --operator "$(whoami)"
```

This emits `session.revoked` (scope=all) into `auth_events` and deletes every row in `sessions` for that user. Next access from any device requires a full sign-in.

If the device was lost **and** the password is suspected to be exposed, follow up with:

1. Sign in via passkey (preferred) or password+TOTP from a known-clean device.
2. From `/account/security`, register a new passkey on the new device.
3. (1.3+ scope) Reset the TOTP secret. Until 1.3 lands the rotation endpoint, the operator can DELETE FROM `totp_credentials` for the user and walk them back through the `/setup`-style enrollment via a future endpoint. Track this gap in `.context/decisions.md`.

---

## 4a. Retention sweep

Run nightly to keep `webauthn_challenges` and `login_attempts` from
growing unboundedly. Both are operational tables — pruning them does
not destroy audit evidence.

```sh
# Dry-run — print what would be deleted, write nothing.
bun run /app/apps/api/scripts/auth-retention.ts

# Apply the sweep. Output is one line per table; pair with `--quiet`
# for a single syslog-friendly line when invoking from cron / pg-boss.
bun run /app/apps/api/scripts/auth-retention.ts --apply
bun run /app/apps/api/scripts/auth-retention.ts --apply --quiet
```

What it prunes:

- `webauthn_challenges` past `expires_at + 1 hour` grace.
- `login_attempts` older than `2 × AUTH_LOCKOUT_HARD_WINDOW_SECONDS`
  (default ≈ 48 h). The lockout module only ever reads the most
  recent hard-tier window; rows older than that have no operational
  use.

What it does NOT prune:

- `auth_events` — pre-1.3 the flat audit table is the only
  tamper-evident substitute for the to-be-chain. ADR-0001's 1.3
  backfill anchor is the safe point to start culling.

## 5. Diagnostics: inspecting auth_events and login_attempts

```sql
-- Recent auth events for the co-chair, newest first.
SELECT ts, kind, ip, metadata
FROM auth_events
WHERE actor_id = (SELECT user_id FROM user_profiles LIMIT 1)
ORDER BY ts DESC
LIMIT 50;

-- Failure rate by IP over the last hour (useful when investigating a
-- targeted attack vs. a forgotten password).
SELECT host(ip) AS ip, count(*) AS fails
FROM login_attempts
WHERE outcome = 'failure'
  AND ts >= now() - interval '1 hour'
GROUP BY ip
ORDER BY fails DESC
LIMIT 20;

-- Step-up history (verifies that audit-logged exports/deletes correlate
-- with step-up grants).
SELECT ts, kind, metadata
FROM auth_events
WHERE kind LIKE 'step_up.%'
ORDER BY ts DESC
LIMIT 50;
```

**Never** decrypt sensitive columns from a SQL console. Email addresses live encrypted in `user_profiles.email_ciphertext`; the lookup hash exists precisely so audit queries don't need the plaintext. If you need to confirm an email matches a row, compute the lookup hash locally and compare:

```sh
bun run /app/apps/api/scripts/auth-unlock.ts --lookup-hash --email-from-stdin
# (paste the rep's email at the silent prompt; print the hash; never
# typed in argv on the production host. Run this on a workstation OUTSIDE
# production, then pass --identifier-hash to the production-side commands.)
```

---

## 7. Audit-chain tamper response (Milestone 1.3+)

The nightly cron runs `bun run apps/api/scripts/audit-log-verify.ts`. Exit code:

- `0` — chain verified
- `1` — tamper detected (firstDivergence + reason printed)
- `2` — operational error (DB unreachable, env unset)

When exit code 1 lands:

1. **Stop writes.** Disable the API or put it behind a maintenance page. New audit rows after detection cannot be trusted into the chain; treat them as quarantined.
2. **Capture forensics.** Take a snapshot of `audit_log` to off-host storage before any other action:

   ```sh
   pg_dump -t audit_log "$DATABASE_URL" > /tmp/audit_log.$(date -u +%Y%m%dT%H%M%SZ).sql
   gpg --output /backup/audit_log.<ts>.sql.gpg --encrypt --recipient ops /tmp/audit_log.<ts>.sql
   ```

3. **Determine the diverging row.** The script prints `first divergence at idx: <N>` and a `reason`:
   - `hash_mismatch` — the row's `this_hash` does not equal SHA-256(prev_hash || canonical_json(headers + payload)). Implies the body OR the stored hash was altered.
   - `prev_hash_mismatch` — the row's `prev_hash` does not equal row N-1's `this_hash`. Implies a row was inserted, deleted, or reordered before idx=N.
   - `idx_gap` — `idx` is non-contiguous. Implies a row deletion.
   - `genesis_prev_hash` — row 0's `prev_hash` is not `\x00 × 32`. Implies genesis tamper.

4. **Compare against the most recent verified snapshot.** Operators retain weekly off-host snapshots of `audit_log` (see runbook follow-up below). Diff `idx` ranges to identify exactly which row's body changed.

5. **Restore from snapshot if forensically defensible.** If the rep needs the chain back online and the operator has confirmed the snapshot was off-host and predates the divergence, restore. Append a new `audit.tamper_response` row (manual SQL — log to the chain with the rotation procedure) capturing the divergence + restoration. Continued operation requires re-running `audit-log-verify` to confirm post-restore PASS.

6. **Notify** under PIPEDA s.10.1 if the tamper meets the RROSH threshold (real risk of significant harm). Document the determination in `docs/incident-response.md` with the divergence details.

> **TODO:** weekly off-host snapshot schedule + restore drill — track as ROADMAP 1.12 hardening line item.

## 6. When 1.3 lands: backfill the auth chain

ADR-0001 specifies that 1.3's chained logger will:

1. Append a `system.genesis` chain row.
2. Append a `1.2_backfill` chain row whose payload is the SHA-256 of the canonical-JSON serialization of `auth_events` in `(ts, id)` order.

The operator running the 1.3 deploy is responsible for:

- Verifying the canonical-JSON serializer in `packages/audit` matches the schema the integrator wrote down at 1.2 close (preserve `ts`, `id`, `actor_id`, `kind`, `ip`, `user_agent`, `metadata` — and **only** those columns).
- Capturing the SHA-256 of the entire `auth_events` table before the backfill so the chain anchor is verifiable post-deploy.
- Recording the rotation in `.context/decisions.md` with a note that historical `auth_events` rows are now read-only legacy.

---

## Appendix — environment variables referenced

| Var                                                          | Purpose                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MASTER_KEY`                                                 | Application-layer encryption key (XSalsa20-Poly1305 in 1.2; XChaCha20-Poly1305 in 1.3). Keyed BLAKE2b for email lookup hashes uses the same key. |
| `AUTH_JWT_ED25519_PRIVATE_KEY_B64`                           | PKCS8 / base64 Ed25519 signing key for access JWTs.                                                                                              |
| `AUTH_JWT_ED25519_PUBLIC_KEY_B64`                            | SPKI / base64 Ed25519 verification key.                                                                                                          |
| `AUTH_JWT_ACTIVE_KID`                                        | The `kid` header value the issuer stamps on new tokens.                                                                                          |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_ORIGIN` / `WEBAUTHN_RP_NAME` | WebAuthn RP config. RP_ID must be the registrable hostname (no scheme).                                                                          |
| `AUTH_LOCKOUT_{SHORT,LONG,HARD}_{FAILS,WINDOW_SECONDS}`      | Lockout ladder thresholds. Defaults match SECURITY.md §3 (5/15min, 10/1h, 20/24h).                                                               |
