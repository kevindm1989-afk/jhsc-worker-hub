# SECURITY.md — JHSC Worker Hub

Threat model, security controls, and incident response.

---

## 1. What We're Protecting

In order of sensitivity:

1. **Member identities and statements** — worker names, witness identities, statement bodies.
2. **Medical and accommodation records** — health info protected under PIPEDA and OHRC.
3. **Reprisal records** — narratives of supervisor conduct, dates, witnesses. Evidentiary value in OLRB.
4. **Recommendations and JHSC strategy** — drafts, adversarial analyses, predicted management responses.
5. **Evidence files** — photos, audio, documents.
6. **Practice journal entries** — rep-private strategic notes, separate key.
7. **Action item descriptions** — when they identify named workers, supervisors, or detailed workplace specifics, treated with same sensitivity as member statements.
8. **Excel import payloads** — imported workplace data is fully sensitive; treated identically to first-class records.
9. **Audit log** — proves chain of custody. Tamper would destroy evidentiary value of all records.
10. **Authentication credentials** — passkeys, password hashes, TOTP secrets, session tokens.

---

## 2. Threat Model

### Adversaries

| Adversary | Capability | Motivation |
|---|---|---|
| **Employer / management** | Access via employer infrastructure, social engineering, compelled disclosure | Discover worker-side strategy; identify members reporting hazards |
| **Hostile co-worker** | Physical access to a rep's phone/laptop, shoulder-surfing | Personal grievance, anti-union sentiment |
| **Opportunistic attacker** | Web attack surface — scanners, credential stuffing, exploits | Generic compromise |
| **Targeted attacker** | Sophisticated — phishing, supply chain, device theft | Anti-union motivation (rare but real) |
| **Compelled disclosure** | US court order to Fly or Neon under CLOUD Act; Canadian court order | Litigation discovery, criminal investigation |
| **Insider at provider** | Fly or Neon staff with administrative access | Negligence, curiosity, malice |
| **Compromised dependency** | npm package compromise, supply chain attack | Wide-scale exploitation |
| **Malicious Excel file** (NEW) | Crafted .xlsx/.xlsm with hostile content | Trigger parser bug, exfiltrate data, embed exploits |

### What's In Scope

- Web app at the production URL
- API at the production API URL
- Neon Postgres database
- Tigris file storage
- Fly Secrets (keys, credentials)
- Source code repository
- CI/CD pipeline
- Domain DNS
- **Excel import parser (SheetJS) and reconciliation engine**
- **Action item move workflow and audit chain anchors**

### What's Out of Scope (Documented Risk)

- Endpoint security on rep devices
- Social engineering of reps directly
- Coerced disclosure of a rep's auth credentials
- Physical theft of an unlocked device
- The integrity of the Excel files the rep chooses to import (if the rep imports a tampered file, the import will faithfully reflect what's in it; we cannot detect upstream tampering)

### 2.1 Auth-specific threats and mitigations (Milestone 1.2)

Concrete adversary actions against the authentication surface and how the 1.2 design (per ADR-0001) blocks or contains them.

| # | Threat | Adversary | Mitigation in 1.2 | Residual risk |
|---|---|---|---|---|
| T-A1 | Phishing the co-chair's password | Opportunistic / targeted | Passkey/WebAuthn primary path is phishing-resistant (origin-bound). Password fallback is gated by mandatory TOTP. | If the rep types both password and a fresh TOTP into a phishing site, attacker still needs to bypass the brute-force ladder on the real site. Acceptable; documented. |
| T-A2 | Credential stuffing on the password endpoint | Opportunistic | `login_attempts`-driven ladder: 5/15 min, 10/1 h, 20/manual. Constant-time response relative to credential verification to avoid an email-existence oracle. Rate limit 10 req/min/IP per `§3 Rate Limiting`. | Distributed attackers can hide under per-IP counters. Per-identifier counters catch this. |
| T-A3 | Session theft via XSS | Opportunistic / targeted | Tokens live in `__Host-*` HttpOnly Secure SameSite=Strict cookies. No `Authorization: Bearer` path. Strict CSP per `§3 Headers & Transport`. | If XSS lets the attacker make same-origin requests under the victim's session, the cookies will be sent — but only while the access JWT is valid (30 min). Step-up still required for sensitive actions. |
| T-A4 | Refresh-token replay after exfiltration | Targeted | Refresh tokens rotate on every use; reuse of a consumed refresh token is treated as compromise — the entire session row is killed and the user notified on next access. | Race window between use and rotation is sub-second. |
| T-A5 | JWT forgery | Targeted | EdDSA signing key in Fly Secrets only; `kid` header for rotation. Verifier only accepts known public keys. | Compromise of `AUTH_JWT_ED25519_PRIVATE_KEY_B64` is catastrophic — same blast radius as a DB-side session forge. Mitigated by Fly Secrets access controls. |
| T-A6 | WebAuthn challenge replay | Targeted | Challenges are single-use, 60-second TTL, stored server-side in `webauthn_challenges` and deleted on verify. UV is required on both registration and authentication. | None material. |
| T-A7 | Authenticator counter rollback | Targeted | `passkey_credentials.counter` is monotonic; any decrease vs. stored value fails authentication and flags the credential. | Authenticators that don't increment the counter (some platform authenticators) are accepted; documented. |
| T-A8 | TOTP brute force | Opportunistic / targeted | TOTP path inherits the `login_attempts` ladder. 30-second window with single-step skew tolerance only. | Negligible at ladder thresholds. |
| T-A9 | TOTP secret theft from DB | Insider / compromise | TOTP secrets encrypted at rest with the master key (via the 1.2 crypto stub; XChaCha20-Poly1305 in 1.3). Master key in Fly Secrets, never logged. | Master-key compromise compromises all stored TOTP secrets. Mitigated by Fly Secrets access controls + planned key rotation in 1.3. |
| T-A10 | Recovery-code theft | Insider / compromise | Codes stored as BLAKE2b hashes; only the user holds the plaintext (shown once at enrollment). | If the rep records codes in a compromised password manager, attacker can use them. Out of scope per §2 "Endpoint security." |
| T-A11 | First-run hijack | Opportunistic | `setup_state` singleton; the route returns 404 once `first_run_completed_at` is set. First-run does not require auth (you're bootstrapping) — but the route is on a fly-internal hostname during initial deploy if the operator follows the runbook. | If the production hostname is exposed before first-run completes, an attacker who reaches the URL first claims the co-chair account. **Runbook must require first-run before public DNS cutover.** |
| T-A12 | Step-up bypass | Targeted | `requireStepUp` middleware checks the access JWT's `step_up_until` claim. Claims are signed; the only way to forge one is T-A5. Step-up window default 5 min; export endpoints override to 60 s. | None at the auth layer. |
| T-A13 | Lockout used as a DoS against the rep | Targeted | Lockouts are scoped per-identifier *and* per-IP. A rep coming from a fresh IP can still authenticate even if their email is locked from another IP. **Manual-unlock (20-fail) tier is the residual DoS surface.** | The 20-fail tier requires a CLI ops action — documented in `docs/runbooks/auth.md` (follow-up). The rep can also authenticate via passkey path, which bypasses the password-side counters. |
| T-A14 | Audit gap during 1.2 → 1.3 window | Compelled disclosure / adversarial review | All auth events written to `auth_events` table in 1.2. 1.3's chained logger appends a backfill anchor whose payload is the SHA-256 of the canonical-JSON of those rows. Tamper of pre-chain rows is detected when the backfill anchor is re-verified. | Tamper *between* the event write and the 1.3 backfill anchor is undetectable. Window is the 1.2 → 1.3 calendar gap (≤ 2 weeks per ROADMAP). Accept and document. |
| T-A15 | Side-channel / timing oracle on email existence | Opportunistic | Password-path code does an Argon2id verify against a canary hash when the user doesn't exist, so latency does not distinguish "no such user" from "wrong password." Passkey path is discoverable-credential-first so no identifier is sent in plaintext at all. | None material. |
| T-A16 | Cross-origin/CSRF write via `__Host-*` cookies | Opportunistic | `SameSite=Strict` on all auth cookies. Mutating endpoints also require a custom header (`X-Requested-With: jhsc-web`) that simple CSRF forms cannot set. | None material. |

### Auth data flows (1.2)

```
[browser] --TLS--> [Hono /api/auth/*] --DB-->  users, sessions,
                                              passkey_credentials,
                                              password_credentials,
                                              totp_credentials,
                                              recovery_codes,
                                              login_attempts,
                                              auth_events,
                                              setup_state,
                                              webauthn_challenges
                                              (all in Neon ca-central-1)
                                              
                              \--Fly Secrets--> MASTER_KEY,
                                                AUTH_JWT_ED25519_PRIVATE_KEY_B64,
                                                AUTH_JWT_ED25519_PUBLIC_KEY_B64
```

No PI in transit beyond what the rep types (email at first-run, optional display name). No PI in JWT claims (only opaque `sub`, `sid`, `iat`, `exp`, `step_up_until`). No PI in `auth_events.metadata` (IP and UA only, plus typed event kinds).

### Trust boundaries (1.2)

- **Browser ↔ API:** untrusted on both sides of the wire; TLS 1.3 only; HSTS preload.
- **API ↔ Postgres:** API-side validates and authorizes every query; the DB role used by `apps/api` cannot read `auth_events` from a non-API session (enforced by row-level controls + a separate read-only role for the audit-verify script in 1.3).
- **API ↔ Fly Secrets:** read-only; the API never writes secrets. Secrets never appear in logs (the Pino redactor's allowlist already strips known secret keys; an additional regex catches `AUTH_JWT_*` and `MASTER_KEY`).

### 2.2 Audit-chain and crypto threats (Milestone 1.3)

Threats specific to the `packages/audit` tamper-evident chain and the `packages/crypto` wire format introduced in 1.3 (per ADR-0002).

| # | Threat | Adversary | Mitigation in 1.3 | Residual risk |
|---|---|---|---|---|
| T-AC1 | Tampered `audit_log` row body | Insider / compelled disclosure | `this_hash` covers every column in canonical-JSON order via SHA-256(`prev_hash || canonical_json(headers + payload)`). `scripts/audit-log-verify.ts` recomputes the full chain nightly via cron + on-demand via runbook §7. | Tamper is detected, not prevented; runbook §7 covers the response. |
| T-AC2 | Inserted "phantom" row breaks the chain | Insider / compelled disclosure | Every row's `prev_hash` is the previous row's `this_hash`. A row inserted out of band by SQL would have `prev_hash` matching its real predecessor and `this_hash` self-consistent for its own body, but the row AFTER it (next legit `append()`) would compute `prev_hash` from the phantom's `this_hash` and the chain integrity holds — except that `verify()` walks `idx` order and the phantom's `idx` must fit. A phantom with no later legit appends is detected by the next nightly verify when the table is empty downstream. | A clever insider could replace ALL downstream rows AND the phantom; mitigated only by off-host archival (1.3 §3a + 1.12 hardening). |
| T-AC3 | Gap (missing `idx`) | Insider / DB corruption | `idx` is `bigint primary key`, monotonic. `verify()` walks `idx ASC` and reports a gap as `firstDivergence`. Gaps are not crashes — operations continue but verify reports tamper, triggering runbook §7. | None at the application layer. |
| T-AC4 | Race between concurrent `append()` calls | n/a (operational) | `append()` runs `SELECT … ORDER BY idx DESC LIMIT 1 FOR UPDATE` inside the transaction, serializing appenders. Throughput is single-machine — fine for single-tenant. | Multi-rep concurrent writes (a future scope) would need an advisory lock or a single appender process. Documented in ADR-0002. |
| T-AC5 | Genesis-row replacement | Compromised migration | `idx=0` is inserted by the migration in an idempotent script that fails if `idx=0` already exists. `prev_hash` for genesis is `\x00 × 32`; `verify()` requires this at chain start. Replacement of genesis requires admin access AND would invalidate every subsequent `this_hash`. | None at the application layer. |
| T-AC6 | 1.2 → 1.3 backfill anchor tamper | Insider / compelled disclosure | Anchor row at `idx=1` carries `rows_sha256` over the canonical JSON of `auth_events` in `(ts, id)` order. A re-run of `verify()` recomputes that SHA-256 from the live `auth_events` and matches it. Tampering `auth_events` rows post-1.3 is detected at next verify. | Tamper between the 1.3 deploy and the first nightly verify is possible — narrow window, accepted. |
| T-AC7 | Crypto stub forward-read on a v=0x02 ciphertext | Misconfigured rollback | `open()` rejects unknown version bytes with `CryptoOpenError(unsupported_version)`. A rollback that re-runs 1.2 binaries against 1.3-written rows fails loud, not silent. | A rollback strategy must be paired with a re-encrypt-to-v0x01 dump — but rolling back from 1.3 to 1.2 is not supported anyway. |
| T-AC8 | KEK leak via subprocess argv | Operational | The new master-key rotation runbook (§3a) uses Fly Secrets only; the KEK never appears in argv to any rotation script. `packages/crypto` takes a `KeyProvider` interface so neither tests nor scripts need to env-read directly. | Operator error remains the residual; runbook calls it out. |
| T-AC9 | Payload PI leak | Implementer error | `packages/shared-types` exports per-`kind` discriminated unions for audit payloads. PI fields (email, displayName, plaintext body) are not declared on any union — the typechecker rejects them at every `append()` site. Runtime safety net: a JSON-schema reject layer (1.12 hardening) backs up the type-only check. | Without the runtime check (deferred to 1.12) a `kind` not yet typed could pass a PI string; type discipline catches the common case. |
| T-AC10 | Multi-kid JWT verifier rejects valid token at rotation | Operational | The kid registry accepts `legacy` for tokens without a kid suffix (1.2-compat). Rotation runbook §3 sequences `flyctl secrets set` for the new kid BEFORE flipping `AUTH_JWT_ACTIVE_KID`. | A misconfigured rotation that forgets the new public key still rejects in-flight tokens. Documented. |

### 2.3 Auth + crypto-chain integration threats

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T-AI1 | TOTP reset endpoint abused to reset a victim's TOTP | TOTP reset is step-up-gated. Step-up requires either passkey or current TOTP. The attacker would need to already control one of these factors. | None material. |
| T-AI2 | Step-up modal bypass | Modal opens on a 401-StepUp from `stepUpEmitter`. Server is the source of truth; modal cannot self-claim grant. Server re-issues the access JWT with `step_up_until` claim only after a verified factor. | None material. |
| T-AI3 | KEK rotation while sessions are live | Session refresh re-derives email lookup hashes from the NEW KEK. Tokens issued before rotation continue to validate (access JWT signing keys are independent); first refresh after rotation pins the new KEK. Runbook §3a sequences rotation during a low-traffic window. | Sessions issued just before rotation may see one transient lookup failure during the rotation window. Acceptable; documented. |

---

## 3. Security Controls

### Authentication

- **Primary:** Passkey/WebAuthn (FIDO2). Phishing-resistant. Bound to origin.
- **Fallback:** Username + password (Argon2id: 64MB mem, 3 iter) + mandatory TOTP (RFC 6238).
- **Session:** JWT (EdDSA, 30 min access) + refresh token (HttpOnly, Secure, SameSite=Strict, 14 days). Rotates on use.
- **Step-up auth:** Re-prompt for passkey/TOTP before exports, identity decryption, deletions, **Excel import commits, Excel import reverts, action item archival**.
- **Device registration:** Optional but tenant admin can require it.
- **Brute force protection:** 5 failed = 15 min lockout; 10 = 1 hour; 20 = manual unlock required.

### Encryption

- **In transit:** TLS 1.3 only. HSTS preload. No HTTP fallback.
- **At rest (sensitive fields):** XChaCha20-Poly1305 via libsodium, application-layer, before Postgres write.
- **At rest (files):** Client-side encryption before Tigris upload. Tigris stores ciphertext only.
- **Local cache:** IndexedDB sensitive fields encrypted with session-derived key. Cache cleared on logout.
- **Master key:** Fly Secrets, accessible only to `api` Machine process. Never logged. Never returned by API.
- **Key rotation:** Annual rotation of derived keys. Master key rotation triggers re-encryption sweep.
- **Excel import encryption:** Sensitive fields encrypted in the browser via libsodium-wrappers BEFORE any API call. The raw Excel file never leaves the device.

### Tenant Boundaries (Single-Tenant)

User-level access controls still apply:

- Every query is scoped to the authenticated user's role
- A `worker_rep` cannot read another rep's practice journal
- A `read_only` reviewer cannot decrypt member identities without re-consent
- Audit log writes are immutable; users cannot delete their own entries
- **Action item moves cannot be silently rolled back — every move is permanent in the audit log even if the item is moved again**

### Audit & Logging

- **Tamper-evident audit log** (hash chain, HMAC-seeded).
- **What gets logged:** all writes to sensitive tables, all reads of decrypted sensitive fields, all exports, all auth events, all config changes, **all Excel import lifecycle events, all action item section moves**.
- **What does NOT get logged:** sensitive field contents, encryption keys, passwords, full request bodies for sensitive endpoints. Logs contain identifiers and metadata only.
- **Log retention:** 90 days hot, 1 year cold. Audit log entries are immutable.
- **Verification:** `scripts/audit-log-verify.ts` runs nightly via cron.

### Headers & Transport

(Unchanged. CSP strict mode, HSTS preload, Permissions-Policy blocking unneeded APIs, COEP/COOP for cross-origin isolation.)

### Input Validation

- All API inputs validated with Zod schemas
- Server-side validation is the source of truth
- File uploads (evidence): type-sniffed, size-limited (50 MB default), hashed
- HTML user input rendered with proper escaping; rich text passed through DOMPurify
- **Excel parsing: see § Excel Import Security below**

### Rate Limiting

- Auth endpoints: 10 requests / minute / IP
- API write endpoints: 60 / minute / user
- AI proxy: 30 / hour / user
- Export endpoints: 5 / hour / user
- **Excel import preview: 10 / hour / user** (preview is cheap; commits require step-up auth anyway)

### Dependency & Supply Chain

- `pnpm audit` runs on every CI build; high/critical vulns block merge
- Dependabot enabled
- Gitleaks scans every push for committed secrets
- Lockfile committed; changes reviewed
- Minimal dependency footprint
- No analytics SDKs, no telemetry, no third-party tracking
- **SheetJS is the only Excel-parsing dependency; pinned to a specific version with regular review of CVEs**

### Browser & Mobile Hardening

(Unchanged. Service worker integrity checks, IndexedDB cleared on logout, camera-captured photos never written to device library, biometric prompt after idle, auto-logout.)

---

## 4. Excel Import Security

### Why This Needs Its Own Section

Excel files are an attack surface. .xlsm files can contain VBA macros (we don't execute them, but the file can also contain crafted content that targets parser bugs). Even .xlsx files can contain XXE attacks, zip bomb attacks, formula injection attacks, and embedded executables.

The fact that we parse client-side instead of server-side is a meaningful mitigation — a parser exploit attacks one rep's browser, not the whole platform. But we still defend.

### Supported File Family

One file family is recognized and parsed; everything else is rejected:

1. **Minutes files** (.xlsm or .xlsx) — meeting minutes with action item tracking

Inspection file imports are not supported in Release 1. Inspections are conducted natively in-app.

### Controls

1. **Pure parsing only.** SheetJS is configured with `cellFormula: false` and `cellHTML: false`. We never evaluate formulas or interpret HTML in cells.
2. **No macro execution.** VBA macros in .xlsm files are ignored. They are not interpreted, not displayed, not stored.
3. **Zip bomb protection.** Files >10 MB rejected at file-picker time. Decompressed size capped at 100 MB.
4. **Schema-first parsing.** We don't attempt to "interpret" arbitrary Excel files. The parser looks for our documented schema (`docs/excel-import-format.md`) and rejects anything that doesn't match. Files that look hostile but happen to match the schema would have to look like valid JHSC minutes — a high bar.
5. **Sanitization at parse.** Cell values are coerced to expected types. Strings are trimmed and length-capped (descriptions: 5000 chars, names: 200 chars).
6. **Formula injection prevention.** If a string cell begins with `=`, `+`, `-`, `@`, or tab, prepend a single quote when storing. This is defense for any downstream Excel exports.
7. **HTML injection prevention.** All imported text is treated as plain text and properly escaped wherever rendered.
8. **Hash-based provenance.** The SHA-256 of the imported file is stored (not the file itself). This lets us prove later "this action item came from this specific file at this time."
9. **No execution of imported content.** Imported text is never `eval`'d, never rendered as HTML without escaping, never used as a template string, never passed to a query builder as raw SQL.
10. **Preview before commit.** Every import shows the rep what will happen before anything is created. Conflicts and surprises surface to the rep.
11. **Reversible for 30 days.** If a malicious import is discovered, it can be reverted within 30 days (creates an audit entry of the revert).
12. **No bulk auto-import.** Files must be selected one at a time via file picker. No "watch this folder" automation.
13. **PII scanning on imports.** Each imported field is run through the client-side PII heuristic. Fields detected as likely containing names or identifying info are encrypted before they leave the browser.

### What We Don't Defend Against

- A rep importing their own legitimate file with embedded names of real workers. That's the intended use case. The fact that names are in the file means they need to be encrypted, but not blocked.
- A rep importing a file given to them by a third party who modified it maliciously. We trust the rep's choice of file. We do warn (via the file hash and source documentation) that imports are tied to specific source files.
- An attacker with rep credentials importing a malicious file. The step-up auth on commit, the preview, and the audit log are the mitigations here.

---

## 4a. Export Security

Inspection PDF exports are a new attack surface — once a document leaves the app, the rep is responsible for handling it. The app's job is to make exports auditable and tamper-evident.

### Controls

1. **Step-up auth before export.** Re-authentication required (passkey or TOTP) before generating any PDF.
2. **Audit-logged.** Every export creates an `export_records` entry with: exporter identity, exported_at timestamp, IDs of records included, output document hash (SHA-256), audit chain anchor. The audit entry is immutable.
3. **Tamper-evident output.** Every generated PDF includes a footer on every page:
   - Exported by [user] on [ISO date]
   - Document hash: sha256 [hash]
   - Audit anchor: [hash]
   This makes after-the-fact modification detectable.
4. **Decryption is in-memory only.** Sensitive fields are decrypted only long enough to render to PDF, then zeroed in memory. No plaintext copy persists.
5. **Rate-limited.** Maximum 5 exports per hour per user (matches general export rate limit). Batch exports capped at 100 inspections per call.
6. **No background or scheduled exports.** Every export is initiated by a logged-in user with step-up auth. No cron-job exports, no automatic "send me my data weekly" features.
7. **Photos in PDFs are decrypted and embedded** — this is the necessary purpose of export. The footer disclosure makes downstream leaks traceable to the exporter.
8. **Exports do not include audit log content** by default. The audit chain anchor is included so the chain can be verified, but the chain itself stays in the database. A separate audit-log export endpoint exists for the rare case where the chain must travel with the document.

### What This Doesn't Defend Against

- A rep exporting and then carelessly sharing a PDF. Once the PDF leaves the app, it's the rep's responsibility.
- A subpoenaed disclosure of an exported PDF. The export was authorized by the rep at the time; the audit log proves what was exported. If the rep is later forced to disclose, the disclosure is the issue, not the export.
- An attacker with rep credentials exporting and exfiltrating. The step-up auth and rate limits are the mitigations; the audit log lets you detect this after the fact.

---

## 5. Action Item Move Integrity

The action item section lifecycle is operationally critical. Each move (e.g., New Business → Old Business) is:

1. **Recorded in `action_item_moves`** with timestamp, actor, from/to sections, optional reason
2. **Linked into the audit chain** with hash continuity
3. **Counter-signed by the meeting context** — moves happen "in a meeting," and the meeting ID is part of the audit metadata
4. **Subject to step-up auth for archival** — moving an item out of normal view (to "archived") requires re-authentication

Why this matters: a rep needs to be able to prove later, in front of an arbitrator, that an item was raised on date X, moved to old business on date Y, and closed on date Z. The audit chain provides that proof. Tamper would be detected by the chain verification routine.

---

## 6. Privacy Controls

(Largely unchanged. Data minimization, consent capture, pseudonymization at intake, PIPEDA rights.)

### Excel Import Privacy

- **The raw Excel file never leaves the device.** It's parsed in the browser.
- **Imported content is encrypted at the application layer** before any sync to the server.
- **Imports respect the same retention rules** as direct data entry. If a record is purged, its source-file reference is purged too.
- **A rep can revert an import** to remove all records that came from a specific file. The audit log retains the revert event but the content is cryptographically erased.

### Cross-Border Disclosure (Honest Statement)

Fly.io and Neon are US-incorporated. CLOUD Act applies. The encryption mitigates substantially — a compelled disclosure yields ciphertext for sensitive fields. **Excel import data is in the same category** — once it's in the database, it benefits from the same encryption guarantees and faces the same theoretical compelled-disclosure exposure.

---

## 7. Incident Response

(Unchanged from prior spec. P0–P3 classification, detect/triage/contain/eradicate/recover/notify/post-mortem.)

### New Incident Types

- **Malicious Excel import discovered** — treat as P2 unless the import affected the audit chain (then P0). Revert the import. Audit affected records. Notify the rep.
- **Action item move integrity failure** — audit chain verification finds a missing or inconsistent move. Treat as P1. Investigate, restore from chain backup if possible, document.
- **PII heuristic false negative on import** — sensitive content imported in plaintext column. Treat as P1. Immediately encrypt affected fields, re-key if needed, audit the import.

### Breach Notification

PIPEDA s.10.1 still applies. For JHSC worker data, the threshold is generally met if member identities or medical information are exposed, including via a compromised import.

### Backup & Recovery

- Neon point-in-time recovery: 7-30 days
- Nightly encrypted `pg_dump` to Tigris
- Monthly local cold-storage copy
- Quarterly restoration drill
- **Action item move history is included in all backups and verified during restoration drills**

---

## 8. Pre-Launch Security Checklist

Before going live with real worker data:

- [ ] All sensitive fields encrypted at application layer (verified by Neon query inspection)
- [ ] Audit log verification passes on full dataset
- [ ] CSP strict mode active, no inline scripts
- [ ] All security headers verified (observatory.mozilla.org)
- [ ] HSTS preload submitted
- [ ] Passkey enrollment tested on iOS and Android
- [ ] TOTP fallback tested
- [ ] Step-up auth tested for all sensitive operations
- [ ] Rate limits verified
- [ ] Backup and restore tested end-to-end
- [ ] Disaster recovery: full app rebuilt from scratch using only backups
- [ ] `pnpm audit` clean
- [ ] Gitleaks clean
- [ ] Penetration test attempted (OWASP ZAP minimum)
- [ ] Incident response playbook reviewed
- [ ] Privacy notice drafted
- [ ] Cold-storage backup procedure tested
- [ ] Logout / session expiry tested mobile + desktop
- [ ] Biometric re-auth tested after idle timeout
- [ ] Workplace config loads from env, not committed
- [ ] Camera photos bypass device library (verified)
- [ ] **Excel import: malicious file fuzzing performed against parser**
- [ ] **Excel import: zip bomb rejection tested with crafted file**
- [ ] **Excel import: formula injection prevention verified in downstream exports**
- [ ] **Excel import: PII heuristic tested with realistic minutes content**
- [ ] **Excel import: preview-then-commit flow tested end-to-end**
- [ ] **Excel import: reversal within 30 days tested with audit log verification**
- [ ] **Action item move audit chain verified across 100+ simulated moves**
- [ ] **Inspection template versioning tested — historical inspection rendered correctly under old template version after template upgrade**
- [ ] **Inspection manual promotion tested — one-tap promotion creates correctly-linked action item in new_business section**
- [ ] **Inspection PDF export — single inspection produces evidence-grade output with hash footer**
- [ ] **Inspection PDF export — date-range batch (100 inspections) renders correctly with table of contents**
- [ ] **Inspection PDF export — step-up auth enforced, audit log entry created with output hash**
- [ ] **Inspection PDF export — verified that modifying the exported PDF causes hash mismatch detectable on re-verify**

---

## 9. Ongoing Security Operations

(Unchanged: weekly audit log review, dependency checks, monthly audit, quarterly pen test, annual key rotation.)

Additions:

- **Monthly:** Review Excel import logs. Confirm no unexpected high-volume imports.
- **Quarterly:** Re-fuzz the Excel parser with the latest SheetJS version.
- **Annually:** Review the schema in `docs/excel-import-format.md` against actual workplace files. Update as the rep's workflow evolves.
