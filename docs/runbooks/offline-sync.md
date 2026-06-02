# Offline Sync Operations

Operator runbook for the Offline-First Sync surface shipped in
Milestone 1.10. Pairs with ADR-0009 and SECURITY.md §2.10. Cross-
references `docs/runbooks/auth.md` (session revoke for the lost-device
scenario), `docs/runbooks/hazards.md` / `action-items.md` /
`inspections.md` / `recommendations.md` / `evidence.md` (the five prior
milestones whose POST + PATCH routes the 1.10 ratchet wires offline-
queueable), and `docs/runbooks/legal-corpus.md` (the corpus snapshot
the SW caches so offline citation picking works on first try).

The 1.10 surface is the first surface that moves data through THREE
trust zones in one logical write: the rep's untrusted-at-rest IndexedDB
on a phone that can be lost / stolen / seized; the `sync_queue`
envelope that crosses the network when the bar returns; and the server-
side `sync_idempotency` ledger + chain anchor that lands at queue-drain
time, NOT at type-time. Most of this runbook is about explaining that
shift to the rep, their counsel, and the next operator.

---

## 1. Schema overview

**Server side (migration 0009):**

| Object                   | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_idempotency`       | Replay-dedup ledger. Cache key is `(actor_user_id, action_kind, entity_local_id, payload_hash)` — two partial UNIQUE indexes split the NOT NULL / NULL entity_local_id cases (since PostgreSQL UNIQUE treats NULLs as distinct). Response body is envelope-encrypted at rest under the master KEK (T-S15: no `Set-Cookie` cached; T-S11 cross-actor cache miss). 7-day TTL; sweep job is 1.12 (`pg-boss` hourly DELETE `expires_at < now() - interval '1 day'`); the table grows monotonically through 1.10 (T-S6 documented residual). 5xx NOT cached; 409 IS cached (deterministic conflict). |
| Per-entity `version`     | Integer NOT NULL DEFAULT 1 on the FIVE mutable tables: `hazards`, `action_items`, `inspections`, `inspection_findings`, `recommendations`. Append-only tables (`action_item_moves`, `inspection_signatures`, `recommendation_citations`, `recommendation_responses`, `evidence_files`, `recommendation_action_item_links`, `audit_log`, `inspection_templates`, `legal_clauses`, `export_records`) do NOT get a version column — they can't be UPDATEd, so optimistic concurrency has no surface.                                                                                               |
| `bump_version_on_update` | BEFORE UPDATE trigger on each of the five mutable tables. The `IF NEW.version = OLD.version` conditional lets the route set `version = OLD.version + 1` explicitly without double-bumping (the canonical optimistic-concurrency pattern). Tests / manual SQL that forget the explicit write still get the auto-bump.                                                                                                                                                                                                                                                                            |

**Client side (Dexie schema version 1):**

Thirteen tables — eleven mutable-entity tables plus two read-only
caches (`inspection_templates`, `legal_clauses`) plus three plumbing
tables (`sync_queue`, `sync_conflicts`, `_base_state`). Every mutable-
entity row carries six synthetic `_sync_` columns:

| Column               | Shape                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_sync_state`        | `clean` / `dirty_create` / `dirty_update` / `dirty_delete` / `conflicting`. The sync-status chip counts non-clean rows across every mutable table; this is the green-amber-red signal the rep sees.                   |
| `_local_id`          | UUID v4 generated client-side at create time (ClientId). Used as Dexie PK AND as the URL slug. Server's clientId ratchet INSERTs with id=clientId so the rep's offline URL is canonical from the moment they typed.   |
| `_server_version`    | The server's `version` integer at last successful sync. Sent as `If-Match: "<integer>"` on every PATCH. 0 until the first server response confirms the row (sec-F7 close-out ensures POST responses include version). |
| `_base_state_json`   | Canonical-JSON snapshot of the server's last-known full row. The three-way merge UI diffs local-vs-base and server-vs-base to surface only the actually-changed fields.                                               |
| `_updated_at_client` | ISO timestamp of the last local mutation. The rep's device clock — NOT canonical evidence; the chain anchor uses server `now()` at drain time (see §10).                                                              |
| `_synced_at`         | ISO timestamp of the last successful sync. null until the first server ack.                                                                                                                                           |

**Workplace key cache tables** (`workplace_keys_cache`,
`workplace_signing_keys_cache`) were declared in the original S2 schema
but never populated by any code path; they were reserved for the at-
rest envelope-encrypted Dexie design that priv-F1 describes as
deferred. The S5 fix bundle removed them to avoid leaving misleading
dead code on the device; the 1.12 hardening bump will re-introduce
them with the actual populate path.

---

## 2. The optimistic write flow

Rep types into a form → the per-domain typed-client wrapper
(`apps/web/src/sync/typed-client.ts`, the `syncify` function) routes
the call through:

1. **Mutation classification.** `kind: 'mutation'` in the routes map
   means optimistic-write + queue. `kind: 'read'` is snapshot-from-
   Dexie + background-refresh. `kind: 'require_online'` is live-fetch
   passthrough that throws `NetworkRequiredError` when offline.
2. **clientId allocation.** For `opKind: 'create'`, the wrapper
   generates a UUID v4 via `crypto.randomUUID()` and injects it as
   `body.clientId` so the server's clientId ratchet honors the
   client-allocated id.
3. **Optimistic row write.** A row with `_sync_state = 'dirty_create'`
   (or `dirty_update`) is `put()` into the per-entity Dexie table.
   sec-F10 close-out (T-S57): if a CLEAN row already exists at the
   clientId, the wrapper SKIPS the write (and the queue enqueue) and
   returns the existing row to preserve a background-refresh that
   landed the canonical row between the rep's tap and the optimistic
   commit.
4. **Queue row append.** `enqueueOp()` (`queue-worker.ts`) writes a
   `sync_queue` row carrying the JSON-stringified body, the HTTP
   method + endpoint, the captured `If-Match` etag, and a per-request
   Idempotency-Key (fresh UUID v4).
5. **Drain.** The queue worker singleton (one per tab via
   `navigator.locks` leader election with a heartbeat-table
   fallback) polls every 30s + on visibility-change + on a
   successful drain. The dispatcher (`typed-client.dispatchOp`)
   makes the actual HTTP call; the response classifies as
   success / conflict / network_required / transient_failure /
   dead_letter and updates the queue row accordingly.

The rep's UI shows the optimistic row immediately; the chain anchor
fires server-side at drain time. The semantic shift this implies is
covered in §10.

---

## 3. Idempotency contract

The `Idempotency-Key` middleware (`apps/api/src/middleware/idempotency.ts`)
wires AFTER `csrfHeaderGuard()` + `authMiddleware()` (so the cache key
can use `auth.userId`) and BEFORE `rateLimit()` + `bodyLimit()` (so a
cache hit short-circuits without burning rate-limit tokens or body-
limit budget). The exact order is documented in the middleware header
comment + SECURITY.md §2.10 T-S5.

**Contract:**

- **GET / HEAD / OPTIONS:** pass-through. Reads are not cached.
- **No `Idempotency-Key` header:** pass-through. Idempotency is opt-in
  per request; the web client sets it on every mutation flowing through
  the queue worker.
- **Cache HIT (matching row, expires_at > now()):** return the cached
  status + decrypted body + `X-Idempotent-Replay: true` header. Handler
  is NOT run. Chain anchor is NOT re-emitted.
- **Cache MISS:** handler runs. 2xx + 409 responses are cached
  (deterministic). 5xx is NOT cached (retry-safe — the rep may retry
  after a transient server fault). 4xx other than 409 (400 invalid_body,
  401 step-up, 403 csrf, 422 illegal_transition) is NOT cached — the
  rep may correct the request.

**Rep-facing implication:** two clicks of "Submit" within 7 days
produce ONE server-side change. The rep should NOT panic-retry; the
queue worker handles it automatically.

**sec-F2 close-out (T-S52):** the cache-INSERT in the after-handler
block logs at warn level on failure (was previously silently
swallowed). A failed cache-INSERT means a retry of the same key
re-runs the handler; the chain-anchor double-emit concern is bounded
by the entity-table UNIQUE on every chain-anchored route
(`evidence_files.storage_key + plaintext_sha256` content-address,
`action_item_moves` audit_idx UNIQUE, `recommendation_number` per-
jurisdiction sequence, `inspection_signatures(inspection_id, role)`
UNIQUE, etc.). The retry hits the entity-table UNIQUE first and the
route maps the collision to its clientId-reuse 200 — same shape as
the cache hit would have produced. The warn log is the operational
signal that the dedupe window degraded.

---

## 4. Sync queue + lost-device threat model (priv-F1 close-out)

**The rep's `sync_queue.payload` carries plaintext rep-typed PI until
the queue drains.** This is the priv-F1 critical close-out: the
original 1.10 plan was client-side envelope-encryption under the
workplace public key (mirroring the server's seal shape so a forensic
dump yields only ciphertext). Landing that plan would have required
refactoring every prior milestone's wire format to accept ciphertext
on the input side — massive blast radius across 1.5–1.9. Per the
user-authorized scope decision, the 1.12 hardening backlog absorbs
the structural fix (see §12).

**What's in plaintext on the device until sync:**

- `sync_queue.payload` JSON column carries hazard descriptions,
  reporter identities, location detail, action item descriptions,
  recommended actions, raised-by, follow-up owner, recommendation
  titles + bodies, inspection observations, corrective actions,
  responsible party text, signature notes.
- Optimistic entity row fields mirror the server's projection +
  carry rep-typed text in the unsealed columns (`HazardRow.title`,
  `RecommendationRow.hasTitle / hasBody` booleans — booleans are
  metadata; the actual rep-typed body lives in `sync_queue.payload`).
- `evidence_pending_uploads._local_ciphertext_b64` IS envelope-
  encrypted under the workplace public key at capture time (1.7
  sealed-box pattern); evidence captures are SAFER on the device
  than rep-typed drafts.

**Threat:** a worker rep's lost / stolen / seized phone leaks every
drafted-but-not-synced hazard description, witness narrative,
recommendation body, and inspection-finding observation in cleartext.
PIPEDA P4 (limit collection) + P7 (safeguards) are both stretched by
the gap.

**Operational mitigation:** revoke-the-session (see §11) is the
immediate response. The 1.12 hardening covers the structural fix:
WebAuthn PRF / session-derived Dexie at-rest encryption that wraps
the entire database transparently without changing wire formats.

The rep is informed of this gap via:

- SECURITY.md §2.10 T-S1 + T-S2 mitigation text (honest stance).
- ADR-0009 §3.1 (on-disk encryption posture).
- `apps/web/src/sync/db.ts` file-header comment.
- This runbook section.
- The 1.12 backlog enumeration in §12.

---

## 5. Backoff curve + dead-letter

The dispatcher's response classification feeds into `computeNextBackoff()`
(`packages/shared-types/src/index.ts`), which advances the queue row's
`nextAttemptAt`:

| Attempt | Delay                                                                                     |
| ------- | ----------------------------------------------------------------------------------------- |
| 1       | 1s                                                                                        |
| 2       | 5s                                                                                        |
| 3       | 30s                                                                                       |
| 4       | 5min                                                                                      |
| 5       | 30min                                                                                     |
| 6       | 2h                                                                                        |
| 7       | 12h                                                                                       |
| 8       | 24h                                                                                       |
| 9+      | DEAD-LETTER (state = `failed_dead_letter`; ~48h total before the row stops auto-retrying) |

The rep sees a dead-letter row in the sync panel with the server's
last error message + a Retry / Discard pair of actions. **The rep is
the authority on recovery — the app does not auto-decide.**

Common error codes + the operator-side recovery shape are documented
per-route in the prior runbooks (hazards.md, action-items.md,
inspections.md, recommendations.md, evidence.md). For the 1.10-specific
shape:

- `409 client_id_conflict` (cross-actor clientId reuse) — the rep
  cannot resolve via the queue; the operator regenerates the row's
  clientId via the dead-letter UI's "regenerate id" action.
- `428 precondition_required` (missing or invalid `If-Match`) —
  symptomatic of a bug in the typed-client wrapper. The S5 fix bundle
  closes the version=0 path (LOW close-out, see §6).
- `503 network_required` (synthetic from the SW) — the rep is offline
  on a require-online route. The queue worker pauses + the chip turns
  amber; the rep returns online and the drain resumes.

---

## 6. If-Match etag conflict surface

Every PATCH on a mutable entity table compares the client's
`If-Match: "<integer>"` header against the row's current `version`
column under FOR UPDATE. The handler:

- Returns `428 precondition_required` if the header is missing /
  invalid / `If-Match: "0"` (the post-S5 parser rejects version=0
  per the LOW close-out — see `apps/api/src/middleware/if-match.ts`
  doc comment).
- Returns `409 version_conflict` with `currentVersion` +
  `serverState` if the header value doesn't match the server's
  current version. The client's queue worker writes a
  `sync_conflicts` row + flips `_sync_state = 'conflicting'`; the
  amber sync-status chip surfaces the conflict for manual
  resolution.
- Returns `200` + bumps `version` on success. The migration's
  `bump_version_on_update()` trigger noops when the route writes
  `version = OLD.version + 1` explicitly (the canonical optimistic-
  concurrency pattern).

**sec-F7 close-out (T-S55):** every POST create handler now includes
`version: 1` in the response body so the typed-client's
`extractVersion(body)` populates `_server_version=1` on the optimistic
row. Without this, the row's `_server_version=0` and the next PATCH
ships `If-Match: "0"` — which the post-S5 parser rejects with 428.
The full set of fixed handlers: `POST /api/hazards`,
`POST /api/action-items`, `POST /api/inspections`,
`POST /api/inspections/:id/findings`, `POST /api/recommendations`
(plus the clientId-reuse 200 paths on each, which re-query the
current version so a two-device race doesn't trip the 409).

---

## 7. Conflict resolution stance (priv-F4 + sec-F3 + sec-F4 close-out)

**The Apply pipeline ships in 1.12.** Per the S5 user-authorized
scope decision, the 1.10 conflict resolution dialog ships VIEW-ONLY:

- The three-way merge columns (Yours / Theirs / Base) render so the
  rep can compare plaintext metadata fields side-by-side.
- Encrypted-field rows render an honest placeholder: "Encrypted. The
  Apply pipeline ships in 1.12. To compare encrypted bodies in 1.10,
  contact your operator." No Reveal button (no step-up dispatch for
  a no-op).
- The Apply button is DISABLED with the label `Apply (1.12)`.
- An operator-script notice in the dialog points the rep at this
  runbook section.

**Why the Apply pipeline was deferred:**

- **sec-F3:** the S2 `defaultEndpointForKind` map shipped requests
  to endpoints that don't exist server-side (action_item_move →
  /move vs the server's /moves; finding_promotion → /findings/:id
  vs /promote; evidence_finalize → /finalize vs /; the synthesized
  `${endpoint}/withdraw-duplicate` didn't exist anywhere). Every
  resolution attempt 404'd / 405'd and dead-lettered after 8
  retries.
- **sec-F4:** the keep*local / manual_merge paths shipped the raw
  local Dexie row (carrying `\_sync*\*`metadata + id + version +
createdAt + updatedAt) as the PATCH body. Every server route
uses`.strict()` Zod schemas — every resolution PATCH 400'd
  invalid_body and dead-lettered.
- **priv-F4:** the encrypted-field Reveal dispatched step-up but
  never fetched plaintext; the rep made evidentiary decisions
  against unreadable placeholders. Burning a step-up grant on a
  non-functional affordance violates the spirit of CLAUDE.md #16.

**Operator-side conflict resolution procedure (1.10):**

For a single conflict the operator has access to the database directly
(single-tenant, single-co-chair). The shape:

1. **Identify the conflict.** Inspect the Dexie `sync_conflicts`
   table on the rep's device (the rep can read out the `entityKind`
   - `entityLocalId` + `serverVersion` from the dialog). Match
     against the server's `sync_idempotency` ledger if the conflict
     was triggered by a queued retry.
2. **Inspect both states.** The dialog renders the local + server
   metadata; for encrypted bodies the operator uses the existing
   reveal endpoints (with the operator's step-up factors) to read
   plaintext on the server side.
3. **Decide canonical.** Walk the legal frame — for chain-anchored
   events (recommendation submit, inspection signature, action-item
   move) both chain rows are evidentially valid; the operator's
   decision is about which body the future arbitration record
   should anchor on.
4. **Apply server-side.** UPDATE the server row directly with the
   chosen body + bump `version` explicitly. Emit an
   `audit.operator.conflict_resolution` chain row (out of band) so
   the chain captures the operator's intervention. The 1.12 Apply
   pipeline will land a proper kind for this.
5. **Clear the client.** Walk the rep through deleting the
   `sync_conflicts` row + the conflicting `sync_queue` row from
   Dexie via the browser dev tools (Application → IndexedDB →
   `jhsc-offline-sync`). The rep then taps refresh; the
   background-refresh path absorbs the new server state into the
   `clean` row.

This is operator-heavy on purpose — every 1.10 conflict in single-co-
chair single-tenant scope is rare enough that operator intervention
is the right shape. The 1.12 hardening delivers the in-app Apply
pipeline so the rep can self-serve.

**Resolution script template:** a per-entity-kind script that takes
`(entity_kind, entity_local_id, server_version, canonical_payload)`
and emits the right UPDATE + chain anchor + cache invalidation —
**lands in 1.12 alongside the Apply pipeline**. Stub for the 1.12
implementer:

```bash
# scripts/resolve-sync-conflict.ts (1.12)
# Usage: bun scripts/resolve-sync-conflict.ts \
#   --entity hazard \
#   --id 1234abcd-... \
#   --canonical local|server|merged \
#   --merged-payload '{"description": "..."}' \
#   --actor-user-id <operator-uuid>
```

---

## 8. Service worker scope + cache strategy

**Precache:** app shell (HTML/JS/CSS) via the workbox manifest +
Lucide icons + Source Serif 4 / Inter / JetBrains Mono fonts. Cache
names: `jhsc-lucide-v1`, `jhsc-fonts-v1`,
`workbox-precache-v2-${scope}`. Cleaned on activate.

**Runtime cache:** `/api/*` reads go through `NetworkFirst` with
`CacheableResponsePlugin({ statuses: [200] })` in `jhsc-api-reads-v1`
— UNLESS the URL matches `REQUIRE_ONLINE_PATTERNS`.

**Require-online allow-list (sec-F1 close-out, T-S51):** the check now
runs OUTSIDE the `if(isMutation)` branch so every reveal / export /
download GET is network-only with synthetic 503 on offline. The full
list:

- Reveals: `/api/hazards/:id/reporter`, `/api/inspections/findings/:id`,
  `/api/recommendations/:id/reveal`, `/api/evidence/:id/decrypt`.
- Exports + downloads: `/api/recommendations/:id/exports`,
  `/api/recommendations/exports/:id/download`,
  `/api/inspections/:id/exports`,
  `/api/inspections/exports/:id/download`,
  `/api/inspections/exports/batch`.
- Auth lifecycle: `/api/auth/step-up/*`, `/api/auth/first-run/*`,
  `/api/auth/login/*`, `/api/auth/password/*`,
  `/api/auth/passkey/*`, `/api/auth/totp/*`,
  `/api/auth/refresh`, `/api/auth/logout`.

The S2 path routed those GETs through NetworkFirst; workbox's
`CacheableResponsePlugin` ignores `Cache-Control: no-store`, so a
once-successful reveal lived in `jhsc-api-reads-v1` indefinitely and
served the cached plaintext on offline re-request without firing a
fresh step-up check or a new chain anchor. The S5 fix closes this
hole and preserves CLAUDE.md #2 + #16.

**Tigris cross-origin PUTs** are NOT intercepted — the SW returns
early at `req.url.startsWith(self.location.origin)`.

**Mutations elsewhere** (POST/PATCH/DELETE/PUT to non-require-online
paths): try the network with a 5s timeout. On failure, `postMessage`
the foreground (so the queue worker can pick it up) and return a
synthetic 202 `{ ok: false, queued: true }` with
`X-Synthetic-Origin: service-worker`. The typed client treats this
202 as "queued, not committed."

**Bundle update posture:** `vite-plugin-pwa` `registerType: 'autoUpdate'`
shows a soft-update banner on next visit. We do NOT call `skipWaiting`
in the install handler — the controller is never swapped mid-session.

**Legal corpus + session pre-warm:** the SW currently caches
opportunistically on first online fetch. The 1.12 hardening covers a
proper after-login warm event so a fresh device that goes offline
immediately still has the corpus + session payload (deferred per
sec-F13 LOW; see §12).

---

## 9. PWA install prompt

**Android (Chrome / Edge):** the `beforeinstallprompt` event fires;
the app stores it and surfaces a small "Install" affordance gated on
(`sessionCount ≥ 3` OR `evidenceCount ≥ 1`) AND not-installed AND
not-dismissed. Tapping the affordance calls `event.prompt()` which
triggers the native browser dialog (unspoofable from page content).

**iOS Safari:** there's no programmatic install API. The app surfaces
an instruction modal that directs the rep to the native Share sheet →
Add to Home Screen flow. No fake "Install" button.

**Dismissed state:** `localStorage.jhsc.pwaInstallDismissed`. Soft
dismiss (X on the banner) re-prompts after the next session-count
threshold; hard dismiss (Never) suppresses indefinitely.

**iOS standalone-mode permission scope caveat (priv-F5):** PWA install
on iOS shifts camera / microphone / geolocation permission scope from
"Safari-wide" to "per-PWA app". A rep who grants camera in the
installed PWA does not affect Safari, and revoking via Safari does not
revoke the PWA grant. The instructional modal mentions this. Operator
recovery shape: rep navigates to Settings → JHSC Worker Hub → revoke
the permission directly.

---

## 10. Chain anchor timestamp semantics

**`ts_ms` records when the server received the operation, NOT when
the rep typed it.** This is the most consequential semantic shift in
1.10. For online operations (the overwhelming majority at single-co-
chair scope) the two timestamps differ by milliseconds — the existing
arbitration framing holds. For offline-then-drained operations the
divergence can be hours or days.

**Two timestamps in evidence:**

1. **Chain `ts_ms` (canonical):** server `now()` at drain time. This
   is the evidentiary record. Tamper-evident via the hash chain.
2. **Device queue-typed-at (corroborating):** the rep's
   `sync_queue.created_at` (device clock at enqueue time). This is
   rep-facing UI only — NOT chain-anchored, NOT cryptographically
   bound to the server's view of time.

**Arbitration framing for the rep + their counsel:**

> "The chain proves that the server received this operation at time T.
> The rep typed it at time T'. Both are true. The chain is the
> canonical evidentiary surface; the device's queue-typed-at is the
> rep's record. The runbook documents this contract — it is the
> intentional shape of an offline-first system, not a timestamp
> contradiction."

**Two specific kinds carry rep-facing legal weight that pivots on the
new semantics:**

- **`recommendation.submitted`** — the 21-day s.9(21) clock measures
  from chain `ts_ms` (server `submitted_at`), NOT from queue-typed-at,
  per ADR-0009 §3.12. `computeRecommendationDeadline` (pure function
  in `packages/shared-types`) consumes the server timestamp only.
  The rep-facing UI surfaces `OfflineSubmitClockNotice` (defined in
  `recommendation-detail-view.tsx`) when a submit op is enqueued.
- **`inspection.signed`** — same shape. priv-F3 close-out (T-S54)
  adds `OfflineSignatureTimestampNotice` (defined in
  `inspection-signature-sheet.tsx`) that renders when a
  `inspection_signature` op is queued for the current inspection.
  Copy: "This signature will be recorded on the server when you're
  back online. The chain of custody timestamp will be the SERVER's
  receive time, NOT the moment you signed. For arbitration, your
  device's clock-time is your record; the chain proves server-
  receipt."

The rep needs to know this BEFORE they ship the offline op so they
can sync sooner if the timestamp matters. The UI surfaces both
notices in-flow; this runbook is the arbitration-side resource.

---

## 11. Lost or stolen device

**Immediate response (priv-F1 close-out, priv-F12 close-out):**

1. **Log in from another device + revoke all sessions.** Navigate to
   the security view → "Revoke all sessions". This invalidates the
   stolen device's auth cookie + clears step-up freshness on every
   session. Cross-ref `docs/runbooks/auth.md` for the session-revoke
   mechanics.
2. **Change password / re-enroll passkey** from the new device. This
   forces any cached credential on the stolen device to fail on its
   next attempt.
3. **Inventory what was on the device.** Per the priv-F1 close-out
   (§4), the stolen device may have leaked plaintext drafts. Treat
   any draft on the lost device as if the contents were observed by
   an attacker:
   - hazard descriptions, reporter identities, location detail
   - action item descriptions, recommended actions, raised-by names,
     follow-up owner names
   - recommendation titles + bodies
   - inspection observations, corrective actions, responsible party
     text, signature notes
   - any evidence captured but not yet drained (`evidence_pending_
uploads._local_ciphertext_b64` IS sealed under the workplace
     public key so the device can't decrypt — same posture as a
     Tigris compromise per 1.7 T-E1)
4. **PIPEDA P10 self-notification.** If the lost data fits the "real
   risk of significant harm" threshold (PIPEDA Personal Information
   Protection and Electronic Documents Act, breach reporting since
   2018), the rep may have a personal reporting obligation to the
   Office of the Privacy Commissioner of Canada. The workplace's
   privacy officer is presumably the EMPLOYER; for reprisal-
   sensitive data the rep may not want to file through the employer.
   Consult counsel.
5. **For arbitration purposes,** the chain has no record of edits
   that never synced. Note the absence in the incident timeline — a
   missing chain row is itself evidence (it proves the operation
   never reached the canonical record).

**What the attacker CANNOT do:**

- Step up for fresh reveals — step-up freshness expires + the
  step-up flow is require-online, the SW returns 503 offline.
- Decrypt the workplace public key — it's on the server in Fly
  Secrets.
- Tamper with the chain — the audit log is hash-chained + the
  workplace signing key lives server-side.
- Submit queued ops after session revoke — the auth cookie is
  invalidated; every drain attempt 401s, the queue worker pauses,
  the rep can't fix without re-auth (which they can't do without
  the new factors).

---

## 12. 1.12 hardening backlog

The S5 fix bundle closes 23 of the 26 reviewer findings. Three
deferred items live here (per user authorization):

1. **Dexie at-rest encryption (priv-F1):** WebAuthn PRF or session-
   derived Dexie key that wraps the entire database transparently
   without changing wire formats. This is the structural fix for the
   plaintext-in-Dexie residual. Owner: 1.12 lead.
2. **Conflict resolution Apply pipeline (priv-F4 + sec-F3 + sec-F4):**
   correct endpoint mapping per entity kind, strip `_sync_*` metadata
   before PATCH, wire encrypted-field decrypt via the existing reveal
   endpoints with step-up, full integration test against every chain-
   anchored variant (chain-anchored = recommendation submit,
   inspection signature, action-item move). Owner: 1.12 lead.
3. **Conflict resolution operator script template:** `scripts/
resolve-sync-conflict.ts` that takes
   `(entity_kind, entity_local_id, server_version, canonical_payload)`
   and emits the right UPDATE + chain anchor + cache invalidation.
   Per-entity-kind shape variants. Owner: 1.12 lead.

Additional 1.12 items the S5 review surfaced (out of scope for the
S5 fix bundle, accepted as documented deferrals):

4. **True per-action step-up binding (1.9 close-out residual):** the
   1.9 review residual that the step-up freshness window is per-
   session not per-action. 1.12 hardening lands the per-action binding
   so a step-up grant for `recommendation.reveal` does not also satisfy
   a follow-up `evidence.decrypt`.
5. **pg-boss-backed sync_idempotency TTL sweep (S1 deferred):** the
   table grows monotonically through 1.10. The sweep job runs hourly
   to `DELETE FROM sync_idempotency WHERE expires_at < now() -
INTERVAL '1 day'` (1-day grace beyond expiry). T-S6 documents the
   practical bound: the 48h dead-letter ceiling is well inside the
   7-day TTL so no operation drains via the queue worker past the
   TTL; the sweep is operational hygiene, not a correctness gate.
6. **sync_conflict.revealed audit kind (optional per the threat
   model):** the 1.10 §"Audit hooks for sync" framing noted this kind
   as a chain-anchored optional add. The S5 reviewers cleared this as
   non-blocking; 1.12 may revisit if the Apply pipeline grows server-
   side reveal endpoints that need their own chain row.
7. **sync.idempotency_replayed operational stream (optional):** a
   debug-only operational stream documented in §"Audit hooks". S5
   reviewers cleared this as optional; 1.12 may add if operational
   data shows the noise-to-signal ratio justifies it.
8. **`recommendation.read` chain anchor (1.9 close-out residual):**
   the 1.9 review residual that reveal endpoints currently emit at
   the route layer per-call but the chain kind enumeration is at
   `recommendation.exported` / `inspection_finding.read` level. 1.12
   may add a unified `recommendation.read` kind for parity.

Cross-reference: SECURITY.md §2.10 T-S51..T-S58 entries document the
S5 close-outs; SECURITY.md §2.10 T-S1 + T-S2 mitigation text now
reflects the honest priv-F1 stance.
