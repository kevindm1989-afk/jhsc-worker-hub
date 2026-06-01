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
| T-AC11 | `operator` field in `lockout.cleared` / `session.revoked` payloads leaks PI by linkage | Operational | The `operator` field carries `$(whoami)` from the admin CLI. In a single-tenant, single-co-chair deployment the OS user IS the co-chair, so the field is a self-identifier (not third-party PI). A future multi-rep scope (1.12+) revisits. Documented. | Privacy posture depends on the operator's account naming. Tracked. |
| T-AC12 | `audit_log` IP/UA retention exceeds PIPEDA P5 floor | Operational | Documented in `.context/decisions.md` 2026-05-29 entry: indefinite chain retention with annual IP/UA redaction sweep + `audit.ip_redacted` chain anchor. Sweep script is a 1.12 hardening line item. Until it lands, IP/UA persist for the full chain age. | Documented residual; 1.12. |

### 2.3 Auth + crypto-chain integration threats

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T-AI1 | TOTP reset endpoint abused to reset a victim's TOTP | TOTP reset is step-up-gated. Step-up requires either passkey or current TOTP. The attacker would need to already control one of these factors. | None material. |
| T-AI2 | Step-up modal bypass | Modal opens on a 401-StepUp from `stepUpEmitter`. Server is the source of truth; modal cannot self-claim grant. Server re-issues the access JWT with `step_up_until` claim only after a verified factor. | None material. |
| T-AI3 | KEK rotation while sessions are live | Session refresh re-derives email lookup hashes from the NEW KEK. Tokens issued before rotation continue to validate (access JWT signing keys are independent); first refresh after rotation pins the new KEK. Runbook §3a sequences rotation during a low-traffic window. | Sessions issued just before rotation may see one transient lookup failure during the rotation window. Acceptable; documented. |

### 2.4 Corpus integrity threats (Milestone 1.4)

The legal corpus (OHSA, O. Reg. 851, CLC Part II, COHSR) underlies citation rendering, recommendation linkage, and the `/legal` search surface. Wrong text shown to a JHSC member can produce non-compliant recommendations; stale text shown against an old `version_date` can mis-anchor a historical recommendation. The clauses table is the trust anchor — both for what readers see today and for what future readers see when chasing a past audit citation.

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T-LC1 | Wrong clause served — e.g. `OHSA s.25(2)(h)` returns `s.25(2)(c)` due to a seeder ordering bug or a hand-edit | Seeder is the **only** writer (no admin write endpoint). Every clause is keyed on `(statute_id, citation, version_date)` UNIQUE. `<CitationRef />` resolves via `(statute, citation)` against the **active** corpus_version; recommendation reads pin `(citation, version_date)` so historical recs cannot be re-anchored by a re-seed. Seeder runs a post-load sweep that asserts `(statute_id, citation, version_date)` count matches the fixture row count. | A fixture authoring error (wrong body for the right citation) is not caught by structural checks; mitigated by 2-person fixture review documented in `docs/runbooks/legal-corpus.md`. Acceptable. |
| T-LC2 | FTS index poison — `tsvector` index returns a clause that does not contain the search terms, or hides one that does | `search_tsv` is a `GENERATED ALWAYS AS (...) STORED` column derived from `(heading, body, citation)`; it cannot be set out-of-band. The expression is fixed in migration 0002 and any change is a new migration reviewed under the SQL-migration policy. Search route returns `(clause_id, citation)` only; the client re-fetches the body through the canonical `GET /api/legal/clauses/:id` so a poisoned ranking cannot ship the wrong body. | A skewed ranking can still bury the right answer; UI surfaces full `citation` and `version_date` so the reader can disambiguate. Acceptable. |
| T-LC3 | Hash-anchor mismatch on recommendation read — recommendation references a clause body that has been superseded by a re-seed | `body_hash = SHA-256(body \|\| version_date.toISOString())` is stored on every clause row. Recommendation rows persist `(clause_id, body_hash)` at write time. Recommendation read API joins on `body_hash` and returns a `clause_superseded` flag when the live row's hash differs, with a `superseded_by` pointer so the reader can see both the original and the current text. Re-seed updates never UPDATE an existing row; they INSERT a new `(statute_id, citation, version_date)` and set the prior row's `superseded_by`. | Reader is shown both versions; mitigation is detection, not silent rewrite. Acceptable. |
| T-LC4 | Copyright violation via summary→full_text drift — a `third_party_restricted` statute (CSA, ISO, ACGIH) lands in the DB with `body_kind='full_text'` | Structural copyright guard in the seed loader: any fixture with `statutes.licence='third_party_restricted'` and `clauses.body_kind='full_text'` fails the seeder with exit 1 before any row is written. Reinforced by a DB CHECK constraint on the clauses table: `body_kind = 'full_text' IMPLIES (SELECT licence FROM statutes WHERE id = statute_id) = 'crown_copyright_open'`. Implemented as a trigger because Postgres CHECK can't subquery. | A fixture author who alters the statute's licence row in the same commit can defeat the trigger; mitigated by the 2-person fixture review and a CI grep for `licence = 'third_party_restricted'` diffs on PRs that also touch clauses fixtures. Acceptable. |
| T-LC5 | Re-seed accidentally overwrites historical text — operator runs the seeder against a checked-out older fixture set and the live `version_date` rows get rewritten | Seeder never issues UPDATE on clauses; it is INSERT-only. A re-seed with the same `(statute_id, citation, version_date)` triggers the UNIQUE constraint and aborts the transaction. To publish a correction at the same `version_date`, the operator must INSERT a new `version_date` (one day later, with a `correction_of` pointer) — there is no in-place edit path. | Seeder failure surfaces as an exit code and a `audit.corpus.seeded` chain event is NOT emitted for the failed run; runbook §4 covers the recovery procedure. Acceptable. |
| T-LC6 | `corpus_versions` ledger tamper — attacker rewrites the ledger so the active version points at stale text | `corpus_versions` rows are referenced by `clauses.corpus_version` via FK with `ON DELETE RESTRICT`. The active version is selected by `MAX(activated_at)` over rows where `retired_at IS NULL`. Each `corpus_versions` insert emits an `audit.corpus.seeded` chain event with `{version, statutes[], clause_count, fixture_sha256}`; tampering with the ledger leaves the chain event in place, and `audit-log-verify` flags any version row whose `fixture_sha256` does not match the chain anchor. | Detection-only; an attacker with DB-write can both rewrite the ledger AND prepend a fake chain event, but the chain's `prev_hash` linkage means re-anchoring requires rewriting every subsequent event (same property the audit-chain already relies on). Acceptable. |
| T-LC7 | `<CitationRef />` renders a citation that no longer exists in the active corpus | Component server query is `SELECT id, body, body_kind, body_summary, version_date FROM clauses WHERE statute_id = $1 AND citation = $2 AND corpus_version = $active_version LIMIT 1`. On zero rows, renders a `<MissingCitation citation={...} />` placeholder with a link to the `/legal` search surface; does NOT silently fall back to a different `version_date`. Recommendation editor's citation picker validates against the active corpus before save, so authoring a missing citation requires going around the UI. | Hand-authored content (markdown body) can reference a removed citation; renderer shows the placeholder. Acceptable. |
| T-LC8 | Search endpoint exfiltrates restricted body text — `third_party_restricted` summary rows leak full text via aggregation | Search route projects `(clause_id, citation, version_date, heading, body_kind, ts_rank)` plus a `snippet` derived ONLY from `(heading, body_summary)` for restricted rows and from `(heading, body)` for crown-open rows. The `body` field is never returned by the search route. `GET /api/legal/clauses/:id` returns `body` only when `body_kind='full_text'`; for `body_kind='summary'` it returns `body_summary` and a `source_url`. | A reader can reconstruct partial text via many narrow searches against a restricted summary; surface area is bounded to the summary text only, which is the JHSC's own paraphrase. Acceptable. |

**Audit hooks for corpus changes.** The audit-chain emits two corpus event kinds (`audit.corpus.seeded`, `audit.corpus.amended`) with no payload fields containing PI. Payload schema is fixed in `packages/shared-types` and enforced at the typed-emit boundary (priv-F2 design from Milestone 1.3 extends to corpus events). Verification: `audit-log-verify --check-corpus` cross-checks every `corpus.seeded` event's `fixture_sha256` against the live `corpus_versions` row.

**Close-out review findings (Milestone 1.4 slice 5).**

| Finding | Where landed |
|---|---|
| sec-F1 — XSS via fixture body → `ts_headline` snippet | Web renderer switched off `dangerouslySetInnerHTML` to a strict `<mark>`-split renderer (`apps/web/src/views/legal-view.tsx` `SnippetRenderer`); Zod fixture schema rejects `<` `>` in `body` / `heading` / `body_summary` (`packages/legal-corpus/src/fixtures.ts`). |
| sec-F2 — statute UPDATE flipping licence orphans full_text clauses | `statutes_copyright_guard_trigger` added in migration 0003 — refuses the UPDATE when matching clauses exist. |
| sec-F3 — `sql.raw` for `hierarchy_path` | Seeder switched to `sql.join` over parameter-bound elements (`apps/api/scripts/seed-legal-corpus.ts`). |
| sec-F4 — no rate limit on `/api/legal/search` | Token-bucket middleware (`apps/api/src/middleware/rate-limit.ts`): `/search` 20 burst / 5 rps, `/clauses` + `/statutes` 60 burst / 20 rps, keyed by `Fly-Client-IP`. |
| sec-F5 — partial re-seed orphans existing statutes | Read routes now filter `superseded_by IS NULL` instead of `corpus_version = active`; seeder refuses to drop a previously-loaded statute without `--allow-statute-removal`. |
| sec-F6 — restricted body text reachable via FTS oracle | `search_tsv` rebuilt in migration 0003 as licence-aware (`body_summary` for `summary` rows; `body` for `full_text`); DB CHECK `body_kind='full_text' OR body_summary IS NOT NULL`. |
| priv-F1 — referrer policy on web origin | `<meta name="referrer" content="no-referrer">` added to `apps/web/index.html` as defence-in-depth for the existing `rel="noreferrer"` anchors. |
| priv-F2 — `verified_by="kdm"` is operator initials | All four seed fixtures + Zod test fixture changed to `verified_by="corpus-operator"`; out-of-band operator log in `docs/runbooks/legal-corpus.md` §3. |
| priv-F3 — OHSA s.9(20) text may be mislabelled | Privacy reviewer flagged a possible swap between s.9(18) and s.9(20); reviewer could not independently fetch e-Laws (network policy blocks it). Mandatory 2-person verification gate now blocks Milestone 1.9 ship — `docs/runbooks/legal-corpus.md` §2. |
| priv-F5 — `corpus_versions.operator` column dropped from ADR | Implementation divergence documented in ADR-0003 §"Implementation divergences"; runbook §3 records operator identity out-of-band. |
| priv-F6 — `/api/legal/*` rode auth cookies | Web client `apps/web/src/legal/api.ts` switched to `credentials: 'omit'`. |

### 2.5 Hazards threats (Milestone 1.5)

Hazards are the first DB surface that carries worker-personal content: rep-authored descriptions of conditions, reporter identity when not anonymous, and (optionally) location detail naming a specific worker's station. Encryption applies at the column level via the `@jhsc/crypto` envelope (1.3). The hazard lifecycle is chain-anchored — every status transition emits `hazard.status_changed`, every create emits `hazard.created` — so the JHSC-discipline question "who closed H-47 and why" has a tamper-evident answer in `audit_log`.

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T-H1 | Description ciphertext exfil via DB compromise reveals worker concerns | All four sensitive columns (`description`, `reporter_identity`, `location_detail`, `status_history.reason`) are sealed with per-row DEKs under the workplace KEK. Postgres sees ciphertext only; KEK lives in Fly Secrets. CLAUDE.md §"Encryption Rules" honored. | DB-level attacker with `pg_dump` access still gets ciphertext; KEK is the bound. Acceptable; same as 1.3. |
| T-H2 | Status-workflow skew lets a hazard skip the JHSC's accountability path (e.g. `open → archived` direct) | The allowed-transitions graph is a pure-function helper (`apps/api/src/hazards/transitions.ts`). The PATCH route validates the requested transition against the graph before writing; an invalid transition returns 422 with the rejected pair. Tests assert every legal transition AND that a representative sample of illegal transitions (`open → resolved`, `open → archived`, `resolved → open`) is rejected. | A handler bug could still drift the graph — covered by the unit tests on the pure helper. Acceptable. |
| T-H3 | Withdrawn used as a delete escape valve to erase an inconvenient hazard | `withdrawn` is the only "cancel" path; it is fully audited (chain event + encrypted reason) and the row stays in the DB. Step-up required for the `→ withdrawn` transition. Restore-from-withdrawn is not supported in 1.5; an operator who wants to revive a hazard re-creates it with a `linked_to_withdrawn` pointer (1.6). | A rep with their own step-up credential can still withdraw a hazard, but the chain row preserves who/when/why. Acceptable. |
| T-H4 | Reporter identity over-disclosure on `GET /api/hazards/:id` | The route returns `reporter_identity` plaintext only after a step-up check (same modal pattern as 1.2/1.3). List route never includes reporter identity in any form. The intake form's "report anonymously" checkbox sets `reporter_identity_ct = NULL`. | Step-up bound; an authenticated rep with their own factors can decrypt. Acceptable in the single-co-chair scope (CLAUDE.md). |
| T-H5 | Title field PI leakage — rep types a real name into the non-encrypted title | Title is bounded to 120 chars and the intake form's placeholder/help text directs to non-PI summaries (e.g. "Slip hazard — cooler floor", not "John's complaint about cooler"). Zod schema rejects titles longer than 120; no server-side PI scrubber. | A rep can still type a name; the intake-form copy is the bound. Documented; depends on rep discipline. |
| T-H6 | Search query log leaks intended content (`?q=Jane reported assault`) | The list route runs FTS over title only. Title is bounded as above. The search query is not persisted; access logs are policy-scoped per `docs/runbooks/auth.md` retention rule. | Access-log retention is the bound. Acceptable. |
| T-H7 | Audit chain emits PI via the hazard payload | `hazard.created` payload carries `{hazardId, hazardCode, severity, jurisdiction}` only. `hazard.status_changed` carries `{hazardId, hazardCode, fromStatus, toStatus}` only. No title, no description, no reporter. Reasons live in the encrypted `hazard_status_history.reason_ct` column, not the chain row. Same priv-F2 invariant as 1.3: typed payloads enforced at the `append()` boundary. | None material — the payload shape is fixed by the union type in `packages/shared-types`. |
| T-H8 | Status transition race — two reps PATCH the same hazard simultaneously | The PATCH route opens a Drizzle transaction, SELECTs the hazard's current status with `FOR UPDATE`, checks the transition, writes the new status + history row + audit append. The pg_advisory_xact_lock in `@jhsc/audit append()` serializes the chain side. The hazards-row lock serializes the row side. | Two PATCHes for different status moves still appear ordered; the second sees the first's status as the "from" and is rejected if illegal. Acceptable. |
| T-H9 | Hazard creation succeeds but chain emit fails — orphaned chain row OR orphaned hazard | Hazard insert + chain emit run inside one `db.transaction`. A failure on either rolls back both. The audit chain's PK-collision design (1.3 sec-F1) cannot leave a half-row. | Verified by integration test (S2). Acceptable. |
| T-H10 | Severity is selectable by the reporter, allowing under-rating to suppress urgency | Severity is the reporter's call by design — the rep is the SME and the JHSC reviews on assess. Status `assessing` is the explicit "JHSC reviews and may change severity" stage. Severity change inside `assessing` is a normal write; severity change after `assigned` requires the rep to transition back to `assessing` first. | Acceptable — matches OHSA s.9(20) workflow; the JHSC owns the severity call. |
| T-H11 | Hazard code (`H-NNN`) leaks workplace size via monotonic count | `H-NNN` is monotonic within a workplace. A list of hazard codes reveals approximate total count of reports filed. The codes are visible to any authenticated rep — same scope as the rest of the data. | Single-tenant deployment; the audience for hazard codes IS the JHSC. Acceptable. |
| T-H12 | KEK rotation while a status transition is in flight | Status transitions don't touch `reason_ct` of prior rows — they INSERT a new history row. The crypto-rewrap path (1.3) is the bound; a rotation runs the standard KEK rotation procedure (`docs/runbooks/auth.md` §3a), which already covers in-flight encrypted writes. | Same bound as 1.3 KEK rotation; documented. |

**Audit hooks for hazard changes.** Two new event kinds (`hazard.created`, `hazard.status_changed`) added to `packages/shared-types` `AuditEventKind`. Both payloads pass through the same typed-emit boundary as 1.3 — `emitAuthEvent`'s 1.3 invariant generalizes to all writers (priv-F2 from 1.3 carries forward).

**Close-out review findings (Milestone 1.5 slice 5).**

| Finding | Where landed |
|---|---|
| sec-F1 — no body-size limit or rate cap on `/api/hazards` | `bodyLimit({maxSize: 64 * 1024})` mounted on `hazardsRoute.use('*')` (returns 413 over the cap); existing token-bucket `rateLimit` middleware applied at `60 burst / 10 rps` per-IP. |
| sec-F2 — illegal_transition / step-up_required returned inside the FOR UPDATE transaction (held the row lock for response serialization) | Body parse + initial transition graph check + step-up freshness check moved OUTSIDE the transaction. Race-conditioned writes inside the lock throw `HazardWriteAborted` to roll back cleanly; the outer handler maps to the right JSON response. |
| sec-F3 — PATCH inline step-up bypassed the freshness floor + omitted `max_age` | New exported `checkStepUpFreshness` in `apps/api/src/auth/step-up.ts` is the single source of truth for the freshness check. The PATCH handler calls it with `maxAgeSeconds: 60` (destructive transition) — a re-step-up older than one minute is rejected and the WWW-Authenticate header carries `max_age="60"` so the web modal can warn correctly. |
| sec-F5 — list path crashed on a single corrupted ciphertext | Per-row `try/catch` around `openField`; bad rows surface as `summary: '[unreadable — open the detail view for diagnostics]'` so the rest of the list stays usable across KEK rotation edge cases (T-H12 in-flight). |
| sec-F6 — ILIKE wildcard injection (no security severity, but breaks the search contract) | `q` is escaped against `\`, `%`, `_` before pattern construction; query carries `ESCAPE '\'`. |
| sec-F7 — H-NNN sequence is non-contiguous (failed transactions leave gaps) | Documented in `docs/runbooks/hazards.md` §2 ("Hazard codes — non-contiguous by design"). Treated as an acceptable mitigation of T-H11. |
| priv-F1 — intake form copy misled about the encryption boundary | Caption replaced with "travel to the server over HTTPS, and are encrypted at rest with a key held by the workplace before they are written to the database." Empty-state copy similarly clarified. |
| priv-F2 — no runbook for hazards / PIPEDA right-to-erasure procedure | `docs/runbooks/hazards.md` lands covering schema overview, H-NNN non-contiguity, withdrawn lifecycle, PIPEDA Principle 9 response procedure (refuse-or-redact based on activity + retention + named-individual paths), KEK rotation impact, and tamper response. |
| priv-F4 — `safeSummary` returned 80 chars verbatim when no word boundary exists | Falls back to `(cap - 10)` when no usable space is in the prefix, shedding the trailing partial token. Seven new unit tests cover the boundary cases (`apps/api/src/hazards/crypto.test.ts`). |

### 2.6 Action items threats (Milestone 1.6)

Action items are the operational primitive of the Minutes module (CLAUDE.md non-negotiable #12) and the convergence point for hazards (1.5), recommendations (1.9), inspections (1.8), incidents (later), and Excel-imported historical items (1.11). The `_MoveHistory` sheet from the legacy spreadsheet workflow is replaced by `action_item_moves` — every section change is chain-anchored. Four envelope-encrypted fields carry the PI-bearing surfaces (description, recommended_action, raised_by external, follow_up_owner external). The Action Flag pure function (ARCHITECTURE.md §5) computes the 21-day s.9(21) indicator from canonical date columns at read time — no stored state to drift.

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T-AI1 | Description / recommended_action ciphertext exfil via DB compromise reveals worker concerns and management strategy | All four sensitive columns (`description`, `recommended_action`, `raised_by`, `follow_up_owner`) and `action_item_moves.reason` are sealed with per-row DEKs under the workplace KEK. Postgres sees ciphertext only. CLAUDE.md §"Encryption Rules" honored. | DB-level attacker still gets ciphertext; KEK is the bound. Same as 1.3/1.5. |
| T-AI2 | Section move bypasses the audit chain — a manual SQL UPDATE on `action_items.section` would skip the move row + chain anchor and break the "every move is logged" CLAUDE.md guarantee | The API has NO path that writes `action_items.section` outside the `POST /api/action-items/:id/moves` handler, which always emits the move row + chain anchor in one transaction. A manual SQL UPDATE is not blocked by Postgres CHECK (can't reference another table) but the audit-chain verify pass catches the divergence at read time. | Detection-only at the DB level. Documented in the runbook tamper procedure. |
| T-AI3 | Move-graph skew lets an item skip the workflow (e.g. `new_business → archived` direct) | The section transition graph is a pure function (`packages/shared-types/src/action-item-transitions.ts`); the route validates against it before writing. Tests assert legal/illegal pairs exhaustively. | A handler bug could drift the graph — covered by unit tests on the pure helper. Acceptable. |
| T-AI4 | Undo loop / chain-flood — a compromised credential spams moves + undoes to grow the chain or destabilize the move history | Rate-limit applies (`hazards` shape: 60 burst / 10 rps). Undo is step-up gated (`maxAgeSeconds=60`). The chain rows carry no PI, so growth is cheap in size; the operational concern is move-history readability, which the UI bounds via a "show undone" toggle. | Operational; rate + step-up are the bounds. |
| T-AI5 | Sequence-number collision under concurrent inserts | Per-section sequence is computed as `MAX(sequence_number) + 1 WHERE section = $1` inside the create transaction with a section-scoped row lock (advisory or SELECT MAX … FOR UPDATE). Two concurrent inserts serialize; rollback does not advance (unlike a Postgres sequence) so re-tries get the same next number. | If MAX-locking turns out to be a hotspot at scale (>10 inserts/sec into one section), revisit with a per-section sequence + a uniqueness CHECK. Single-co-chair scope: never. |
| T-AI6 | Audit chain emits PI via the action_item payload | Payload union in `packages/shared-types` restricts `action_item.created` to `{itemId, type, section, risk}`, `action_item.updated` to `{itemId, changedFields[]}` (a fixed allow-list of field names, never values), `action_item.moved` to `{itemId, fromSection, toSection, undone?}`, `action_item.move_undone` to `{itemId, movedItemId, revertedFromSection, revertedToSection}`. No descriptions, no names, no department text. Reasons live in encrypted `reason_ct`. Same priv-F2 invariant as 1.3 carries forward. | None material. |
| T-AI7 | Action Flag drift — a UI that computes the flag client-side disagrees with the server's canonical clock | The pure-function flag is computed server-side and returned in every list/detail projection. The web client renders the returned label/severity verbatim; it doesn't re-compute. Tests assert the flag matches the ARCHITECTURE.md §5 truth table for boundary inputs. | Client cache staleness across day boundaries — a list cached at 23:59 reads as < 21 days but the next morning is > 21. Acceptable; the rep refreshes. |
| T-AI8 | Polymorphic source FK (`source_type` + `source_id`) cannot be FK-enforced — an action item could link to a hazard id that doesn't exist | `'hazard'` source is enforced by the `action_items_source_fk_guard` trigger in migration 0005 (verifies the hazard row exists at INSERT/UPDATE). `'recommendation'` / `'inspection'` / `'incident'` are REJECTED at the route layer until their owning migration lands the equivalent trigger (sec-review F7 + priv-AI-F3 1.6 — fail-closed forward seam). `'manual'` and `'excel_import'` carry no referential integrity by design. | Race: hazard deleted between create-check and insert — bounded by `hazards.ON DELETE RESTRICT`. Acceptable. |
| T-AI9 | Closed action items leak management strategy when read across reps | Same scope as the rest of the encrypted surface — every authenticated rep sees the same data. Single-co-chair deployment makes this acceptable. The recommendation 1.9 flow will introduce a "draft" visibility tier; action items inherit the multi-rep forward seam from hazards T-H10. | Documented forward seam. |
| T-AI10 | Move-undo path used to whitewash an inconvenient move (mark it `undone`, hide from history view) | The undone flag does NOT delete or modify the original move row; it sets `undone=true` and writes a fresh REVERTING move row, both chain-anchored. The UI's default move history shows ALL rows including undone; the "hide undone" toggle is an explicit user choice. | UI policy; the chain holds the truth. Acceptable. |
| T-AI11 | KEK rotation while a move is in flight | Move writes never touch ciphertext of prior columns — they INSERT a new move row and (optionally) update `action_items.section` + `updated_at`. The 1.3 KEK rotation runbook (§3a) bounds in-flight encrypted writes. | Same as 1.3/1.5 KEK rotation; documented. |
| T-AI12 | Pre-1.10 `meeting_id` is nullable text with no FK — an item could pin a meeting id that never exists | Pre-1.10 the column accepts NULL or any uuid; route doesn't validate beyond format. The 1.10 meetings migration adds the FK as `ON UPDATE RESTRICT ON DELETE SET NULL` and includes a backfill check that flags orphans. | Documented integrity bound; the 1.10 migration is the close-out. |
| T-AI13 | `raised_by` / `follow_up_owner` external names are returned on `GET /:id` without a step-up gate (deliberate departure from 1.5 T-H4 reporter-identity pattern) | The hazards `reporter_identity` (1.5 T-H4) is the identity of a *worker who reported* a safety concern — high reprisal risk, low operational need to render on every detail view, so it sits behind a separate step-up route. Action items' `raised_by` / `follow_up_owner` are the minutes' **"Raised by"** and **"Follow-up owner"** columns — operational metadata that the JHSC team reads in every meeting agenda and exported PDF. Gating these behind step-up on every detail view would break the core minutes workflow. The fields stay envelope-encrypted at rest (T-AI1), are returned only to authenticated reps over HTTPS with `same-origin` credentials, and rendered in the web view with an "encrypted at rest" affordance (`apps/web/src/views/action-item-detail-view.tsx`). | Same scope as T-AI9 — multi-rep teams revisit when role separation lands. Acceptable. |

**Audit hooks for action-item changes.** Four event kinds — `action_item.created`, `action_item.updated`, `action_item.moved`, `action_item.move_undone` — added to `packages/shared-types` `AuditEventKind`. Move events are the operational heartbeat: under heavy traffic this is the largest single contributor to `audit_log` size. Payloads are tiny (≤4 fields each, no PI), so storage cost stays bounded.

**Close-out review findings (Milestone 1.6 slice 5).**

| Finding | Where landed |
|---|---|
| sec-F1 / priv-AI-F2 — `closedDate` PATCH writes bypassed the audit chain (HIGH) | `closed_date` added to `actionItemUpdateField` allow-list in `packages/shared-types/src/index.ts`. PATCH handler refactored so the SET-parts and the `changedFields` audit payload are built from the SAME table (`PATCH_TABLE` in `routes/action-items/index.ts`), preventing a future contributor from adding a column that bypasses the chain again. |
| sec-F2 — section move violated `(section, sequence_number)` UNIQUE index (HIGH, merge-blocker) | New `allocateSequenceNumber(tx, section)` helper used on every path that places an item into a section: create, move, and undo. Re-allocates the per-section "#" on move so an inbound item never collides with an existing item in the destination section. Matches the Excel workflow (a row moved between sheets gets that sheet's next row number). |
| sec-F3 — schema/audit drift seam (MED) | Closed by the `PATCH_TABLE` shape from sec-F1; new columns now require an entry in the single table or the typechecker fires. |
| sec-F4 — bodyLimit ordering let oversize POSTs bypass the rate-limit bucket (LOW) | Middleware re-ordered so `rateLimit` runs BEFORE `bodyLimit`. A spammed >64KB POST still drains the token bucket; the 413 follows. |
| sec-F5 — dead `escapedQ` (LOW) | Removed; the post-decrypt JS `.includes()` filter is escape-immune and the vestigial code is gone. |
| sec-F6 — `q` filter only matches the 80-char `safeSummary` (LOW, UX/spec) | Documented in the runbook as a known limitation; the API behavior matches ADR-0005's "ILIKE over a decrypted-then-trimmed description preview." No code change. |
| sec-F7 / priv-AI-F3 — T-AI8 overstated FK-validation for non-hazard sources (MED) | Route Zod schema now REJECTS `sourceType IN ('recommendation', 'inspection', 'incident')` until their owning migration lands the equivalent trigger. SECURITY.md T-AI8 row tightened to match the actual implementation (fail-closed). |
| priv-AI-F1 — `raised_by` / `follow_up_owner` return without step-up gate (drift from T-H4) | Deliberate departure documented as T-AI13: action items are minutes-sheet metadata, not reprisal-risk reporter identity. Rendered with "encrypted at rest" affordance. |
| priv-AI-F4 — `movedByUserId` UUID + sequence count oracle + dates-as-PI (info) | Documented as T-AI13 / T-AI9 residuals; forward-seam for multi-rep teams. |
| priv-AI-F5 — `docs/runbooks/action-items.md` missing (PIPEDA P9 procedure) | Runbook lands covering schema overview, sequence-number per-section semantics, withdraw / cancellation lifecycle, PIPEDA Principle 9 response procedure (refuse-or-redact based on activity + retention + named-individual paths), KEK rotation impact, and tamper response. |
| priv-AI-F6 — detail-view encryption affordance didn't cover `raised_by` (LOW) | Lock icon + "encrypted at rest" tag added next to the rendered Raised-by line in `apps/web/src/views/action-item-detail-view.tsx`. |

### 2.7 Evidence threats (Milestone 1.7)

Evidence files are the first surface that ships **client-side encryption** in production, and the first that uses object storage (Tigris). The browser holds the workplace **public** key (sealed-box recipient); the workplace **private** key stays sealed under the KEK in Fly Secrets, opened only when the server needs to decrypt for a authorized read. Every upload + read is chain-anchored.

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T-E1 | Tigris bucket compromise reveals ciphertext blobs and metadata | Files are XChaCha20-Poly1305-encrypted in the browser before upload. Per-file DEK is sealed for the workplace public key via `crypto_box_seal`; the server holds only the sealed DEK. Bucket holds opaque ciphertext + the 5-min presigned-URL ACL. | Even with bucket access, attacker needs (a) workplace private key (sealed under KEK in Fly Secrets) AND (b) chain-row metadata (`evidence_files.sealed_dek`). KEK rotation procedure documented. |
| T-E2 | Plaintext photo on the server during upload | Two-step upload: browser PUTs ciphertext directly to Tigris via presigned URL; the API never sees plaintext during upload. Server only receives metadata + sealed DEK in the `POST /api/evidence` finalize call. | None at upload time. **Decrypt path (T-E3)** is the documented exception. |
| T-E3 | Plaintext photo on the server during decrypt-and-read (`GET /api/evidence/:id/decrypt-url`) | Path A from ADR-0006: API opens sealed DEK with the workplace private key, decrypts the ciphertext, streams plaintext back. Plaintext is bounded to a single response lifetime; no caching, no logging. Step-up auth gates the call for evidence linked to worker-identity-bearing entities. | Acceptable for single-tenant scope; Path B (Cloudflare-Worker filter) deferred. Documented. |
| T-E4 | EXIF / camera-roll PI leaks via uploaded photos | Browser captures via `getUserMedia` → `<canvas>` re-encode → blob; the canvas re-encode path drops EXIF for fresh JPEG/PNG outputs. Camera roll is never read (capture happens in-page, not via `<input type="file" accept="image/*" capture>` which would route through OS picker). | iOS Safari HEIC re-encode has a known quirk where some EXIF survives the canvas round-trip; runbook flags this. A 1.12 hardening sweep verifies fresh-capture outputs are clean. |
| T-E5 | GPS precision becomes a worker-tracking surface | `gps_latitude` / `gps_longitude` capped at NUMERIC(8,4) — ~11m resolution. Sub-station precision is intentionally lost. | A determined rep can still cross-reference 11m precision against a known facility layout. Same scope as the rest of the data; single-co-chair tenant is the audience. |
| T-E6 | Polymorphic `(linked_type, linked_id)` accepts FKs that don't exist | Same fail-closed shape as 1.6 priv-AI-F3: route layer rejects `linked_type IN ('recommendation', 'inspection_finding', 'incident')` until their owning migrations ship. Only `'hazard'` and `'action_item'` are accepted in 1.7. Both have route-level existence checks. | Same forward seam as action items. Documented. |
| T-E7 | Audit chain emits PI via evidence payload | `evidence.uploaded` payload carries `{evidenceId, linkedType, linkedId, mimeType, byteSize, plaintextSha256}`. `plaintextSha256` is a one-way hash, not PI. No filename, no GPS, no caption. `evidence.read` is structurally identical without the hash. Same typed-payload invariant as 1.3 priv-F2. | None material. |
| T-E8 | Workplace key pair rotation invalidates all prior sealed DEKs | Pre-rotation procedure: run a one-shot script that opens each `evidence_files.sealed_dek` with the OLD workplace private key, re-seals under the NEW workplace public key, writes back. Script lands in 1.12 hardening; auth runbook §3a documents the prereq. **Until then, the workplace key pair is treated as a permanent identity.** | Operational; documented. |
| T-E9 | Presigned URL leak via referrer or browser history | Presigned PUT URLs carry a 5-min expiry. The browser issues the PUT via `fetch` — no referer header propagation, URL not added to history. If a URL is intercepted in-window the attacker has 5 min to PUT arbitrary content under the prearranged storage key; the finalize step will reject because `ciphertext_sha256` won't match what the legitimate browser computed. | 5-min window + SHA-256 verification at finalize. Acceptable. |
| T-E10 | Voice-to-text routes audio to a third-party service | Browser-native `SpeechRecognition` API only (CLAUDE.md non-negotiable #3). No fallback to a remote ASR. On browsers without the API the user sees a clear textarea + a "Voice not supported in this browser" hint — no third-party call ever fires. | None — implementation uses the native API or no API. |
| T-E11 | Evidence file is misfiled (linked to the wrong hazard/action item) | No DELETE endpoint. Misfilings are corrected via a future `evidence_redactions` table (1.12 hardening) that records the redaction + emits a chain anchor. Until then, the operator's option is to leave the misfiled evidence in place and add a note on the new linked entity. The chain row preserves the original linkage. | Documented operational limitation. The runbook covers the manual-note workaround. |
| T-E12 | Large file DoS — 50 MB cap is the only bound | Per-file `byte_size <= 50 * 1024 * 1024` at schema + bucket policy + Zod refinement. Per-IP rate-limit applies on `/api/evidence/upload-url` (same 60 burst / 10 rps shape as 1.5/1.6) so a malicious rep can't request a thousand presigns in a second. Tigris bucket has its own per-key quotas. | Single rep is the failure mode; rate limit is the bound. Acceptable. |

**Audit hooks for evidence.** Two new event kinds in `packages/shared-types` `AuditEventKind`: `evidence.uploaded` and `evidence.read`. Payloads stay PI-free; `plaintext_sha256` is the integrity anchor (one-way hash).

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
- **Log retention:**
  - **`audit_log` (tamper-evident chain):** rows retained **indefinitely** (the chain is the evidentiary record). The `ip` and `user_agent` columns redact to `NULL` at 1 year via the annual sweep + `audit.ip_redacted` chain anchor — see `.context/decisions.md` 2026-05-29 entry and `docs/runbooks/auth.md` §4a/§7. The redaction script lands in 1.12 hardening; until then, IP/UA persist for the full chain age (documented residual).
  - **`auth_events` (1.2 flat table):** read-only legacy preserved for hash-anchored reference from the 1.3 backfill anchor. Same retention posture as `audit_log`.
  - **`login_attempts` and `webauthn_challenges`:** operational; pruned by `auth-retention.ts` (2× hard-tier window for `login_attempts`, expires_at + 1h grace for `webauthn_challenges`).
  - **Application logs (Pino):** 90 days hot, 1 year cold per the pre-1.3 baseline.
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
