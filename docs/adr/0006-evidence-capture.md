# ADR-0006 — Evidence files + Capture-to-Record (Milestone 1.7)

Status: Accepted
Date: 2026-05-30
Authors: codifies Milestone 1.7 architect-phase decisions; pairs with `SECURITY.md` §2.7.

## Context

Photos, voice transcripts, and other captured artifacts are the JHSC's evidence base — the things a regulator, arbitrator, or MLITSD inspector actually reads when a complaint reaches them. Three things make evidence different from anything before this milestone:

1. **Binary blobs, not text fields.** Photos can be 5–15 MB each; the envelope-encrypted-column pattern from Milestones 1.5/1.6 doesn't fit. Files live in Tigris (S3-compatible object storage), encrypted.
2. **Client-side encryption boundary.** CLAUDE.md non-negotiable #11 establishes the precedent for Excel imports: "Imports are sanitized. Imported files are parsed in the browser, sensitive fields encrypted client-side before server sync." The same rule applies here — a raw photo of a worker's injury, hazardous condition, or face must never enter the server in plaintext. The browser encrypts before upload.
3. **Capture-to-Record signature interaction.** Mobile-primary flow: tap FAB → camera → GPS-stamped, hash-fingerprinted hazard or evidence record created in one motion. Camera roll never touched (CLAUDE.md "Signature Interactions"). This is identity-defining UX.

`design/prototypes/capture-to-record.tsx` is the visual anchor. ROADMAP 1.7 scope is the model + encryption + capture flow + FAB + voice-to-text on description fields.

## Decision

Land `evidence_files` schema + Tigris adapter + `packages/evidence-crypto` (browser-side helpers reusing libsodium-wrappers) + four API routes + the 5-stage Capture-to-Record flow + a `<VoiceToText />` input enhancement. Encryption boundary is the browser; the server holds only ciphertext + sealed-DEK metadata. Photos can attach to hazards, action items, or any future evidence-bearing entity via a polymorphic `(linked_type, linked_id)` pair — same shape as the 1.6 action_items source FK.

### Key delivery model — workplace public key (sealed box)

The new architectural piece: a **workplace ephemeral key pair** delivered to the browser at session boot.

- On first-run (`POST /api/auth/first-run/confirm`), the server generates a workplace X25519 key pair. The **public key** is stored unencrypted in a new `workplace_keys` row; the **private key** is sealed under the workplace KEK (`@jhsc/crypto` envelope) and stored in the same row.
- On session establishment, `GET /api/auth/session` returns the workplace public key in its response payload. The browser caches it in memory for the session.
- For each evidence file upload:
  1. Browser generates a fresh 32-byte DEK via `crypto.getRandomValues`.
  2. Encrypts the file bytes with the DEK using XChaCha20-Poly1305 (`crypto_aead_xchacha20poly1305_ietf_encrypt`).
  3. Seals the DEK with the workplace public key via `crypto_box_seal` (libsodium sealed box — anonymous sender, recipient-only open).
  4. Uploads `(ciphertext, sealed_dek)` to Tigris; uploads metadata to `/api/evidence`.
- Server reads back: opens `sealed_dek` with the workplace private key (which it unwraps with KEK), then decrypts the ciphertext with the DEK. Never sees plaintext during upload.

**Why sealed box (not direct KEK in browser):** the workplace KEK never leaves Fly Secrets (CLAUDE.md Encryption Rules). A sealed box is a one-way encrypt-anyone, open-only-recipient primitive, exactly the shape we need: the browser can encrypt without ever holding a key that decrypts.

**Forward seam:** when E2EE messaging lands in Release 3 (libsignal), the per-rep identity key pair will supersede the workplace key pair for cross-rep messaging, but evidence stays workplace-scoped because exports and inspector access need the workplace key to decrypt.

### Tables

```
workplace_keys (
  id                  uuid primary key default gen_random_uuid(),
  active              boolean not null default true,        -- only one active at a time
  public_key          bytea not null,                       -- 32 bytes X25519
  private_key_ct      bytea not null,                       -- sealed under workplace KEK
  private_key_dek_ct  bytea not null,
  created_at          timestamptz not null default now(),
  retired_at          timestamptz
);

evidence_files (
  id                  uuid primary key default gen_random_uuid(),
  -- Polymorphic link to the owning entity.
  linked_type         text not null check (linked_type in ('hazard','action_item','inspection_finding','recommendation','incident')),
  linked_id           uuid not null,
  -- Object storage key + verification.
  storage_key         text not null unique,                 -- e.g. 'evidence/<uuid>/file.bin'
  ciphertext_sha256   bytea not null,                       -- SHA-256 of the ciphertext blob uploaded to Tigris
  -- Per-file DEK sealed for the workplace key pair the file was uploaded under.
  sealed_dek          bytea not null,
  workplace_key_id    uuid not null references workplace_keys(id) on delete restrict,
  -- Plaintext integrity anchor (caller-supplied; verified during decrypt-and-read flow).
  plaintext_sha256    bytea not null,                       -- SHA-256 of the original file
  -- File metadata (non-PI).
  mime_type           text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/heic','audio/webm','audio/ogg','application/pdf')),
  byte_size           bigint not null check (byte_size > 0 and byte_size <= 50 * 1024 * 1024),
  -- Captured at the moment of the upload, not from EXIF (EXIF is stripped client-side).
  -- Coordinate precision intentionally limited to 4 decimal places (~11m) to bound
  -- worker-location PI; full precision is too narrow inside an industrial site.
  captured_at         timestamptz,
  gps_latitude        numeric(8,4),
  gps_longitude       numeric(8,4),
  gps_accuracy_m      numeric(8,2),
  -- Audit chain anchor (FK to audit_log.idx — like hazards/action_items).
  audit_idx           bigint not null references audit_log(idx) on delete restrict,
  uploaded_by_user_id uuid not null references users(id),
  uploaded_at         timestamptz not null default now()
);
```

Notes:

- **No DELETE endpoint.** Evidence is by definition append-only; misfilings are handled via a future `evidence_redactions` table (1.12 hardening).
- **`linked_type IN (...)` CHECK** is the same forward-seam shape as 1.6 polymorphic source FK. Per-type FK triggers land in their owning migrations; the 1.7 migration only validates `'hazard'` and `'action_item'` because those are the only target tables that exist today. `recommendation` / `inspection_finding` / `incident` are accepted at the schema level but rejected at the route layer until their tables ship (same fail-closed pattern as action items priv-AI-F3).
- **`mime_type` CHECK** is an allow-list. No PDF execution surface, no raw text, no exotic formats. Photos + audio + PDFs only.
- **`byte_size` <= 50MB** at the schema level; Tigris bucket policy enforces the same ceiling.
- **GPS precision capped at 4 decimals.** A 6-decimal GPS coordinate locates a worker within 11 cm. Inside a single workplace that becomes a worker-tracking surface; 4 decimals (11 m) suffices to identify the zone without identifying the specific station the worker was standing at.

### Tigris upload path

- API route `POST /api/evidence/upload-url` issues a presigned PUT URL bound to `evidence/<uuid>/blob` with a 5-minute expiry. Returns `{ uploadUrl, storageKey, workplaceKeyId, workplacePublicKey }`.
- Browser PUTs the **already-encrypted** ciphertext blob directly to Tigris using the presigned URL.
- Browser POSTs `/api/evidence` with `{ storageKey, ciphertextSha256, sealedDek, plaintextSha256, mimeType, byteSize, capturedAt?, gpsLatitude?, gpsLongitude?, gpsAccuracyM?, linkedType, linkedId }`.
- Server: verifies storage_key matches the presign it issued, verifies the ciphertext exists in Tigris with matching SHA-256, writes the evidence_files row inside a transaction, emits `evidence.uploaded` audit chain row, returns evidence id.

The two-step (presign → upload → finalize) keeps the API off the upload data path. The server only sees small metadata blobs; the multi-MB ciphertext goes browser-direct to Tigris.

### API surface

`apps/api/src/routes/evidence/`:

- `POST /api/evidence/upload-url` — issue presigned PUT URL. Body: `{ mimeType, byteSizeEstimate }`. Returns `{ uploadUrl, storageKey, workplaceKeyId, workplacePublicKeyB64 }`.
- `POST /api/evidence` — finalize. Body: the full metadata blob above. Validates the Tigris object exists + ciphertext SHA-256 matches. Emits `evidence.uploaded` audit event. Returns `{ id, linkedType, linkedId }`.
- `GET /api/evidence?linkedType=hazard&linkedId=<uuid>` — list evidence for an entity. Returns metadata only (no ciphertext). Used by the hazard/action-item detail views to render thumbnails-by-proxy.
- `GET /api/evidence/:id/decrypt-url` — issue presigned GET URL for the ciphertext + return the sealed_dek metadata. Step-up required for evidence linked to a worker-identity-bearing entity (configurable per linked_type). Browser fetches the ciphertext, unwraps the DEK via the in-session workplace key pair... wait, the browser doesn't hold the workplace private key. So this is: API decrypts server-side, returns the plaintext. Two paths under consideration:
  - **Path A — server decrypt:** API opens sealed_dek with the workplace private key (unwrapped from KEK), decrypts the file, returns plaintext. Lands the data on the server boundary again but only for the lifetime of the response.
  - **Path B — short-lived sym key:** API generates an ephemeral symmetric key, decrypts to that key in-process, the browser PUTs an ephemeral GET on a derived URL that streams the plaintext through a Cloudflare-Worker-style filter. Complex; deferred.
  - **Decision: Path A for 1.7.** The decrypt-and-stream surface lands on the API. Step-up gate per linked_type carries the operational bound. Plaintext on the API is bounded to a single response lifetime; no caching, no logging.

### Audit-chain events

```ts
| { kind: 'evidence.uploaded';
    evidenceId: string;
    linkedType: 'hazard' | 'action_item' | ...;
    linkedId: string;
    mimeType: string;
    byteSize: number;
    plaintextSha256: string;       // hex 64-char — hash is non-reversible PI
  }
| { kind: 'evidence.read';
    evidenceId: string;
    linkedType: ...;
    linkedId: string;
  }
```

`plaintextSha256` is the integrity anchor — auditors verify by re-hashing the decrypted blob. No PI in either payload; `linkedType` + `linkedId` are just FKs.

### Web surfaces

- **`<CaptureFab />`** — fixed bottom-right floating action button on mobile. Tap routes to `/capture` with the current entity context (`?linkedType=hazard&linkedId=...`).
- **`/capture`** — the 5-stage flow per prototype:
  1. **Idle** — entry guidance + permissions check (`navigator.mediaDevices`, `navigator.geolocation`).
  2. **Capturing** — `getUserMedia({ video: { facingMode: 'environment' } })` rendered into a `<canvas>` overlay; tap snaps a frame at native resolution. Photos never enter the camera roll.
  3. **Preview** — review + retake + add-more. Multiple captures collect into a single evidence batch.
  4. **Drafting** — fill in description (optionally via voice-to-text), confirm linked entity, confirm GPS.
  5. **Confirmed** — receipt with evidence IDs + hash provenance footer.
- **`<EvidenceList />`** — embedded in hazard / action-item detail views. Renders ciphertext-blind thumbnails (server returns a tiny encrypted preview blob the browser can decrypt; deferred to 1.10) + filename + size + uploader.
- **`<VoiceToText />`** — wraps native `SpeechRecognition` API. No third-party service (CLAUDE.md non-negotiable #3). Falls back to "voice not supported on this browser" + plain textarea on Firefox/Safari.

### Implementer slices

- **S1 — shared types + schema + migration 0006.** `EvidenceLinkedType` / mime allow-list enums in `packages/shared-types`. `workplace_keys` + `evidence_files` Drizzle tables. Migration with CHECKs + index on `(linked_type, linked_id)`. `audit_log` event kinds extended with `evidence.uploaded` / `evidence.read`. Audit-payload union extended.
- **S2 — server-side crypto helpers + Tigris adapter + four routes.** `packages/evidence-crypto` exports the sealed-box helpers in a way the browser can import. `apps/api/src/evidence/tigris.ts` wraps the S3 SDK with the presign helpers. `apps/api/src/routes/evidence/` ships the four routes. Workplace-key bootstrap is added to the first-run-confirm flow. Integration tests cover the full upload lifecycle + audit chain emission.
- **S3 — Capture-to-Record web flow.** `apps/web/src/capture/` with the 5-stage flow + the FAB. `<VoiceToText />` lands here too. Tests: jsdom snapshots of each stage + mocked `MediaStream` for the capture interaction + mocked `SpeechRecognition` for voice.
- **S4 — evidence on hazard + action-item detail.** Add `<EvidenceList />` to the existing detail views. Tests: render evidence rows + decrypt-flow happy path.
- **S5 — independent security + privacy reviews** — same pattern as 1.4/1.5/1.6.

## Consequences

### Positive

- First milestone with end-to-end client-side encryption, closing CLAUDE.md non-negotiable #11's precedent for the broader app.
- Workplace key pair lands now and can be reused for any future "encrypt-but-don't-decrypt" surface (export-to-third-party with optional recipient pubkey, etc.).
- The 5-stage Capture-to-Record flow ships as the project's first signature interaction — proves the design vocabulary works end-to-end.
- Voice-to-text uses native APIs only, no third-party service (CLAUDE.md non-negotiable #3).

### Negative / accepted tradeoffs

- **GPS precision capped at 4 decimals (~11m).** A rep capturing a hazard at a specific shelf might want exact coordinates for inspection follow-up. The 11m floor is the conservative call: worker-location precision below that becomes a tracking surface and the 1.7 reviewers will flag it. Inspections (1.8) can revisit with a per-template policy.
- **`/api/evidence/:id/decrypt-url` lands plaintext on the API.** Path B (Cloudflare Worker filter) is rejected for 1.7; the simpler server-decrypt is good enough for single-tenant scope. Documented as T-E\* in §2.7.
- **EXIF stripping is best-effort.** The browser uses a `<canvas>` re-encode path to drop EXIF; iOS Safari has a known quirk where HEIC photos may retain partial metadata. The 1.7 runbook documents the limitation; a 1.12 hardening sweep verifies fresh JPEG/PNG outputs are clean.

### Risks

- **Workplace key rotation.** A KEK rotation rewraps the workplace private key fine, but a _workplace key pair_ rotation (separate key) means every prior evidence row needs the sealed_dek rewrapped under the new public key. The migration script lands in 1.12; pre-rotation the operational guidance is "don't rotate the workplace key pair without the rewrap script." Documented in the auth runbook §3a follow-up.
- **Presigned URL window.** Tigris presigns a 5-min upload URL. If the user takes longer (slow upload, big batch), the URL expires and the browser has to request a new one. Acceptable UX cost.
- **`SpeechRecognition` not supported on Firefox + Safari desktop.** Voice-to-text degrades to plain textarea on those browsers. Mobile coverage (Safari iOS + Chrome Android) is intact.

## Compliance check

- [x] Aligns with `.context/constraints.md` — no cross-border transfer, no new subprocessor (Tigris is Fly-native, ca-central-1).
- [ ] Threat model updated — **follow-up: threat-modeler appends SECURITY.md §2.7 "Evidence" with T-E1..T-En.**
- [x] No new subprocessor.
- [x] CLAUDE.md non-negotiables #2 (evidence-grade), #3 (no third-party telemetry — voice uses native API), #4 (encryption at app layer — now extended to the browser boundary), #11 (browser parses + encrypts before sync), #16 (exports audit-logged with hash) honored.
- [x] WCAG 2.2 AA — capture flow has visible focus, keyboard fallback ("upload from file") for users without camera access; voice-to-text has a clear textarea fallback.

## Follow-ups

- [ ] Threat-modeler: SECURITY.md §2.7 — evidence threats + mitigations.
- [ ] S1: shared-types + schema + migration 0006.
- [ ] S2: server crypto + Tigris adapter + routes.
- [ ] S3: Capture-to-Record flow + `<VoiceToText />`.
- [ ] S4: evidence on hazard + action-item detail.
- [ ] S5: security + privacy reviewers.
- [ ] Runbook: `docs/runbooks/evidence.md` covering EXIF caveats, GPS precision rationale, workplace key rotation procedure, evidence redaction (placeholder for 1.12), PIPEDA P9.
- [ ] `.context/decisions.md` entry.
