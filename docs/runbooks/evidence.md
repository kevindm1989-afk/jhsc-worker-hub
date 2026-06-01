# Evidence Operations

Operator runbook for the Evidence + Capture-to-Record surface shipped in
Milestone 1.7. Pairs with ADR-0006 and SECURITY.md §2.7. Cross-references
`docs/runbooks/auth.md` for KEK rotation and chain-tamper response, and
`docs/runbooks/hazards.md` / `docs/runbooks/action-items.md` for the
PIPEDA Principle 9 procedure shape (evidence has its own §5 below).

## 1. Schema overview

Two tables (`workplace_keys`, `evidence_files`) plus a polymorphic FK
trigger (`evidence_files_linked_fk_guard`).

**`workplace_keys`** — single active X25519 keypair shared across the
JHSC. Public key ships to the browser per session for sealed-box
encryption of per-file DEKs. Private key sealed under the workplace KEK
in Fly Secrets, opened only inside the API's decrypt handler.

| Field                   | Storage                                                 |
| ----------------------- | ------------------------------------------------------- |
| `public_key`            | `bytea` (32 bytes, X25519). CHECK enforces length.      |
| `private_key_ct`        | Envelope ciphertext via `@jhsc/crypto`.                 |
| `private_key_dek_ct`    | DEK sealed under workplace KEK.                         |
| `active` + `retired_at` | Retirement-pair CHECK; partial UNIQUE on `active=true`. |

**`evidence_files`** — per-file metadata. Ciphertext lives in Tigris,
addressed by `storage_key`. Both SHA-256 anchors (`ciphertext_sha256`,
`plaintext_sha256`) live on the row; the DB sees only ciphertext + hashes.

| Field                            | Storage                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `linked_type` / `linked_id`      | Polymorphic FK. Route accepts `hazard` + `action_item` in 1.7; trigger fail-closes on the rest.    |
| `storage_key`                    | `evidence/<uuid>/blob` — opaque, non-guessable, UNIQUE.                                            |
| `ciphertext_sha256`              | `bytea(32)` — verified against Tigris bytes before decrypt (T-E1).                                 |
| `sealed_dek`                     | `bytea` — per-file DEK sealed for the active workplace public key via `crypto_box_seal`.           |
| `workplace_key_id`               | FK to `workplace_keys.id`. Server re-asserts equals the active row at finalize (T-E16).            |
| `plaintext_sha256`               | `bytea(32)` — verified after decrypt (T-E1) and anchored in the `evidence.uploaded` chain payload. |
| `mime_type`                      | Allow-list CHECK; see §6 (mime caveats).                                                           |
| `byte_size`                      | `bigint` ≤ 50 MB CHECK; Zod refinement on the route mirrors the bound.                             |
| `captured_at`                    | Browser clock at snap time; advisory only.                                                         |
| `gps_latitude` / `gps_longitude` | `numeric(8,4)` — ~11m precision cap (T-E5). All-or-nothing CHECK with `gps_accuracy_m`.            |
| `audit_idx`                      | UNIQUE FK into `audit_log.idx` — every upload anchors a `evidence.uploaded` chain row.             |
| `uploaded_by_user_id`            | FK to `users.id`. Internal pseudonym; never echoed in audit payloads.                              |

## 2. Capture-to-Record flow (browser side)

The 5-stage flow lives at `apps/web/src/views/capture-view.tsx`:
`idle → capturing → preview → drafting → confirmed`. Photos NEVER
enter the OS camera roll — the browser holds the `MediaStream` →
`<video>` → snaps into `<canvas>` → reads PNG bytes → `sealEvidence()`
→ PUTs ciphertext to Tigris → POSTs metadata to `/api/evidence`.

The plaintext PNG bytes are zeroed (`.fill(0)`) and the preview blob
URLs are revoked on successful upload AND on cancel/retake (sec-F9).
The `confirmed` stage holds only the evidence IDs, not the bytes.

**Description / caption.** The drafting stage does NOT capture a
description field — the evidence row has no description column in 1.7,
and silently dropping the user's text at finalize was an evidentiary-
integrity bug (priv-F1). Context lives on the linked hazard or action
item; the UI explicitly directs the rep there.

## 3. Workplace key pair rotation

The KEK rotation procedure in `docs/runbooks/auth.md` §3a re-seals the
workplace **private** key under the new KEK — that path covers
KEK-compromise scenarios end-to-end. Rotating the **workplace key pair
itself** (e.g. the public key was exported off-platform and the rep
wants forward secrecy) is a separate operation that 1.7 does NOT yet
ship a script for.

### §3a. Operational stance until 1.12

The active workplace key pair is treated as **effectively permanent**.
If you suspect compromise:

1. **KEK compromise** (the more likely path): follow auth runbook §3a.
   The workplace private key gets re-sealed under the new KEK as part
   of the rewrap pass. No evidence_files changes needed.
2. **Workplace private key compromise** (the rarer path): export the
   prior evidence out-of-band (decrypt via `/api/evidence/:id/decrypt`
   with a fresh step-up grant, store the plaintext on an
   operator-controlled offline volume), then bootstrap a fresh JHSC
   instance. The in-place rewrap script lands in 1.12 hardening.

### §3b. Forward-seam invariants (for the 1.12 rewrap)

The schema is forward-compatible: `workplace_keys.active` is the source
of truth, retired keys carry `retired_at`, and the partial UNIQUE
index `workplace_keys_only_one_active` prevents two active rows.
`apps/api/src/evidence/workplace-key.ts` exposes
`_invalidateWorkplaceKeyCache()` so the rotation script can drop the
in-process public-key cache after writing the new row. On a multi-
machine deploy each machine still needs a deploy-level invalidation
(typically a restart) — single-machine deploys are correct after one
call.

Server-side `workplaceKeyId` validation (sec-F5) re-derives the active
key id at finalize and rejects mismatches. A client that's still
holding a stale public key after rotation will fail the finalize call
with `workplace_key_id_not_active` and re-fetch from
`/api/auth/session`.

## 4. Audit anchors on the evidence path

Three chain kinds (`packages/shared-types` `AuditEventKind`):

| Kind                     | Emitted on                                | Payload (PI-clean)                                                            |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `evidence.uploaded`      | `POST /api/evidence` finalize success     | `{evidenceId, linkedType, linkedId, mimeType, byteSize, plaintextSha256}`     |
| `evidence.read`          | `GET /api/evidence/:id/decrypt` success   | `{evidenceId, linkedType, linkedId}` (no hash — that's the upload anchor)     |
| `evidence.list_accessed` | `GET /api/evidence?linkedType=&linkedId=` | `{linkedType, linkedId, rowCount}` — one anchor per list call, no per-row ids |

`evidence.list_accessed` (priv-F5 / T-E13 close-out) exists because the
list response carries GPS coords, timestamps, and the uploader UUID —
metadata that's strictly less sensitive than the plaintext but still
useful for surveillance. The list path is auth-only (no step-up), but
the chain anchor means a session-token theft that can't pass step-up
still leaves a trail when bulk-walking the metadata.

The chain payload contract is verified at session level by `scripts/
audit-log-verify.ts`. The script also rejects any chain row whose
payload carries the all-zero UUID — a forward-defense regression check
against the sec-F1 placeholder bug.

## 5. PIPEDA P9 response

Workers and incidentally-photographed third parties have a right
under PIPEDA Principle 9 to challenge accuracy and request access
or amendment. For evidence files specifically:

**Default response.** Refuse the request and direct the requester to
the workplace's complaint mechanism (OHSA / CLC Part II / MLITSD /
PIPEDA Commissioner). Rationale: evidence is potential MLITSD /
arbitration material, the rep is the worker-side custodian, and
removing or modifying evidence on an unverified request would
compromise chain of custody.

**Conditional disclosure.** A request from a worker for evidence that
DEPICTS THAT WORKER (named in the linked hazard, identifiable in a
photo) MAY be answered by:

1. Step-up authenticating as the rep operator.
2. Calling `GET /api/evidence/:id/decrypt` for each related file
   (each call emits an `evidence.read` chain anchor).
3. Delivering the plaintext to the requester out-of-band, with a
   written record of which evidence_files row IDs were disclosed and
   the chain anchor `idx` values that prove they were touched.
4. Recording the disclosure on the linked hazard or action item as
   a note (does NOT mutate the evidence row).

**Amendment / redaction.** Evidence rows have NO mutation path in 1.7.
The in-place redaction model (a `redacted_at` + `redacted_reason`
column pair plus a `redacted_placeholder.png` ciphertext swap) lands
in 1.12 hardening. Until then, the operator's option is to leave the
file in place and add a note on the linked entity. The chain row for
the original upload preserves the linkage.

**Deletion.** No DELETE endpoint exists. A real deletion would require
(a) the rewrap script (§3b), (b) a `redacted_files` audit trail
to prove the deletion was authorized, and (c) a Tigris bucket
operation. Defer the request to the 1.12 hardening sweep, or refer the
requester to the PIPEDA Commissioner if the matter is urgent.

## 6. Mime allow-list caveats

The API accepts the full mime allow-list in
`packages/shared-types/src/index.ts`:

```
image/jpeg, image/png, image/webp, image/heic,
audio/webm, audio/ogg, application/pdf
```

In 1.7 only `image/png` is actually generated by the UI capture flow
(`canvas.toBlob('image/png')`). The wider allow-list exists so a
future "upload from file" affordance (ADR-0006 §"Web surfaces" — WCAG
keyboard fallback) and a future `MediaRecorder`-backed audio path
can ship without re-touching the schema.

**EXIF residual.** PNG does not carry EXIF; a freshly-drawn `<canvas>`
re-encode strips any input metadata. **Today's capture flow is
EXIF-zero by construction.** When the upload-from-file fallback
ships, it MUST route the uploaded bytes through the same `<canvas>`
re-encode path before encryption — otherwise HEIC/JPEG uploads can
carry GPS, device serial, and timestamp.

**iOS Safari HEIC quirk.** A known platform issue: re-encoding HEIC
through `<canvas>` in iOS Safari can leak some EXIF that other
platforms drop. The runbook stance is: prefer `image/png` outputs on
iOS, and document the residual in the SECURITY.md T-E4 row.

**PDF rendering.** Decrypt responses set `Content-Disposition:
attachment` and `Content-Security-Policy: default-src 'none'; sandbox`
(sec-F6) so PDFs are downloaded, not rendered inline. Embedded PDF JS
gets no network egress even if a viewer ignores the disposition. The
downloaded bytes live in the user's downloads folder — that's the
file-system's problem, not ours.

## 7. Voice transcription disclosure

The `<VoiceToText />` component (`apps/web/src/evidence/components.tsx`)
wraps the browser-native `SpeechRecognition` / `webkitSpeechRecognition`
API only. The app NEVER calls a third-party ASR endpoint.

**However:** Chrome and Edge implement `webkitSpeechRecognition` by
forwarding the audio stream to Google's cloud STT — that's the
platform's behavior, not ours. The UI surfaces this disclosure
unconditionally when the mic button is available so the rep can choose
to hand-type sensitive narratives (witness identifiers, body-part
injury detail, accommodation context) instead.

Firefox + Safari desktop do not ship the API; the component falls back
to a plain textarea with no mic affordance.

## 8. Tigris bucket — orphaned ciphertext

A presigned PUT can succeed even if the client never calls finalize
(or finalize rejects on linked-entity-missing, validation failure,
network drop, etc.). The orphan ciphertext lives in Tigris with no
DB row pointing to it — invisible to the app, but billed.

**Stance for 1.7.** No GC script ships. The threat is bounded by the
per-IP rate limit on `/api/evidence/upload-url` (60 burst / 10 rps,
same shape as 1.5/1.6) and by the 5-min presign TTL. A buggy client
can leak budget over weeks but not over hours.

**1.12 hardening.** Either (a) tag the object at upload-url time with
an `expires_at` metadata header + Tigris bucket lifecycle policy, or
(b) ship `scripts/evidence-gc.ts` that walks Tigris keys under
`evidence/<uuid>/` and deletes those without a corresponding
evidence_files row older than N hours. Track alongside the redaction
table.

## 9. Decrypt path — what to know

The decrypt route lives at `GET /api/evidence/:id/decrypt`. Pre-
conditions enforced at request time:

1. `X-Requested-With: jhsc-web` header (sec-F2). Same-site phishing
   tabs that fire `<img src>` / `<iframe src>` cannot set this; the
   web client sends it on every call.
2. Step-up freshness ≤ 60s (`checkStepUpFreshness`, action
   `evidence.read`). 401 with `WWW-Authenticate: StepUp` triggers the
   modal in `apps/web/src/auth/api.ts`.
3. The row's `linked_type` is in `acceptedLinkedTypes` (sec-F3) —
   defense-in-depth against a manual SQL writer.

Inside the handler:

1. HEAD against Tigris already happened at finalize. Decrypt fetches
   the full ciphertext, computes SHA-256, compares against
   `evidence_files.ciphertext_sha256`. Mismatch → 500
   `ciphertext_tamper_detected` (T-E1).
2. Opens the sealed DEK with the workplace private key (zeroed on
   success + catch).
3. Decrypts XChaCha20-Poly1305 body (zeroed in `finally`).
4. Verifies SHA-256 of plaintext against `evidence_files.plaintext_sha256`.
   Mismatch → 500 `plaintext_tamper_detected`.
5. Emits `evidence.read` chain anchor BEFORE streaming so the audit
   record is durable even if the client disconnects mid-stream.
6. Streams plaintext back with:
   - `Content-Type` from the row's mime type
   - `Content-Disposition: attachment; filename="evidence-<id>.<ext>"`
   - `Content-Security-Policy: default-src 'none'; sandbox`
   - `Cache-Control: private, no-store, max-age=0`
   - `Pragma: no-cache` / `Expires: 0` / `Referrer-Policy: no-referrer`

## 10. Chain-of-custody verification (pre-hearing)

Before walking into an arbitration or MLITSD hearing with evidence
exhibits, run the chain verifier against the relevant rows:

```bash
pnpm tsx scripts/audit-log-verify.ts \
  --since <iso-date> \
  --kinds evidence.uploaded,evidence.read,evidence.list_accessed
```

The verifier:

1. Replays the hash chain from the genesis row, asserting no
   tampering.
2. Cross-references every `evidence.uploaded` payload's `evidenceId`
   against the `evidence_files.audit_idx` FK and rejects any
   all-zero placeholder UUID (sec-F1 forward defense).
3. For each `evidence.read` row, computes the count of reads per
   `evidenceId` so you can produce a "this exhibit was opened N
   times by user X between dates A and B" attestation.

Print the resulting JSON dump as your exhibit appendix. The chain
hash + the per-row `idx` values are the tamper-evidence anchor.
