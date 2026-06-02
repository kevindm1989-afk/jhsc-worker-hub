// /api/inspections/exports/* — Milestone 1.8 S4 PDF export surface.
//
// Three handlers, mounted as a sub-Hono under the inspectionsRoute:
//
//   POST   /api/inspections/exports            — render + store + anchor
//   GET    /api/inspections/exports/:id/download — re-fetch + serve
//   GET    /api/inspections/exports            — list (metadata only)
//
// Discipline (CLAUDE.md #16 + SECURITY.md §2.8 T-I23..T-I32):
//   - Step-up gated, 60s freshness floor (T-I30).
//   - Per-actor 5/hour rate limit on the create path (T-I31); in-memory
//     token bucket. The pg-boss-backed cross-process variant is a 1.12
//     follow-up — documented in the runbook.
//   - X-Requested-With: jhsc-web required on download (the app-wide
//     csrfHeaderGuard catches mutating methods; download is GET but it
//     decrypts nothing and only fetches stored bytes, so it gets the
//     belt-and-suspenders header check at the route layer to align with
//     the 1.7 evidence decrypt posture).
//   - Decrypt photos + finding text inside one bounded request window;
//     memzero every plaintext buffer in `finally` (T-I23).
//   - Mid-render decrypt or hash-mismatch failure aborts the WHOLE
//     export; no partial PDF lands in Tigris, no chain anchor fires
//     (T-I24). The 1.8 contract is fixed at six audit kinds so we do
//     NOT emit an `inspection.export_failed` event; the failure surface
//     is the HTTP response.
//   - The chain row's `outputSha256` is the canonical integrity anchor.
//     We compute the SHA-256 of the rendered PDF AFTER memzeroing the
//     decrypted input plaintexts and BEFORE the `append()` call, then
//     embed it in the audit payload. The payload is canonical-JSON
//     hashed at append time (audit chain immutability — payloads cannot
//     be UPDATEd post-anchor) so this ordering is the only viable shape.
//     Documented inline + runbook follow-up (S5 owns docs/runbooks/
//     inspections.md per the slice plan).
//   - The download path re-verifies the stored bytes' SHA-256 against
//     `output_sha256` before returning (T-I27 TOCTOU detection).
//   - Re-download events are NOT separately anchored in 1.8 (would
//     require a seventh audit kind which S1 fixed the contract at six).
//     The 30-day TTL + per-request step-up gate is the residual bound;
//     a `inspection.export.downloaded` kind lands in 1.9.

import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import sodium from 'libsodium-wrappers-sumo';
import { append } from '@jhsc/audit';
import {
  inspectionExportKind,
  type InspectionExportKind,
  type InspectionSignatureRole,
  type InspectionStatusVocabKind,
} from '@jhsc/shared-types';
import { loadWorkplaceConfig, type ZoneId } from '../../../../../config/workplace';
import { getDb } from '../../db/client';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { rateLimit } from '../../middleware/rate-limit';
import {
  deleteEvidenceObject,
  fetchEvidenceCiphertext,
  putEvidenceObject,
} from '../../evidence/tigris';
import { openWorkplacePrivateKey } from '../../evidence/workplace-key';
import { openOptionalField } from '../../inspections/crypto';
import {
  renderInspectionPdf,
  type RenderableFinding,
  type RenderableInspection,
  type RenderablePhoto,
  type RenderableSignature,
} from '../../inspections/pdf-renderer';

export const inspectionsExportsRoute = new Hono();

inspectionsExportsRoute.use('*', authMiddleware());
// Same rate-limit shape as the inspections route group. The per-actor
// 5/hour export ceiling is layered on top of this (see exportTokenBucket
// below) so the IP-keyed bucket here remains the DoS bound for the
// route group and the per-actor bucket is the abuse bound for #16
// (T-I31).
inspectionsExportsRoute.use(
  '*',
  rateLimit({ name: 'inspections-exports', capacity: 60, refillPerSecond: 10 }),
);
inspectionsExportsRoute.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// ---------------------------------------------------------------------------
// Per-actor token bucket — 5 exports per hour per user (T-I31)
// ---------------------------------------------------------------------------
//
// In-memory; restart resets. A pg-boss-backed limiter is a 1.12 follow-up
// (runbook). Documented here so the operator knows the bound.

interface ActorBucket {
  tokens: number;
  lastRefillMs: number;
}

const EXPORT_CAPACITY = 5;
const EXPORT_REFILL_PER_HOUR = 5;
const exportBuckets = new Map<string, ActorBucket>();

function consumeActorToken(userId: string): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  let b = exportBuckets.get(userId);
  if (!b) {
    b = { tokens: EXPORT_CAPACITY, lastRefillMs: now };
    exportBuckets.set(userId, b);
  }
  const elapsedHours = (now - b.lastRefillMs) / (3600 * 1000);
  b.tokens = Math.min(EXPORT_CAPACITY, b.tokens + elapsedHours * EXPORT_REFILL_PER_HOUR);
  b.lastRefillMs = now;
  if (b.tokens < 1) {
    const needed = 1 - b.tokens;
    const secs = Math.ceil((needed / EXPORT_REFILL_PER_HOUR) * 3600);
    return { ok: false, retryAfterSeconds: secs };
  }
  b.tokens -= 1;
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test-only: reset every per-actor export bucket. */
export function _resetExportBucketsForTests(): void {
  exportBuckets.clear();
}

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

const exportCreateBody = z
  .object({
    kind: z.enum(inspectionExportKind),
    // T-I29 + T-I32: hard bound at 100 inspections per request (the SQL
    // CHECK on export_records.inspection_ids enforces the same).
    inspectionIds: z.array(z.string().uuid()).min(1).max(100),
    // priv-F7 / T-I43 close-out: GPS opt-in per-export. Defaults to
    // false so the rep must affirmatively check the box on the export
    // panel to surface ~11m-resolution coordinates in the disclosable
    // PDF. The 1.7 T-E5 GPS resolution cap is fine for in-app worker-
    // side metadata; once distributed in an exhibit, the cap stops
    // being a meaningful bound. Plumbed through to the renderer.
    includeGps: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.kind === 'single' ? b.inspectionIds.length === 1 : true), {
    message: 'single export requires exactly one inspection id',
    path: ['inspectionIds'],
  });

const uuidParam = z.string().uuid();

// ---------------------------------------------------------------------------
// Internal sentinel for write aborts
// ---------------------------------------------------------------------------

class ExportAborted extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(`export_aborted: ${status}`);
    this.name = 'ExportAborted';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Helpers: zone display name. Reads the workplace deploy-config
// (config/workplace.ts) so the PDF carries the workplace's own zone
// labels (e.g. "Cold Warehouse" instead of "Zone 3") — the rep's
// evidentiary PDF matches their lived vocabulary.
//
// priv-F6 / T-I44 close-out: prior to S5 the renderer hard-coded a
// `ZONE_DEFAULTS` map to bound the workplace-name surface. That
// produced an accuracy gap (PIPEDA Principle 6) — the rep's PDF said
// "Zone 3" while their UI said "Cold Warehouse." The S5 wiring
// consumes `loadWorkplaceConfig().zones`. Two hygiene constraints
// applied to env-supplied display names:
//   - Length cap at 120 chars (matches the template displayName cap).
//   - Reject any value containing `<` or `>` (HTML strip).
// On violation, we silently fall back to the defaultName ("Zone N").
// No crash, no warning — the rep's PDF is the dominant concern; a
// misconfigured env should produce a generic but valid label, not a
// crash mid-export. Constraint documented inline.
//
// T-I28 residual: `/Title`, `/Author`, `/Producer` metadata fields
// remain hard-coded generic strings. Only the rendered text body
// surfaces the configured zone label. The workplace name itself stays
// out of the PDF body until 1.9 (runbook §11).
// ---------------------------------------------------------------------------

const ZONE_DISPLAY_MAX_LEN = 120;

function resolveZoneDisplayName(zoneId: string): string {
  const cfg = loadWorkplaceConfig();
  const z = cfg.zones.find((zone) => zone.id === (zoneId as ZoneId));
  if (!z) return zoneId;
  const raw = (z.displayName ?? '').trim();
  if (
    raw.length === 0 ||
    raw.length > ZONE_DISPLAY_MAX_LEN ||
    raw.includes('<') ||
    raw.includes('>')
  ) {
    return z.defaultName;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Resolve a single inspection into the renderable bundle. Decrypts all
// finding fields + linked photos. Returns the bundle + a memzero
// callback that the caller invokes in a finally to wipe every plaintext
// buffer that survived (photo bytes; finding text is wiped here on the
// happy path but kept on the bundle as strings — JS strings are not
// memzero-able, see comment in the route handler).
// ---------------------------------------------------------------------------

interface ResolveResult {
  readonly inspection: RenderableInspection;
  /**
   * Plaintext photo buffers backing the RenderablePhoto.bytes views. The
   * route handler memzeros each of these after the PDF is rendered.
   */
  readonly plaintextBuffers: ReadonlyArray<Uint8Array>;
}

// Required-signature roles per template. The signature schema's
// `(inspection_id, role)` UNIQUE constraint means presence of all three
// distinct roles is sufficient for "complete" on a three-sig template.
const REQUIRED_THREE_SIG_ROLES: ReadonlyArray<string> = [
  'inspector',
  'supervisor',
  'jhsc_worker_co_chair',
];

/**
 * sec-F1 / T-I35 close-out: pre-render gate that asserts the inspection
 * is in the `complete` state AND, for rack templates, that all three
 * required roles have signed. Both checks run BEFORE `resolveInspection`
 * opens the workplace private key and BEFORE any decrypt happens — so a
 * forged POST never touches plaintext for an unsigned inspection.
 *
 * Throws `ExportAborted` with `inspection_not_complete` /
 * `signatures_incomplete` so the caller's existing catch path surfaces
 * the 422 to the client without leaking the inspection's state shape.
 */
async function assertInspectionExportReady(
  inspectionId: string,
  db: ReturnType<typeof getDb>,
): Promise<void> {
  const ready = (await db.execute(sql`
    SELECT i.id, i.state, t.requires_three_signatures
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_version_id
    WHERE i.id = ${inspectionId}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    state: string;
    requires_three_signatures: boolean;
  }>;
  if (ready.length === 0) {
    throw new ExportAborted(422, { error: 'inspection_not_found', inspectionId });
  }
  const r = ready[0]!;
  if (r.state !== 'complete') {
    throw new ExportAborted(422, {
      error: 'inspection_not_complete',
      inspectionId,
      state: r.state,
    });
  }
  if (r.requires_three_signatures) {
    const sigRows = (await db.execute(sql`
      SELECT DISTINCT role FROM inspection_signatures
      WHERE inspection_id = ${inspectionId}
    `)) as unknown as Array<{ role: string }>;
    const present = new Set(sigRows.map((row) => row.role));
    const missing = REQUIRED_THREE_SIG_ROLES.filter((role) => !present.has(role));
    if (present.size !== REQUIRED_THREE_SIG_ROLES.length || missing.length > 0) {
      throw new ExportAborted(422, {
        error: 'signatures_incomplete',
        inspectionId,
        missingRoles: missing,
      });
    }
  }
}

async function resolveInspection(
  inspectionId: string,
  db: ReturnType<typeof getDb>,
): Promise<ResolveResult> {
  // Inspection + pinned template snapshot.
  const insRows = (await db.execute(sql`
    SELECT i.id, t.template_code, t.display_name, t.version_number,
           i.zone_id, i.conducted_by_user_id,
           i.started_at::text AS started_at,
           i.completed_at::text AS completed_at
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_version_id
    WHERE i.id = ${inspectionId}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    template_code: string;
    display_name: string;
    version_number: number;
    zone_id: string;
    conducted_by_user_id: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
  if (insRows.length === 0) {
    throw new ExportAborted(422, { error: 'inspection_not_found', inspectionId });
  }
  const insp = insRows[0]!;

  // Findings (encrypted).
  const findingRows = (await db.execute(sql`
    SELECT id, section_label, item_label, status_vocab, status_value,
           observation_ct, observation_dek_ct,
           corrective_action_ct, corrective_action_dek_ct,
           responsible_party_ct, responsible_party_dek_ct
    FROM inspection_findings
    WHERE inspection_id = ${inspectionId}
    ORDER BY created_at ASC
  `)) as unknown as Array<{
    id: string;
    section_label: string;
    item_label: string;
    status_vocab: string;
    status_value: string;
    observation_ct: Uint8Array | null;
    observation_dek_ct: Uint8Array | null;
    corrective_action_ct: Uint8Array | null;
    corrective_action_dek_ct: Uint8Array | null;
    responsible_party_ct: Uint8Array | null;
    responsible_party_dek_ct: Uint8Array | null;
  }>;

  // Signatures (note ciphertext NOT rendered in PDF — the note surface
  // is for the rep's eyes only at the moment of signing; the PDF carries
  // the role + signer + timestamp).
  const signatureRows = (await db.execute(sql`
    SELECT role, signed_by_user_id, signed_at::text AS signed_at
    FROM inspection_signatures
    WHERE inspection_id = ${inspectionId}
    ORDER BY signed_at ASC
  `)) as unknown as Array<{
    role: string;
    signed_by_user_id: string;
    signed_at: string;
  }>;

  const plaintextBuffers: Uint8Array[] = [];
  const findings: RenderableFinding[] = [];

  for (const f of findingRows) {
    // Decrypt each text field via the inspections crypto helper. The
    // helper returns a JS string, which the route layer cannot memzero
    // (string interning + GC make it impossible). The plaintext exists
    // only for the duration of one request and the render pass. This
    // is the same tradeoff documented in 1.7 evidence decrypt + the
    // 1.5 hazards descriptionCt path.
    const observation = openOptionalField({ ct: f.observation_ct, dekCt: f.observation_dek_ct });
    const correctiveAction = openOptionalField({
      ct: f.corrective_action_ct,
      dekCt: f.corrective_action_dek_ct,
    });
    const responsibleParty = openOptionalField({
      ct: f.responsible_party_ct,
      dekCt: f.responsible_party_dek_ct,
    });

    // Linked photos (evidence_files with linkedType='inspection_finding').
    const evRows = (await db.execute(sql`
      SELECT id, storage_key, ciphertext_sha256, sealed_dek, workplace_key_id,
             plaintext_sha256, mime_type,
             captured_at::text AS captured_at,
             gps_latitude::text AS gps_latitude,
             gps_longitude::text AS gps_longitude
      FROM evidence_files
      WHERE linked_type = 'inspection_finding' AND linked_id = ${f.id}
      ORDER BY uploaded_at ASC
    `)) as unknown as Array<{
      id: string;
      storage_key: string;
      ciphertext_sha256: Uint8Array;
      sealed_dek: Uint8Array;
      workplace_key_id: string;
      plaintext_sha256: Uint8Array;
      mime_type: string;
      captured_at: string | null;
      gps_latitude: string | null;
      gps_longitude: string | null;
    }>;

    const photos: RenderablePhoto[] = [];
    for (const ev of evRows) {
      // Fetch ciphertext.
      const ciphertext = await fetchEvidenceCiphertext(ev.storage_key);
      // Verify ciphertext sha256 first — same shape as the 1.7 evidence
      // decrypt T-I24 close-out: a bucket-side mutation surfaces as a
      // 500 abort before any decrypt.
      const obsCipherSha = createHash('sha256').update(ciphertext).digest();
      if (!obsCipherSha.equals(Buffer.from(ev.ciphertext_sha256))) {
        throw new ExportAborted(500, {
          error: 'export_aborted',
          reason: 'ciphertext_tamper_detected',
          inspectionId,
          findingId: f.id,
          evidenceId: ev.id,
        });
      }
      await sodium.ready;
      const privateKey = await openWorkplacePrivateKey(db, ev.workplace_key_id);
      let dek: Uint8Array;
      try {
        const publicKey = sodium.crypto_scalarmult_base(privateKey);
        dek = sodium.crypto_box_seal_open(Uint8Array.from(ev.sealed_dek), publicKey, privateKey);
      } finally {
        sodium.memzero(privateKey);
      }
      let plaintext: Uint8Array;
      try {
        if (ciphertext.length < 25 || ciphertext[0] !== 0x02) {
          throw new ExportAborted(500, {
            error: 'export_aborted',
            reason: 'ciphertext_format',
            inspectionId,
            findingId: f.id,
            evidenceId: ev.id,
          });
        }
        const nonce = ciphertext.slice(1, 25);
        const body = ciphertext.slice(25);
        plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, null, nonce, dek);
      } finally {
        sodium.memzero(dek);
      }
      // Verify plaintext sha256 (T-I24 integrity gate before embed).
      const obsPlainSha = createHash('sha256').update(plaintext).digest();
      if (!obsPlainSha.equals(Buffer.from(ev.plaintext_sha256))) {
        sodium.memzero(plaintext);
        throw new ExportAborted(500, {
          error: 'export_aborted',
          reason: 'plaintext_tamper_detected',
          inspectionId,
          findingId: f.id,
          evidenceId: ev.id,
        });
      }
      plaintextBuffers.push(plaintext);
      photos.push({
        evidenceId: ev.id,
        mimeType: ev.mime_type,
        bytes: plaintext,
        capturedAt: ev.captured_at,
        gpsLatitude: ev.gps_latitude !== null ? Number(ev.gps_latitude) : null,
        gpsLongitude: ev.gps_longitude !== null ? Number(ev.gps_longitude) : null,
      });
    }

    findings.push({
      id: f.id,
      sectionLabel: f.section_label,
      itemLabel: f.item_label,
      statusVocab: f.status_vocab as InspectionStatusVocabKind as 'ABC_X' | 'GAR',
      statusValue: f.status_value,
      observation,
      correctiveAction,
      responsibleParty,
      photos,
    });
  }

  const signatures: RenderableSignature[] = signatureRows.map((s) => ({
    role: s.role as InspectionSignatureRole,
    signedByUserId: s.signed_by_user_id,
    signedAt: s.signed_at,
  }));

  return {
    inspection: {
      id: insp.id,
      templateCode: insp.template_code,
      templateDisplayName: insp.display_name,
      templateVersion: insp.version_number,
      zoneId: insp.zone_id,
      zoneDisplayName: resolveZoneDisplayName(insp.zone_id),
      conductedByUserId: insp.conducted_by_user_id,
      startedAt: insp.started_at,
      completedAt: insp.completed_at,
      findings,
      signatures,
    },
    plaintextBuffers,
  };
}

// ---------------------------------------------------------------------------
// POST /api/inspections/exports
// ---------------------------------------------------------------------------

inspectionsExportsRoute.post('/', async (c) => {
  const auth = c.get('auth');

  // 1. Step-up gate FIRST. Cheap; rejects unauthorized callers before we
  //    touch the DB or open the workplace key.
  //
  // 60s step-up freshness floor (T-I30). The action string is echoed
  // in the WWW-Authenticate challenge header for the client's step-up
  // modal; the server enforces only the (actor, freshness-window)
  // tuple, NOT a per-action binding. True per-action binding is a
  // 1.12 hardening item (sec-F1 close-out from 1.9 S5 review,
  // documented in docs/runbooks/recommendations.md §11).
  const challenge = checkStepUpFreshness(auth, {
    action: 'inspection.export',
    maxAgeSeconds: 60,
  });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }

  // 2. Body validation.
  const parsed = exportCreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  // 3. Per-actor 5/hour rate limit (T-I31). After step-up so the bucket
  //    isn't drained by unauthorized callers.
  const bucket = consumeActorToken(auth.userId);
  if (!bucket.ok) {
    c.header('Retry-After', String(bucket.retryAfterSeconds));
    return c.json(
      { error: 'export_rate_limited', retryAfterSeconds: bucket.retryAfterSeconds },
      429,
    );
  }

  const db = getDb();

  // 4. Resolve every requested inspection. Collect plaintext buffers
  //    for memzero in finally. If ANY step fails, abort the whole
  //    export — partial PDFs do not land in Tigris and no chain anchor
  //    fires (T-I24).
  const allPlaintextBuffers: Uint8Array[] = [];
  const inspections: RenderableInspection[] = [];
  let renderedBytes: Uint8Array | null = null;
  let outputSha256Hex = '';
  let byteSize = 0;
  // sec-F6 / T-I42 close-out: track the Tigris storage key once the PUT
  // succeeds so we can best-effort DELETE it if the DB transaction
  // rolls back. Without this, a transaction failure after PUT (advisory
  // lock contention, audit_log_pkey collision, export_records CHECK
  // violation) would leave an orphan PDF in Tigris that the chain
  // doesn't know about.
  let putStorageKey: string | null = null;

  try {
    // sec-F1 / T-I35 close-out: assert state=complete + (for rack)
    // all three signatures present BEFORE any key open or decrypt. The
    // assertion runs per-inspection so a batch export with one un-
    // signed inspection rejects the whole batch.
    for (const inspectionId of body.inspectionIds) {
      await assertInspectionExportReady(inspectionId, db);
    }
    for (const inspectionId of body.inspectionIds) {
      const r = await resolveInspection(inspectionId, db);
      inspections.push(r.inspection);
      for (const buf of r.plaintextBuffers) allPlaintextBuffers.push(buf);
    }
    if (inspections.length !== body.inspectionIds.length) {
      // T-I29: explicit assertion the iteration didn't silently truncate.
      throw new ExportAborted(500, {
        error: 'export_aborted',
        reason: 'batch_count_mismatch',
        expected: body.inspectionIds.length,
        got: inspections.length,
      });
    }

    // 5. Pre-allocate the exportId so the storage_key is stable across
    //    the upload and DB write.
    const exportId = randomUUID();
    const storageKey = `exports/${exportId}/inspection-${exportId}.pdf`;

    // 6. Render the PDF. The chainIdx is filled in *after* render —
    //    we render with a sentinel of -1 then re-render after the
    //    audit append? No, that doubles work and the chain row's
    //    canonical-JSON hash binds the payload, not the PDF bytes.
    //    Instead: render with the PROVISIONAL chainIdx=0 placeholder,
    //    then after computing the SHA-256 + PUT + append, the chain
    //    row's idx is bound to this exact bytes hash. The PDF footer
    //    bears a chainIdx of 0 for the very first export ever (genesis
    //    + 1 + ... edge case), but the chain anchor is the source of
    //    truth — the in-PDF number is a navigation aid.
    //
    //    Actually we can do better: SELECT MAX(idx)+1 ahead of time so
    //    the footer carries the predicted idx. The advisory lock in
    //    `append()` serializes concurrent appenders so the predicted
    //    idx may still race. We render the PDF with the predicted idx,
    //    and append() will use whatever the actual nextIdx is. A small
    //    cosmetic skew is acceptable; the chain row + export_records.
    //    audit_idx is the binding.
    const predictedIdxRows = (await db.execute(sql`
      SELECT COALESCE(MAX(idx), -1) + 1 AS next_idx FROM audit_log
    `)) as unknown as Array<{ next_idx: number }>;
    const predictedIdx = Number(predictedIdxRows[0]?.next_idx ?? 0);

    renderedBytes = await renderInspectionPdf(
      inspections,
      {
        exportId,
        exportedAt: new Date().toISOString(),
        chainIdx: predictedIdx,
        outputSha256Placeholder: '',
      },
      // priv-F7 / T-I43 close-out: per-export GPS opt-in. Renderer
      // suppresses photo-caption GPS unless the rep explicitly
      // checked the export panel's "Include GPS coordinates"
      // checkbox.
      { includeGps: body.includeGps },
    );

    // 7. Memzero plaintext buffers now — render is complete, the bytes
    //    are encoded into the PDF stream (which holds compressed/
    //    flate-wrapped copies). The decrypted Uint8Array views are
    //    no longer needed. T-I23 close-out.
    for (const buf of allPlaintextBuffers) buf.fill(0);
    allPlaintextBuffers.length = 0;

    // 8. Compute output_sha256 + byte_size.
    outputSha256Hex = createHash('sha256').update(renderedBytes).digest('hex');
    byteSize = renderedBytes.length;

    // 9. PUT bytes to Tigris BEFORE the DB transaction. If the PUT
    //    fails, we have NOT written any DB row and no chain anchor has
    //    fired — clean abort. The bytes live in process memory until
    //    the response goes out; that's the necessary tradeoff for the
    //    chain-row immutability (the chain payload is canonical-JSON
    //    hashed at append, so we cannot UPDATE the payload to add the
    //    sha after-the-fact).
    await putEvidenceObject({
      storageKey,
      bytes: renderedBytes,
      mimeType: 'application/pdf',
    });
    putStorageKey = storageKey;

    // 10. Transactional anchor + INSERT. The append() call computes
    //     this_hash over the full payload INCLUDING outputSha256 — the
    //     chain binds the exported bytes by hash.
    //
    // sec-F6 / T-I42 close-out: wrap the db.transaction in a try/catch.
    // If the transaction rolls back AFTER the Tigris PUT succeeded
    // (advisory-lock contention on append(), audit_log_pkey collision,
    // export_records constraint violation, network drop on the DB
    // connection), best-effort DELETE the orphaned storage_key. Log
    // the cleanup attempt at warn level; never throw from cleanup —
    // re-raise the original transaction error.
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    let result: { exportId: string; chainIdx: number };
    try {
      result = await db.transaction(async (tx) => {
        const chainRow = await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'inspection.exported',
            exportId,
            kindOfExport: body.kind as InspectionExportKind,
            inspectionIds: body.inspectionIds,
            outputSha256: outputSha256Hex,
            byteSize,
          },
          resourceType: 'export_records',
          resourceId: exportId,
        });
        const outputShaBytes = Buffer.from(outputSha256Hex, 'hex');
        await tx.execute(sql`
          INSERT INTO export_records (
            id, kind, inspection_ids, requested_by_user_id, requested_at,
            output_sha256, byte_size, storage_key, step_up_jti,
            expires_at, audit_idx
          )
          VALUES (
            ${exportId},
            ${body.kind},
            ${body.inspectionIds}::uuid[],
            ${auth.userId},
            now(),
            ${outputShaBytes as unknown as Uint8Array},
            ${byteSize},
            ${storageKey},
            ${auth.sessionId},
            ${expiresAt}::timestamptz,
            ${chainRow.idx}
          )
        `);
        return { exportId, chainIdx: chainRow.idx };
      });
      // Chain anchor + export_records row landed; the Tigris object is
      // now non-orphan and the catch-block cleanup should NOT delete it.
      putStorageKey = null;
    } catch (txErr) {
      // Best-effort orphan delete. deleteEvidenceObject never throws;
      // it returns {ok: boolean} so the original txErr is preserved.
      if (putStorageKey) {
        const del = await deleteEvidenceObject(putStorageKey).catch(() => ({ ok: false }));
        console.warn(
          `[inspections.exports] orphan PDF cleanup after transaction failure: storageKey=${putStorageKey} ok=${del.ok}`,
        );
        putStorageKey = null;
      }
      throw txErr;
    }

    return c.json({
      exportId: result.exportId,
      kind: body.kind,
      outputSha256: outputSha256Hex,
      byteSize,
      expiresAt,
      chainIdx: result.chainIdx,
    });
  } catch (err) {
    // T-I23: zero everything on every error path. The fill(0) loop above
    // covers the happy path; this catch covers the abort paths.
    for (const buf of allPlaintextBuffers) {
      try {
        buf.fill(0);
      } catch {
        // intentional
      }
    }
    if (renderedBytes) {
      // The PDF bytes themselves are not PI — they ARE the disclosable
      // artifact. Zeroing them is harmless and we do it for symmetry.
      renderedBytes.fill(0);
    }
    // sec-F6 / T-I42 close-out (outer catch fallback): if a non-tx
    // error fired AFTER the Tigris PUT landed (rare — the only path is
    // an exception thrown between PUT and the inner tx try-block),
    // still attempt the orphan cleanup. The inner try-block already
    // covers the common case.
    if (putStorageKey) {
      const del = await deleteEvidenceObject(putStorageKey).catch(() => ({ ok: false }));
      console.warn(
        `[inspections.exports] orphan PDF cleanup after non-tx failure: storageKey=${putStorageKey} ok=${del.ok}`,
      );
      putStorageKey = null;
    }
    if (err instanceof ExportAborted) {
      return c.json(err.body, err.status as 400 | 422 | 500);
    }
    // priv-F12 close-out: the renderer throws `Error('pdf_embed_failed:<evidenceId>')`
    // when pdfkit cannot decode photo bytes that passed the upstream
    // SHA-256 verify (T-I24). Shape into the 500 the rep already
    // expects on render abort.
    if (err instanceof Error && err.message.startsWith('pdf_embed_failed:')) {
      const evidenceId = err.message.slice('pdf_embed_failed:'.length);
      return c.json({ error: 'export_aborted', reason: 'pdf_embed_failed', evidenceId }, 500);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/exports/:id/download
// ---------------------------------------------------------------------------

inspectionsExportsRoute.get('/:id/download', async (c) => {
  // X-Requested-With CSRF check (same posture as 1.7 evidence decrypt:
  // sec-F2 belt-and-suspenders against same-site phishing tabs that
  // load `<img src>` / `<iframe src>` to the route).
  if (c.req.header('x-requested-with') !== 'jhsc-web') {
    return c.json({ error: 'csrf_required' }, 403);
  }

  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

  const auth = c.get('auth');
  // 60s step-up freshness floor (T-I31). The action string is echoed
  // in the WWW-Authenticate challenge header for the client's UX; the
  // server enforces only the (actor, freshness-window) tuple, NOT a
  // per-action binding. True per-action binding is a 1.12 hardening
  // item (sec-F1 close-out from 1.9 S5 review).
  const challenge = checkStepUpFreshness(auth, {
    action: 'inspection.export.download',
    maxAgeSeconds: 60,
  });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }

  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, storage_key, output_sha256, byte_size, expires_at::text AS expires_at
    FROM export_records
    WHERE id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    storage_key: string;
    output_sha256: Uint8Array;
    byte_size: number;
    expires_at: string;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;
  if (new Date(r.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'export_expired' }, 410);
  }

  // Fetch the bytes from Tigris.
  const bytes = await fetchEvidenceCiphertext(r.storage_key);

  // T-I27: re-verify SHA-256 matches the chain-anchored hash before
  // returning. A Tigris-side mutation between the original write and
  // this read shows up here.
  const observed = createHash('sha256').update(bytes).digest();
  if (!observed.equals(Buffer.from(r.output_sha256))) {
    return c.json({ error: 'export_tamper_detected' }, 500);
  }

  // 1.9 priv-F5 close-out (ADR-0008 §3.12 / T-R30): emit a per-download
  // chain anchor AFTER step-up clears AND the Tigris fetch succeeds AND
  // the SHA-256 verifies AND BEFORE the bytes go out. The ordering
  // matters — a failed re-download (404 / 410 expired / SHA mismatch)
  // does NOT anchor; only a successful, integrity-verified download
  // produces a chain row. The 1.8 contract was fixed at six audit
  // kinds; this is the seventh, opened by ADR-0008. Wrap the anchor
  // emit in a tiny transaction so the append() runs under the
  // serializing advisory-lock pattern.
  await db.transaction(async (tx) => {
    await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'inspection.export.downloaded',
        exportId: r.id,
        downloadedByUserId: auth.userId,
      },
      resourceType: 'export_records',
      resourceId: r.id,
    });
  });

  // Same response posture as 1.7 evidence decrypt: force download,
  // strict CSP, no-store, no referrer.
  return new Response(bytes.slice().buffer, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="jhsc-inspection-export-${r.id}.pdf"`,
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store, max-age=0',
      pragma: 'no-cache',
      expires: '0',
      'referrer-policy': 'no-referrer',
      'content-length': String(bytes.length),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/inspections/exports — list (metadata only)
// ---------------------------------------------------------------------------

inspectionsExportsRoute.get('/', async (c) => {
  const db = getDb();
  // No step-up gate on the metadata list (matches the 1.7 evidence list
  // posture); the PDF bytes are gated by the download route. The
  // metadata is non-sensitive: export id, kind, inspection count,
  // sha-prefix, byte size, requested-by uuid, requested-at, expiry.
  //
  // No per-row chain anchor — list endpoints emit metadata only and
  // the contract from S1 is six audit kinds; we don't add a seventh.
  const rows = (await db.execute(sql`
    SELECT id, kind,
           array_length(inspection_ids, 1) AS inspection_count,
           inspection_ids,
           requested_by_user_id,
           requested_at::text AS requested_at,
           encode(output_sha256, 'hex') AS output_sha256,
           byte_size,
           expires_at::text AS expires_at
    FROM export_records
    ORDER BY requested_at DESC
    LIMIT 200
  `)) as unknown as Array<{
    id: string;
    kind: string;
    inspection_count: number;
    inspection_ids: string[];
    requested_by_user_id: string;
    requested_at: string;
    output_sha256: string;
    byte_size: number;
    expires_at: string;
  }>;
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind as InspectionExportKind,
      inspectionCount: r.inspection_count,
      inspectionIds: r.inspection_ids,
      requestedByUserId: r.requested_by_user_id,
      requestedAt: r.requested_at,
      outputSha256: r.output_sha256,
      byteSize: Number(r.byte_size),
      expiresAt: r.expires_at,
    })),
  });
});
