# Release 1 — Penetration Test Plan

Milestone 1.12 S4. Implements ADR-0011 §3.4.

This document is the **plan**, not the run. The OWASP ZAP scan and the
manual probes below run **post-merge** against a deployed staging
environment by a security tester or by the rep paired with a
contractor. The milestone artifact is this plan + the triage runbook;
the milestone acceptance gate does not depend on a clean scan report —
it depends on the plan existing and the rep's commitment in
`docs/release-1-security-pre-launch-checklist.md` §13.6 to run the
scan post-deploy.

Pen test must complete with **zero P0 findings** before production
deploy. P1 findings land as fixes within the 4–6 week real-world-use
window. P2 findings land in the post-Release-1 backlog.

Cross-references:

- ADR-0011 §3.4 — pen test plan shape.
- `SECURITY.md` §2.1..§2.12 — threats this plan exercises.
- `docs/release-1-security-pre-launch-checklist.md` §3 (auth), §4 (exports), §5 (privacy), §7 (Excel imports) — the static-verification surfaces this plan dynamically probes.
- `docs/release-1-deploy-runbook.md` §"Infrastructure provisioning" — staging deploy procedure.
- `docs/audits/release-1-pentest-findings.md` (NEW after first scan) — findings target file per §"Report format".

---

## 1. Scope

### In scope

- `apps/web` — the React PWA (`apps/web/dist/` static bundle + the
  vite-plugin-pwa-generated service worker, served from the
  `jhsc-worker-hub-web` Fly Machine OR from Tigris+CDN depending on
  the deploy choice per ADR-0011 §3.9).
- `apps/api` — the Hono + Bun API on the `jhsc-worker-hub-api` Fly
  Machine, every documented route under `/api/*` (auth, hazards,
  action-items, evidence, inspections, recommendations,
  excel-imports, sync, legal).
- `apps/ai-proxy` — the `jhsc-worker-hub-ai-proxy` Fly Machine. The
  proxy idles in Release 1 (no AI features ship) but the machine
  itself is reachable and has the same security-headers surface; it
  is in scope to confirm it cannot be coerced into proxying to
  Anthropic without an authenticated origin.

### Out of scope

- Neon Postgres infrastructure (managed SaaS — Neon's responsibility
  under their published SOC 2 / shared-responsibility model).
- Tigris bucket infrastructure (managed SaaS — same shape).
- Fly.io platform infrastructure (managed SaaS — same shape; the
  Fly-internal metadata service is in scope only as an SSRF target
  per §5, not as a platform-pen target).
- Browser-side JavaScript runtimes (Chromium, WebKit, Gecko — the
  vendors patch their own engines).
- DNS provider (the rep's domain registrar / DNS host — out of scope
  as a third-party SaaS).

A finding against an out-of-scope surface is escalated to the SaaS
provider via their published security-disclosure channel and recorded
in `docs/audits/release-1-pentest-findings.md` for traceability.

---

## 2. Test environment

The scan runs against a **staging deployment** that mirrors production
in every load-bearing dimension. Real worker data NEVER touches the
staging environment.

### Staging provisioning

- Same Fly region (`yyz`).
- Same Neon Postgres region (`ca-central-1`) — a forked branch from
  the production project so the schema and migrations match.
- Same Tigris region (`ca-central-1`) — separate buckets
  (`evidence-staging`, `exports-staging`) with the same SSE-AES256 +
  versioning settings.
- Same security headers (CSP, HSTS, X-Frame-Options, etc.) via the
  same `apps/api/src/middleware/security.ts` shipped in the deploy.
- Staging-only Fly Secrets — KEK, JWT signing keys, Tigris credentials
  generated fresh; values NEVER shared with production.
- Staging-only `WORKPLACE_DISPLAY_NAME` (e.g. `"Staging Workplace"`),
  staging-only `WORKPLACE_JURISDICTION`, staging-only `ZONE_N_NAME`
  values.

### Seed data

- A synthetic dataset seeded via the existing scripts:
  - `bun apps/api/scripts/seed-legal-corpus.ts` — the real legal corpus
    (the corpus is public reference material; no privacy concern).
  - `bun apps/api/scripts/seed-inspection-templates.ts` — seeded
    templates.
  - A throwaway first-run setup creating a synthetic rep account.
  - Hand-created hazards, action items, inspections, recommendations
    populated with `Lorem ipsum`-class strings — NO real worker names,
    NO real medical info, NO real witness statements.
- A small fixture-workbook seed for Excel-import probes — same
  synthetic shape as `packages/excel-import/src/fixtures/`.

### Credentials

- Staging rep credentials (password + TOTP) generated for the scan
  and rotated immediately after. The tester records the credentials
  in the scan log and revokes them via
  `bun apps/api/scripts/auth-unlock.ts` or by deleting the rep row
  after the scan completes.
- Passkey credentials are NOT scriptable from ZAP (the WebAuthn flow
  requires browser-level user verification); the password+TOTP
  fallback path is the universal scan path.

---

## 3. Authentication probes (SECURITY.md §2.1)

### 3.1 Passkey enrollment flow

Out of scope for automated ZAP scanning (browser-level WebAuthn).
Manual probe: attempt to enroll a passkey, intercept the WebAuthn
response with a proxying tool (e.g. Burp), modify the `credentialId`
to a value associated with a different account. **Expected:** the
server-side enrollment rejects the modified credential because the
challenge → credential binding is server-state.

### 3.2 TOTP brute-force rate-limit

Run a scripted TOTP guess against a known username at 10 guesses/sec
for 60 seconds. **Expected:** the lockout ladder
(`apps/api/src/auth/lockout.ts` — short 5/15min, long 10/1h, hard
20/24h, per env `AUTH_LOCKOUT_*`) trips at 5 failures; subsequent
guesses receive 429 `locked_out` with documented retry-after.

### 3.3 Step-up bypass attempts

Per ADR-0009 §3.6 + ADR-0010 §3.10, step-up tokens are bound to the
session and to a 60s freshness window, but the `action` field is
**cosmetic-only** in Release 1 (true per-action binding is on the
post-Release-1 backlog per ADR-0011 §"Out of scope"). The probe
confirms the 60s freshness is the real defense:

- (a) Trigger step-up for `evidence.decrypt`. Within 5 seconds,
  attempt `inspection.export`. **Expected:** the second action
  succeeds (cosmetic-only binding). **This is the known divergence
  documented in §3.8 of the security checklist.**
- (b) Trigger step-up for `evidence.decrypt`. Wait 61 seconds.
  Attempt the same `evidence.decrypt`. **Expected:** step-up modal
  fires again — the grant is stale.
- (c) Capture a step-up grant from session A; replay the request
  cookie in session B. **Expected:** the grant does not transfer
  (sessions are isolated; the grant lives in the session row).

A finding that the 60s freshness window is honored is OK. A finding
that the freshness window is NOT honored is P0.

### 3.4 Session JWT replay

- Capture a session JWT for user A from IP1. Replay against the same
  endpoint from IP2 (a different egress IP — use a VPN or a Fly
  Machine for IP variation). **Expected:** the session row's IP +
  User-Agent are stamped at issue (per ADR-0001); the replay either
  works (the IP stamping is informational, not enforced) OR is
  rejected. Either outcome is documented; the threat model entry
  T-A11 covers the documented stance.
- The IP/UA mismatch must emit an `auth.session_anomaly` audit row.
  **Expected:** chain row lands; verifiable via
  `SELECT * FROM audit_log WHERE kind = 'auth.session_anomaly' ORDER BY idx DESC LIMIT 1`.

### 3.5 Recovery-code reuse

- Use a recovery code to complete a step-up. **Expected:** the code
  is marked `used` in the `auth_recovery_codes` table and a second
  attempt with the same code fails with `recovery_code_already_used`.

---

## 4. Authorization probes (SECURITY.md §2.1, §2.4, §2.5)

Single-tenant scope means there is no second workplace to cross-access
into, but the IDOR + privilege-escalation probes verify the
defense-in-depth holds.

### 4.1 IDOR on every `/api/*` resource

- Authenticated as rep A, fetch a hazard A owns. Note the hazard ID.
- Sign out, create a second account (the staging environment's
  first-run setup allows this on a fresh staging DB), sign in as rep
  B. Attempt `GET /api/hazards/<rep-A-hazard-id>`. **Expected:** 403
  `forbidden` OR 404 (the application chooses — both are acceptable
  per OWASP IDOR guidance).
- Repeat for every resource type: action items, evidence files,
  inspections, recommendations, excel-imports, excel-import-items.

### 4.2 Cross-workplace data probe (defense-in-depth)

The app is single-tenant; the workplace identity is in env vars, not
in the data model. The probe confirms there is no
`workplace_id`-shaped column that could allow tenant confusion:

- Inspect the schema: `grep -rn "workplace_id\|tenantId" apps/api/src/db/schema.ts`.
- **Expected:** zero hits OR only the `workplace_keys` table (per
  ADR-0002 — the workplace keys are scoped to the single workplace).
  Any other `workplace_id` reference is a P0 finding (single-tenancy
  assumption violated).

### 4.3 Step-up TTL probe (cross-action)

Per §3.3(a), the cosmetic-only binding is documented divergence.
Confirm the 60s TTL is the load-bearing defense:

- Trigger step-up. Wait 50s. Attempt a step-up-gated action.
  **Expected:** succeeds (within freshness).
- Trigger step-up. Wait 70s. Attempt a step-up-gated action.
  **Expected:** fails with `step_up_required` (past freshness).

---

## 5. Injection probes (SECURITY.md §2.1, §2.4)

### 5.1 SQL injection on every input vector

ZAP active scan covers the GET-parameter + form-body cases; manual
augmentation covers the JSON-body + header cases:

- Every `POST /api/*` route — inject SQL-shaped payloads (`'`,
  `'; DROP TABLE users; --`, `1' OR '1'='1`, etc.) into every
  string-typed body field. **Expected:** Drizzle's parameterized
  queries reject the payload at the type-coerce step OR pass the
  literal string through to a column where it is stored as
  ciphertext or escaped text. No SQL syntax error responses.
- Every UUID-typed path parameter — inject `'; DROP TABLE users; --`
  in the position of a UUID. **Expected:** Hono's path-param
  validator rejects with 400 `invalid_uuid` before reaching the
  database.

### 5.2 SQL injection on the polymorphic FK trigger

Per ADR-0007 §3.7 + ADR-0008 §3.5, `action_items.linked_type +
linked_id` is enforced by a polymorphic FK trigger. The probe:

- `POST /api/action-items` with `linked_type = "inspection_finding"`
  and `linked_id = "00000000-0000-0000-0000-000000000000'; SELECT version(); --"`.
  **Expected:** the path-param validator OR the trigger rejects;
  Postgres does NOT execute the injection.
- Vary the `linked_type` value across `hazard`, `recommendation`,
  `inspection_finding`, and an invalid `xxx` value. **Expected:**
  invalid types reject with `invalid_linked_type`; the trigger does
  not table-scan for an attacker-controlled type.

### 5.3 XSS on every text-bearing field

Especially the action item description field (which carries PII per
CLAUDE.md "Encryption Rules"):

- For every text input — hazard description, action item description,
  inspection finding notes, recommendation body, Excel-import-item
  description — inject `<script>alert(1)</script>`, `<img src=x
onerror=alert(1)>`, `javascript:alert(1)`, and the standard XSS
  payload set (OWASP XSS Filter Evasion). **Expected:** the
  description is stored as encrypted ciphertext (per CLAUDE.md
  Encryption Rules); when rendered, React's default
  string-interpolation escaping renders the payload as inert text.
- Confirm no `dangerouslySetInnerHTML` in the rendering path:
  `grep -rn "dangerouslySetInnerHTML" apps/web/src/`. **Expected:**
  zero hits OR every hit is gated on a sanitizer + a CSP that would
  block inline scripts anyway.

### 5.4 NoSQL / command injection

The app does not use a NoSQL store, so the probe scope is small:

- Inject shell-metachar payloads (`$(whoami)`, `` `id` ``, `; ls`)
  into every string field that might end up in a shell command. The
  app has no `child_process` execution path in production (the
  Bun + Hono runtime executes the request handlers directly).
  **Expected:** payloads stored as inert strings.

### 5.5 JSON payload injection

- Submit a JSON body with `__proto__` polluted (e.g.
  `{"__proto__": {"isAdmin": true}}`) to every `POST /api/*`
  endpoint. **Expected:** Zod parses ignore non-schema keys (`strict`
  mode); the prototype is not polluted.
- Submit a deeply-nested JSON body (>100 levels) to confirm the
  parser does not stack-overflow. **Expected:** rejected at body
  size or depth limit.

### 5.6 Header injection

- Inject `\r\n`-shaped payloads into custom headers (`X-Requested-With`,
  `Idempotency-Key`, `If-Match`). **Expected:** Hono rejects malformed
  headers at parse time; no CRLF-injection / response-splitting.

---

## 6. Cryptographic probes (SECURITY.md §2.3, §2.7)

### 6.1 Sealed-box envelope confidentiality

- Capture a sealed-box ciphertext from an Excel import POST body.
- Attempt to open it without the workplace KEK. **Expected:** open
  fails (libsodium's `crypto_box_seal_open` requires the recipient's
  secret key; the public key alone is not sufficient).
- Attempt to open it with a freshly-generated random key.
  **Expected:** open fails.

### 6.2 Key id spoofing

- Submit a sealed-box payload with a `workplaceKeyId` referencing a
  different `workplace_keys.id` than the actual sealing key.
  **Expected:** `openExcelImportField` (`apps/api/src/excel-imports/crypto.ts`)
  attempts decryption with the wrong private key and fails; the
  finalize handler returns an error, no ciphertext is silently
  miscategorized.

### 6.3 Sealed-box replay across imports

Per T-X3 + T-X4, the parser worker is `worker.terminate()`'d after
each parse (per ADR-0010 §3.2). The probe confirms residual plaintext
does not survive:

- In a single browser tab: import workbook A, then import workbook B.
  Use DevTools to inspect the Worker pool between imports.
  **Expected:** the prior worker is gone before the new one spins up.

### 6.4 JWT signing-key probes

- Capture a session JWT. Modify the `kid` header to reference a
  different key id. **Expected:** the verifier rejects with
  `invalid_kid` if the kid does not resolve to a known public key;
  if the kid resolves but the signature is from a different key, the
  verifier rejects with `signature_mismatch`.
- Attempt the `alg: "none"` downgrade (modify the JWT header to
  `alg: "none"` and strip the signature). **Expected:** rejected.

### 6.5 Workplace public-key tampering (HSTS / cert pinning)

Per T-X33 + T-S26:

- The browser fetches the workplace public key from
  `/api/auth/session`. Attempt a MITM (a corporate proxy with a
  custom CA) to substitute the public key.
- **Expected:** HSTS prevents the protocol downgrade; the SPA's
  service worker (per ADR-0009) caches the key under integrity-checked
  storage so a one-shot substitution does not persist.

---

## 7. Audit chain probes (SECURITY.md §2.2; ADR-0011 §3.7)

### 7.1 Row tamper detection

- Directly modify a row in `audit_log` via `psql` against the staging
  DB: `UPDATE audit_log SET payload = jsonb_set(payload, '{kind}', '"tampered"') WHERE idx = 5;`.
- Run `bun apps/api/scripts/audit-log-verify.ts --full`.
  **Expected:** exit 1; the report's `firstDivergence` field points
  at idx=5 OR the first row whose `prev_hash` no longer matches the
  tampered row's recomputed `this_hash`.

### 7.2 Gap insertion

- Delete a row: `DELETE FROM audit_log WHERE idx = 7;` (the chain
  table has `ON DELETE RESTRICT` constraints, but Postgres superuser
  can override; the probe simulates a privileged-attacker scenario).
- Run `--full`. **Expected:** exit 1; the report's `gaps` array
  contains idx=7.

### 7.3 Backfill row substitution

- Modify the `audit.backfill.1_2_auth_events` payload at idx=1.
- Run `--check-backfill`. **Expected:** exit 1 with
  `rowsSha256_mismatch`. Per existing `apps/api/scripts/audit-log-verify.ts`
  semantics.

### 7.4 Backwards-time row insert (gap-2 substitute probe)

Per `docs/release-1-audit-verify-gaps.md` §"Gap 2", the per-actor
timestamp-monotonicity check is the gap-2 substitute. Probe:

- Insert a row with an artificially-old `ts` for an actor who
  already has later rows (must also pass the hash chain — non-trivial
  for an external attacker; the probe simulates a Postgres-superuser
  scenario).
- Run `--full`. **Expected:** the per-actor-timestamp check flags
  the row.

---

## 8. Excel import probes (SECURITY.md §2.11, §4)

### 8.1 Fuzz corpus replay against live parser

- Take any failing case from the fuzz harness
  (`packages/excel-import/src/__fuzz__/` or `packages/excel-import/test/fuzz/`)
  if present; otherwise generate a fresh case with the same
  deterministic seed.
- Upload via the staging app's Excel-import view.
  **Expected:** the parser returns
  `{kind: 'unrecognized', reason: ...}` OR `{kind: 'error', message: ...}`
  via the worker's structured-clone envelope; no uncaught throw; the
  upload view displays the error without partial-import side-effects.

### 8.2 Raw .xlsx server-upload probe

The non-negotiable #11 contract is that the raw workbook bytes never
reach the server. The probe attempts to bypass:

- Craft a `POST /api/excel-imports` request whose body contains the
  raw .xlsx bytes (not the sealed-box-encrypted field payload).
  **Expected:** 400 `invalid_body` (Zod schema validation rejects;
  the route does not accept binary bodies).
- Inspect the Hono route shape: `apps/api/src/routes/excel-imports/`.
  **Expected:** every route enforces a Zod-validated JSON body shape;
  no `application/octet-stream` content type accepted.

### 8.3 Formula-injection downstream

Per T-X5, the parser disables formula evaluation (`cellFormula: false`
in SheetJS opts per ADR-0010 §3.2). Probe:

- Upload a workbook with a cell containing
  `=HYPERLINK("http://attacker/", "click")`. Preview in the import
  view. **Expected:** the cell renders as the literal text
  `=HYPERLINK(...)`, not as a hyperlink. After commit, the action
  item description carries the literal text; a subsequent export
  PDF renders the literal text, not an active hyperlink.

### 8.4 Content-hash collision

Per T-X20 — computationally infeasible at SHA-256 but the probe
asserts the documented behavior on the structurally-impossible case:

- Manually create two workbooks where the `Description` + `Start
Date` fields are textually identical. Import workbook A; import
  workbook B. **Expected:** workbook B's reconciler treats the row
  as the same item (matching by content hash), surfaces it as
  `conflict_pending` if any other field differs, or `unchanged` if
  every field matches.

---

## 9. Headers / CSP probes (SECURITY.md §3)

### 9.1 securityheaders.com scan

Run `curl -sI https://<staging-host>/` and
`curl -sI https://api.<staging-host>/api/health` and compare against
the `apps/api/src/middleware/security.ts` shipped policy:

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (API).
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- `X-Frame-Options: DENY`.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer`.
- `Permissions-Policy: camera=(), microphone=(), geolocation=()` (or
  the exact directives shipped).

**Expected:** every header above is present on every API response
including 401, 403, 404, 5xx (Hono's `secureHeaders` middleware applies
unconditionally).

### 9.2 CSP nonce / inline-script check

The API serves no HTML, so the strict `default-src 'none'` holds for
the API. The web app's CSP is enforced by the static-serving layer
(Fly Machine or CDN); inspect `apps/web/dist/index.html` and the
delivered headers. **Expected:** no inline `<script>` blocks without a
nonce; if a nonce is used, the delivered CSP carries the matching
`script-src 'nonce-...'`.

### 9.3 HSTS preload eligibility

- Submit `<staging-host>` to https://hstspreload.org for eligibility
  check. **Expected:** eligible (max-age ≥ 31536000, includeSubDomains,
  preload). Actual submission is a deploy-step (see
  `docs/release-1-deploy-runbook.md` §"DNS + TLS"); the pen-test step
  is the eligibility scan.

### 9.4 Cookie attributes

- Sign in; inspect the `Set-Cookie` headers for the session cookie.
- **Expected:** `Secure`, `HttpOnly`, `SameSite=Strict`,
  `Path=/`. Inspect `apps/api/src/auth/cookies.ts` for the canonical
  shape.

---

## 10. Rate-limit probes (SECURITY.md §3, §2.1)

`apps/api/src/middleware/rate-limit.ts` is the canonical rate-limiter.
Confirm coverage:

### 10.1 Mutating endpoint coverage

- For every `POST`/`PATCH`/`DELETE` route (auth/signin, hazards,
  action-items, evidence/upload-presign, inspections/finalize,
  recommendations/submit, excel-imports/commit, sync/\*) — verify
  the route registers a rate-limit middleware. Inspect each route
  file under `apps/api/src/routes/`.

### 10.2 Sign-in flood

- Hammer `POST /api/auth/signin` at 100 req/sec for 60s.
  **Expected:** 429 after the rate-limit threshold; the lockout
  ladder also engages on per-account failed attempts.

### 10.3 Step-up flood

- Hammer `POST /api/auth/step-up` with valid session but invalid
  TOTP codes. **Expected:** 429 after the rate-limit threshold; the
  step-up attempts emit `auth.step_up_failed` audit rows.

### 10.4 Excel-import commit flood

- Attempt rapid `POST /api/excel-imports/commit` calls.
  **Expected:** rate-limited; idempotency-key middleware (per
  ADR-0009 + `apps/api/src/middleware/idempotency.ts`) catches replays.

---

## 11. SSRF / service-worker probes (SECURITY.md §2.7, §2.10)

### 11.1 Tigris presign SSRF

- Capture a Tigris presigned-URL request. Modify the bucket name or
  endpoint URL in any presign parameter that the request body carries.
- **Expected:** the presigner validates against
  `env.TIGRIS_BUCKET` and `env.TIGRIS_ENDPOINT` at sign time; an
  attacker-controlled bucket name is rejected.
- Attempt to coerce the presigner into signing a URL against the
  Fly Machine's internal metadata service (`http://_api.internal/`
  or similar). **Expected:** the AWS SDK signer signs only against
  the configured endpoint URL; the metadata service is not reachable
  via the presigner.

### 11.2 Service-worker scope abuse

Per T-S30:

- Register a competing service worker against a same-origin path
  (the staging hostname's `/attacker-sw.js` if such a path can be
  served — for the Fly Machine static serving this is gated by the
  file system, but the probe attempts the registration). **Expected:**
  the existing `/` scope service worker holds; a competing
  registration is either rejected or scoped to a sub-path that
  doesn't intercept the app's requests.

### 11.3 Idempotency-key replay across users

Per T-S4 + T-X31:

- Capture an Idempotency-Key from rep A's session. Replay the same
  request with the same Idempotency-Key in rep B's session.
  **Expected:** the cache key is `(idempotency_key, user_id)`; the
  request is treated as fresh in rep B's session.

---

## 12. Report format

Findings export to `docs/audits/release-1-pentest-findings.md` (NEW
file at first scan; appended to on subsequent scans). Each finding
is a row in the following shape:

```
### Finding F-<scan-date>-<seq> — <one-line title>

**Severity:** P0 / P1 / P2
**CVSS v3.1:** <score> (<vector>)
**Surface:** <path or component>
**Threat model entry:** <T-#> (new entry if novel)
**Repro steps:**
1. ...
2. ...
**Expected behavior:** ...
**Observed behavior:** ...
**Recommended fix:** ...
**Status:** Open / In progress / Fixed in <commit-sha> / Triaged-out as false positive
```

### Severity definitions

- **P0 — block release.** Direct compromise of worker data
  confidentiality, integrity of the audit chain, or authentication
  bypass. Examples: SQL injection that exfiltrates rows, sealed-box
  envelope opening without KEK, step-up bypass that grants exports
  without a fresh factor, audit-row tamper that `--full` does not
  detect.
- **P1 — fix within the 4–6 week real-world-use window.** Significant
  defense-in-depth weakening but no direct compromise demonstrated.
  Examples: a missing rate-limit on a mutating route, a CSP weaker
  than the documented policy, a service-worker scope edge case.
- **P2 — backlog (post-Release-1 hardening).** Minor finding, often
  duplicating an already-documented residual or an
  out-of-scope-but-noted item.

### Triage runbook

1. Each finding triages against the threat model. If the finding
   maps to an existing T-# entry: confirm the documented mitigation
   is supposed to hold, then investigate whether the mitigation
   regressed. If a regression: the finding is at minimum P1.
2. If the finding is novel: open a new T-# entry in `SECURITY.md`
   §2.x (the appropriate section) with the threat description,
   mitigation, and residual posture.
3. False positives are documented in the findings file with the
   reasoning, NOT silently triaged out. Common false-positive
   patterns: HSTS-on-staging (the staging hostname is not preloaded),
   the health endpoint's intentional no-cache headers, the SPA's
   `/index.html` served for unknown routes (catch-all for
   client-side routing).
4. HIGH + CRITICAL findings block deploy. The rep does NOT deploy
   while any P0 is open.
5. The first scan's findings are committed; subsequent scans
   (quarterly per `SECURITY.md` §9) append to the same file with a
   date-stamped scan header.

---

## 13. Honest divergences

The plan honestly documents the bounds:

- **Operator-run, not CI-run.** Per ADR-0011 §3.4. A rep without
  security expertise will produce noisier results than a contractor;
  the triage runbook absorbs that.
- **Staging-mirror drift.** Per T-HD15 — staging may drift from
  production over time; the deploy runbook's quarterly re-validation
  cadence covers it.
- **WebAuthn flow unscripted.** The passkey path is manually probed
  only; ZAP cannot script the user-verification ceremony.
- **AI proxy idles in Release 1.** The proxy machine is reachable
  but proxies nothing; the probe confirms it cannot be coerced into
  proxying without an authenticated origin, but the proxy's
  Anthropic-bound surface is not exercised because no AI feature
  ships.
- **Cosmetic-only step-up action binding is known divergence.** Per
  ADR-0009 §3.6, true per-action binding is post-Release-1 backlog.
  A finding that the action label is decorative is documented, not
  a P0.

Pen test must complete with **zero P0 findings** before production
deploy.
