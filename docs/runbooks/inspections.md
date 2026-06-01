# Inspection Operations

Operator runbook for the Inspections + Templates + Findings +
Signatures + PDF Export surface shipped in Milestone 1.8. Pairs with
ADR-0007 and SECURITY.md §2.8. Cross-references `docs/runbooks/auth.md`
for KEK rotation, `docs/runbooks/evidence.md` for the workplace key
pair discipline (1.8 reuses it for photo decrypts), and
`docs/runbooks/action-items.md` for the promote-handoff path.

## 1. Schema overview

Five tables (`inspection_templates`, `inspections`, `inspection_findings`,
`inspection_signatures`, `export_records`) plus two trigger ratchets
into the 1.6 / 1.7 polymorphic FK surface
(`action_items_source_fk_guard`, `evidence_files_linked_fk_guard`).

**`inspection_templates`** — append-only versioned rows. Editing a
template means inserting a new row with `version_number = max+1`. The
prior row stays; historical inspections that pinned it remain valid.
There is no `UPDATE inspection_templates SET sections` path in the API
surface.

| Field                       | Storage                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `template_code`             | `text` CHECK in (`zone_monthly`, `rack_inspection`, `custom`). Stable slug.                                              |
| `version_number`            | `integer` ≥ 1. Natural key with `template_code`.                                                                         |
| `status_vocab`              | CHECK in (`ABC_X`, `GAR`). Per ADR-0007 §3.2.                                                                            |
| `sections`                  | `jsonb` — section/item structure. Zod-validated at write time (T-I11).                                                   |
| `requires_three_signatures` | `boolean`. Drives the export gate (T-I35).                                                                               |
| `created_at` / `retired_at` | Partial UNIQUE INDEX on `(template_code)` WHERE `retired_at IS NULL` keeps "at most one active version per code" (T-I1). |

**`inspections`** — pins the specific `template_version_id` at create
time (non-negotiable #13).

| Field                         | Storage                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `template_version_id`         | FK to `inspection_templates(id)` — pins the version, NOT the code. `ON UPDATE/DELETE RESTRICT`. |
| `zone_id`                     | `text` CHECK in (`zone_1`…`zone_10`). Stable token (non-negotiable #14).                        |
| `state`                       | `text` CHECK in (`scheduled`, `in_progress`, `awaiting_signatures`, `complete`, `archived`).    |
| `started_at` / `completed_at` | Lifecycle timestamps; set by the route on state transitions.                                    |
| `audit_idx`                   | UNIQUE FK into `audit_log(idx)` — `inspection.created` chain row.                               |

**`inspection_findings`** — snapshots `section_label` + `item_label`
from the pinned template at create time. Three encrypted column pairs
plus a one-shot bidirectional FK to `action_items`.

| Field                                               | Storage                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `section_label` / `item_label`                      | Plaintext snapshots from the pinned template — non-PI by construction (T-I12; template content is non-PI per CLAUDE.md). |
| `status_vocab` / `status_value`                     | Validated against the template's vocab at the route (T-I4 / T-I5).                                                       |
| `observation_ct` / `observation_dek_ct`             | Envelope-encrypted via `@jhsc/crypto`. NULL-pair CHECK.                                                                  |
| `corrective_action_ct` / `corrective_action_dek_ct` | Same shape. NULL-pair CHECK.                                                                                             |
| `responsible_party_ct` / `responsible_party_dek_ct` | Same shape. NULL-pair CHECK. Dual-shape (`user_id` alternative) deferred to 1.9 (§11; ADR-0007 §3.6 amended note).       |
| `promoted_action_item_id`                           | UNIQUE partial index — a finding promotes at most once (T-I16).                                                          |
| `audit_idx`                                         | UNIQUE FK into `audit_log(idx)` — `inspection_finding.created`.                                                          |

**`inspection_signatures`** — separate row per role. `(inspection_id,
role)` UNIQUE prevents double-sign of the same role. Each row carries
its own `inspection.signed` chain anchor.

| Field                     | Storage                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `role`                    | `text` CHECK in (`inspector`, `supervisor`, `jhsc_worker_co_chair`).  |
| `signed_by_user_id`       | FK to `users(id)` — pinned at signing time (T-I20 residual — see §7). |
| `note_ct` / `note_dek_ct` | Envelope-encrypted optional note. NULL-pair CHECK.                    |
| `audit_idx`               | UNIQUE FK into `audit_log(idx)`.                                      |

**`export_records`** — stored-PDF receipt with the SHA-256 integrity
anchor, 30-day TTL hint, 100-batch ceiling (T-I32), and step-up grant
JTI for forensic correlation.

| Field            | Storage                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `inspection_ids` | `uuid[]` CHECK cardinality BETWEEN 1 AND 100 (T-I29, T-I32).                                         |
| `output_sha256`  | `bytea(32)` — canonical integrity anchor; verified on every re-download (T-I27).                     |
| `byte_size`      | `bigint` CHECK ≤ 500 MiB.                                                                            |
| `storage_key`    | `text` UNIQUE — `exports/<uuid>/inspection-<uuid>.pdf`.                                              |
| `step_up_jti`    | `text` — JTI of the access token whose `stepUpUntil` was fresh at create time.                       |
| `expires_at`     | `timestamptz` — 30-day TTL. Enforced by the download route's expiry check (`exports.ts:expires_at`). |
| `audit_idx`      | UNIQUE FK into `audit_log(idx)` — `inspection.exported`.                                             |

## 2. Capture-to-conduct flow

The 1.8 happy-path lifecycle for one inspection:

1. **Template selection.** Rep picks a template (Zone Monthly or Rack
   from the seeded set, or a custom template authored under §6's
   discipline).
2. **`POST /api/inspections`** with `templateVersionId` + `zoneId` (+
   optional `scheduledFor`). Pins the version at create time. Emits
   `inspection.created`. State = `scheduled`.
3. **`PATCH /api/inspections/:id`** → `in_progress`. Sets `started_at`.
   Findings can now be created.
4. **`POST /api/inspections/:id/findings`** per finding. Server-side
   envelope-encrypts `observation` / `corrective_action` /
   `responsible_party`. Emits `inspection_finding.created` with
   `hasObservation: bool` (PI-clean, T-I13).
5. **`POST /api/inspections/findings/:id/promote`** (optional). The
   #15 fail-closed gate: X (ABC+X) and G (GAR) reject with 422
   `not_promotable_status`. Already-promoted findings reject with 422
   `already_promoted` (T-I16). Successful promote creates an
   `action_items` row with `source_type='inspection'`, type=`INSP`,
   section=`new_business`. The action-item description is the
   template label snapshot ONLY — observation/corrective_action
   plaintext is no longer welded in (sec-F3 / T-I37 close-out).
6. **`POST /api/inspections/:id/signatures`** per role. Inspector
   first for both templates. For Zone Monthly the inspector signature
   transitions directly to `complete`. For Rack the inspector
   signature transitions to `awaiting_signatures`; the supervisor +
   co-chair complete the three-sig sequence and transition to
   `complete`.
7. **`POST /api/inspections/exports`** with `kind: 'single'` +
   `inspectionIds: [<id>]` (+ optional `includeGps`). Step-up gated
   at 60s. The state + signature gate (T-I35) asserts
   `state='complete'` AND for rack all three roles signed BEFORE
   the workplace private key opens. Render + Tigris PUT with
   `ServerSideEncryption: 'AES256'` (T-I40) + transactional chain
   anchor + `export_records` INSERT. Returns the
   `{exportId, outputSha256, byteSize, expiresAt, chainIdx}`
   receipt.

Once an inspection is `complete` the rep can archive it via
`PATCH → archived`. Archived inspections stay readable; new findings
and signatures are rejected.

## 3. Workplace key dependency

The 1.8 photo embed path depends on the workplace public key (1.7
ADR-0006). Findings link to `evidence_files` rows via
`linked_type='inspection_finding' linked_id=<finding_id>`; the export
route decrypts photos using the same workplace private key + per-file
sealed DEK pattern as 1.7 evidence decrypt.

**Key pair rotation.** Same procedure as `docs/runbooks/evidence.md`
§3 (workplace key pair rotation). KEK rotation re-seals the private
key and is transparent to inspections. Pair rotation requires the
1.12 rewrap script that 1.7 stubbed; until then, the active workplace
key pair is **effectively permanent**.

**`workplaceKeyId` validation.** The 1.7 sec-F5 close-out re-derives
the active workplace key id at upload-finalize and rejects mismatches.
That validation runs against the evidence files linked to findings
the same way it runs against hazard-linked evidence — the 1.8 ratchet
opens `inspection_finding` as an allowed linked type but does NOT
change the key-validation flow.

## 4. Audit anchors on the inspection path

Six chain kinds (`packages/shared-types` `AuditEventKind`):

| Kind                               | Emitted on                                                | Payload (PI-clean)                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `inspection.created`               | `POST /api/inspections`                                   | `{inspectionId, templateCode, templateVersionId, conductedByUserId, zoneId, scheduledFor}` — stable token zoneId, no display name.  |
| `inspection_finding.created`       | `POST /api/inspections/:id/findings`                      | `{inspectionId, findingId, sectionKey, statusVocab, statusValue, hasObservation, hasCorrectiveAction}` — booleans, NEVER plaintext. |
| `inspection_finding.promoted`      | `POST /api/inspections/findings/:id/promote`              | `{findingId, actionItemId, risk}` — pure references + enum.                                                                         |
| `inspection.signed`                | `POST /api/inspections/:id/signatures`                    | `{inspectionId, signatureId, role}` — no `signerUserId` (recoverable by JOIN; T-I20 + §7 below).                                    |
| `inspection.exported`              | `POST /api/inspections/exports`                           | `{exportId, kindOfExport, inspectionIds, outputSha256, byteSize}` — outputSha256 is the canonical integrity anchor.                 |
| `audit.inspection_template.seeded` | First-run seeder (`scripts/seed-inspection-templates.ts`) | `{templateVersionId, templateCode, versionNumber, sectionCount, structureSha256}` — NEVER section text (T-I10).                     |

**Documented residuals on the read path (priv-F3 + priv-F5).** Two
read-path anchors are deferred to 1.9 because the S1 audit-kind
contract was fixed at six:

- **No `inspection_finding.read` anchor (priv-F3 residual).**
  `GET /api/inspections/findings/:id` decrypts observation /
  corrective_action / responsible_party and returns plaintext. The
  route is step-up gated at 60s (`inspection.finding.read`), but no
  chain anchor fires on success. An attacker who walks every finding
  by id leaves no per-read trail. The `inspection.created` +
  `inspection_finding.created` anchors bound the surface — a session-
  token theft that can't pass step-up still gets stopped at the 401. 1.9 adds the kind without ceremony (the 1.7 evidence path
  added three kinds the same way).
- **No `inspection.export.downloaded` anchor (priv-F5 residual).**
  `GET /api/inspections/exports/:id/download` is step-up gated +
  CSRF-header gated, but re-downloads after the original
  `inspection.exported` anchor are invisible to the chain. A
  compromised session that passes step-up once can re-download the
  same PDF as many times in 30 days as it wants without leaving
  chain evidence. The 30-day TTL + per-request step-up freshness
  are the residual bound. The inline comment in `exports.ts` commits
  to the 1.9 ratchet.

**Chain payload contract verification.** `scripts/audit-log-verify.ts`
replays the hash chain from the genesis row, asserting no tampering.
It rejects any chain row whose payload carries the all-zero UUID — a
forward-defense regression check against the 1.7 sec-F1 placeholder
bug. See §12 below for the inspections-specific verification
extension.

## 5. PIPEDA P9 response

Workers and incidentally-named third parties have a right under
PIPEDA Principle 9 to challenge accuracy and request access or
amendment. For inspections specifically:

**Default response.** Refuse the request and direct the requester to
the workplace's complaint mechanism (OHSA / CLC Part II / MLITSD /
PIPEDA Commissioner). Rationale: inspections are statutory evidence,
the rep is the worker-side custodian, and removing or modifying
findings on an unverified request would compromise chain of custody.
Findings are structurally immutable past the `in_progress` state —
the PATCH route returns 422 `finding_immutable_in_state` for
`awaiting_signatures` / `complete` / `archived` (T-I39 close-out
extends this to "immutable after promote" even within
`in_progress`).

**Conditional disclosure.** A request from a worker for inspection
data that DEPICTS THAT WORKER (named in the encrypted observation,
identifiable in a linked photo) MAY be answered by:

1. Step-up authenticating as the rep operator.
2. Calling `GET /api/inspections/findings/:id` for each related
   finding (no chain anchor lands today — see §4 residual).
3. Calling `GET /api/evidence/:id/decrypt` for each linked photo
   (the evidence chain anchor `evidence.read` does land — see
   `docs/runbooks/evidence.md` §4).
4. Delivering the plaintext out-of-band, with a written record of
   which finding IDs + evidence IDs were touched and the chain
   anchor `idx` values that prove they were accessed.
5. Recording the disclosure as a note in a meeting-minutes entry
   (does NOT mutate the inspection row).

**Amendment / redaction.** Inspection findings have NO mutation path
once the inspection advances past `in_progress`. The in-place
redaction model (`inspection_finding_redactions` table with a
`redacted_at` + `redacted_reason` column pair plus a placeholder
ciphertext swap) is **deferred to 1.12**. Until then, the operator's
options are (a) leave the finding in place and add a note on a
linked action item or meeting entry; (b) defer to the PIPEDA
Commissioner if the matter is urgent.

**Finding mutability ends at end of `in_progress` state.** This is
the structural enforcement of the chain-of-custody discipline. The
audit-log-verify script flags any payload that references a finding
whose row has been UPDATEd since its `inspection_finding.created`
anchor (cross-checked against `updated_at` vs the chain row's
`ts_ms`).

## 6. CSA copyright stance

The seeded Rack template (`apps/api/scripts/seed-inspection-templates.ts`)
follows CLAUDE.md non-negotiable #5: clause references only, no
verbatim CSA text. The discipline:

- **Clause-number references** are formatted as `"per CSA A344.X §Y.Z"`
  in the item's `helpText`, with a `CSA-POINTER` marker for the
  editorial-review grep.
- **Numeric tolerances** are NEVER transcribed. The `helpText` says
  "within manufacturer tolerance" or "per the load-application sign
  at the rack" where a number would otherwise appear.
- **Section headings** are commonplace structural labels
  (`'Structural Integrity'`, `'Beam & Hardware'`, etc.) — not
  expressive CSA content.
- **Item labels** are author-original worker-safety prose ("Beams
  show no visible bowing or permanent set under load"). NOT CSA
  quotes.

**2-person review required before merge.** Any PR that touches
`scripts/seed-inspection-templates.ts` must be reviewed by two
authorized maintainers per ADR-0007 §3.4 — same gate as
`packages/legal-corpus` PRs. CI runs a grep for verbatim CSA phrasing
against the `csa-phrase-deny.txt` blocklist.

**Custom templates** are subject to the same CSA discipline via the
new-template authoring view's inline hint
(`apps/web/src/views/new-template-view.tsx`). The `helpText` field
carries the prompt "Plain prose, ≤480 chars. No verbatim CSA text —
clause refs in your own words only." The runtime route layer
applies the same `noHtmlBounded` validation as the seeded path
(T-I11).

## 7. Three-signature reopen procedure

Once a rack inspection is `complete` (all three roles signed), the
inspection is **immutable**. There is no "reopen" path. A misissue
is corrected by:

1. Archiving the misissued inspection (`PATCH → archived`).
2. Creating a new inspection under the same template version, with
   a `scheduled_for` timestamp that reflects the correction date.
3. Conducting + signing + exporting the replacement inspection.
4. Producing both export PDFs at any arbitration hearing, with the
   archived inspection's chain anchor `idx` cited as the corrected
   record.

**Signer-role rotation reconciliation (T-I20 + priv-F9 residual).**
The `inspection.signed` chain payload carries
`{inspectionId, signatureId, role}` — NOT `signerUserId`. The signer
identity is recoverable by JOINing `inspection_signatures` against
`users` via `signatureId`. This is a soft binding: a re-org that
shuffles the co-chair role does not relabel historical signatures
(the row still pins `signed_by_user_id` to the user at signing
time, which is the correct shape for arbitration).

**Forward seam: `scripts/inspections-signers.ts`.** A 1.9 helper
script will produce a UUID → display-name reconciliation report so
the rep can map the UI's 8-char UUID prefix to the historical
signer's identity. The script is documented here as the forward
seam; it does NOT exist in 1.8. Until it lands, the rep recovers
signer identity from the `inspection_signatures.signed_by_user_id`
column joined against `users`:

```sql
SELECT s.role, s.signed_at, u.display_name
FROM inspection_signatures s
JOIN users u ON u.id = s.signed_by_user_id
WHERE s.inspection_id = '<uuid>'
ORDER BY s.signed_at ASC;
```

## 8. PDF export operations

**Server-Side Encryption (priv-F1 / T-I40 close-out).** Every
`putEvidenceObject` call sets `ServerSideEncryption: 'AES256'`. The
rendered PDF is encrypted at rest on Tigris. `AES256` is the safe
S3-compatible default; `aws:kms` is a future swap when a KMS key is
provisioned for the bucket. The bucket-level default-encryption
policy is a **1.12 ops follow-up** — Tigris ops should set
`ServerSideEncryption: 'AES256'` as the bucket default so any
direct PUT (admin tooling, future migrations) inherits the SSE
without the application layer having to set it explicitly.

**30-day TTL.** Enforced by the download route's `expires_at` check
(`exports.ts:expires_at` against `Date.now()`). Returns 410
`export_expired`. The Tigris bucket lifecycle policy to delete
`exports/*` objects after 30 days is a **1.12 ops follow-up** — the
application-layer TTL is the only enforcer today; an attacker who
gets the bucket access key directly can read PDFs past 30 days
until the lifecycle policy is configured.

**GPS opt-in (priv-F7 / T-I43 close-out).** The
`POST /api/inspections/exports` body schema includes
`includeGps: z.boolean().default(false)`. The renderer's photo-
caption block only surfaces the `GPS lat, lon` fragment when
`includeGps === true`. The export panel UI's "Include GPS
coordinates in photo captions" checkbox is the rep-facing surface;
default UNCHECKED. PIPEDA P4 limiting-collection rationale: the
1.7 T-E5 GPS-resolution cap (~11m) is fine for in-app worker-side
metadata, but once distributed in an exhibit, that cap stops being
a meaningful bound.

**Orphan PDF cleanup (sec-F6 / T-I42 close-out).** The route wraps
the `db.transaction` in a try/catch. On rollback after a successful
Tigris PUT, best-effort `DeleteObject` runs against the orphaned
`storageKey` + logs at warn level. Never throws from cleanup; the
original transaction error re-raises.

**Per-actor rate limit.** 5 exports/hour/user via in-memory token
bucket (T-I31). Restart resets the bucket. A pg-boss-backed cross-
process limiter is a 1.12 follow-up.

**Re-download path.** Step-up gated at 60s (action
`inspection.export.download`). `X-Requested-With: jhsc-web` CSRF
guard at the route layer. Re-fetches Tigris bytes and verifies
SHA-256 against `export_records.output_sha256` before responding
(T-I27 TOCTOU detection). Re-downloads are NOT chain-anchored
(priv-F5 / §4 residual); the 30-day TTL + step-up freshness are
the residual bound.

## 9. Plaintext lifetime guarantees

Per ADR-0007 §3.9 and the 1.7 evidence pattern:

- **Photo plaintext buffers** are tracked in
  `allPlaintextBuffers` during export render and zeroed
  (`buf.fill(0)`) on the happy path AND in the catch path
  (`exports.ts:527-528, 600-606`). T-I23 close-out.
- **Workplace private key** is `memzero`'d in a `finally` after the
  per-photo decrypt
  (`exports.ts:openWorkplacePrivateKey` + finally).
- **Per-file sealed DEK** is `memzero`'d in a `finally` after the
  XChaCha20-Poly1305 decrypt.
- **Per-photo plaintext** is `memzero`'d at the `plaintext_sha256`
  mismatch path BEFORE throwing.
- **String fields** (observation, corrective_action,
  responsible_party) cannot be `memzero`'d in JS — string interning
  - GC make it impossible. The plaintext exists only for the
    duration of one request and the render pass. Documented in
    `exports.ts:278-284` and ARCHITECTURE.md.

**Mid-render abort behavior (T-I24).** If any decrypt step or the
plaintext-SHA-256 verify fails, the entire export aborts: the
in-memory PDF bytes are zeroed, the partial bytes never reach
Tigris, and no chain anchor fires. The HTTP response carries the
500 error code with the abort reason (`ciphertext_tamper_detected`
/ `plaintext_tamper_detected` / `pdf_embed_failed` /
`batch_count_mismatch`). The S1 contract is fixed at six audit
kinds — there is no `inspection.export_failed` event. The
diagnostic is the HTTP 500 + the operator's log scrape.

## 10. Zone-rename reconciliation (T-I6)

Historical inspections preserve their `zone_id` literal
(`zone_1`…`zone_10`). Display labels resolve at render time via
`loadWorkplaceConfig().zones`. A workplace that renames
`ZONE_3_NAME` from "Receiving" to "Cold Warehouse" rewrites the
label everywhere — including in old PDFs re-exported after the
rename — but the underlying `zone_id` token in the inspection
row is unchanged.

**Hygiene constraints on env-supplied zone display names**
(priv-F6 / T-I44 close-out):

- Length ≤ 120 chars.
- No `<` or `>` (HTML strip).

On violation the renderer silently falls back to `defaultName`
("Zone N") — no crash, no warning. A misconfigured env is a
deployment-checklist item; the rep's PDF takes priority over
emit-time diagnostics.

**Audit-trail reconciliation.** The chain payloads carry the
stable `zoneId` literal (never the display name). A rep producing
a reconciliation report queries `audit_log` for the literal
`zone_id` value:

```sql
SELECT payload, ts_ms FROM audit_log
WHERE kind = 'inspection.created'
  AND payload->>'zoneId' = 'zone_3'
ORDER BY ts_ms ASC;
```

The arbitrator can then JOIN against `inspections.zone_id` to
recover the conduct-time labels (which were resolved at view
time, not stored on the row).

## 11. Forward seams

Seams documented for the 1.9 / 1.12 ratchets, so a 6-month-out
operator knows what is **deliberately deferred** vs accidentally
missing:

- **`inspection_finding.read` audit kind** (1.9 — priv-F3 residual).
  Adds a seventh AuditEventKind. The 1.7 evidence path added three
  kinds the same way; no ceremony.
- **`inspection.export.downloaded` audit kind** (1.9 — priv-F5
  residual). Re-download events become chain-anchored. The inline
  comment in `exports.ts` commits to the kind.
- **`responsible_party_user_id` dual-shape** (1.9 — priv-F8 / ADR-0007
  §3.6 amended note). 1.8 ships encrypted-string-only. 1.9 adds the
  FK column + Zod surface for internal owners; new writes prefer
  `user_id` for internal rep references. The UI prompt
  (priv-F2 close-out) biases reps toward role/department language
  so the encryption-at-rest claim is the meaningful bound today.
- **`inspection_finding_redactions` table** (1.12). In-place
  redaction model with a `redacted_at` + `redacted_reason` column
  pair plus a placeholder ciphertext swap. Until then, the
  PIPEDA P9 stance is default-refuse (§5).
- **Tigris bucket-level default-encryption + lifecycle policy** (1.12
  ops). Bucket inherits SSE for any direct PUT; lifecycle policy
  deletes `exports/*` objects after 30 days. The application-layer
  TTL is the only enforcer today.
- **Workplace name in PDF header** (1.9 — pending privacy review).
  The cover page currently renders only the template display name
  - stable zone token. Adding `WORKPLACE_DISPLAY_NAME` to the cover
    page body widens the workplace-identity surface beyond the
    generic `/Title` metadata; the privacy review will pin the
    decision.
- **`scripts/inspections-signers.ts`** (1.9). UUID → display-name
  reconciliation helper for the signer-role rotation procedure
  (§7).
- **pg-boss-backed export rate limiter** (1.12). Cross-process
  semantics; survives API restart.

## 12. Chain-of-custody verification

Before walking into an arbitration or MLITSD hearing with inspection
exhibits, run the chain verifier against the relevant rows. The 1.7
`--check-evidence` pattern extends in 1.9 to:

```bash
pnpm tsx scripts/audit-log-verify.ts \
  --since <iso-date> \
  --kinds inspection.created,inspection_finding.created,inspection_finding.promoted,inspection.signed,inspection.exported,audit.inspection_template.seeded \
  --check-inspections
```

The `--check-inspections` flag is **documented as a 1.9 follow-up**
— it does NOT exist in 1.8. The intent: scan every inspection-
related chain payload for zero-UUID placeholders (same forward-
defense as the 1.7 sec-F1 `--check-evidence` pattern); cross-
reference every `inspection.exported` payload's `outputSha256`
against the `export_records.output_sha256` column and reject any
mismatch; cross-reference every `inspection_finding.promoted`
payload's `findingId` + `actionItemId` against the bidirectional FK
to assert the link is intact.

Until the flag ships, the operator runs the generic chain replay:

```bash
pnpm tsx scripts/audit-log-verify.ts --since <iso-date>
```

The verifier replays the hash chain from genesis, asserting no
tampering. Print the resulting JSON dump as the exhibit appendix.
