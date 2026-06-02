// /api/recommendations/* export surface — Milestone 1.9 S4.
//
// Three handlers, registered onto the parent recommendationsRoute by
// `registerRecommendationExportHandlers()`:
//
//   POST   /api/recommendations/:id/exports          — render + sign + store + anchor
//   GET    /api/recommendations/exports/:id/download — re-fetch + verify + serve
//   GET    /api/recommendations/exports              — list (metadata only)
//
// Two routes use `/exports` as a static path, one uses `/:id/exports`
// scoped to the recommendation. Mounting them all on the parent
// Hono group avoids URL-prefix duplication and keeps the auth +
// rate-limit + body-limit middleware stack consistent (the parent
// group already installs all three per S2 — see ./index.ts).
//
// Discipline (CLAUDE.md #16 + SECURITY.md §2.9 T-R22..T-R45):
//   - Step-up gated; 60s freshness floor (T-R28). The action string
//     identifies the recommendation id in the WWW-Authenticate header
//     so the client's step-up modal surfaces WHICH recommendation the
//     grant is for; the server enforces only the (actor, freshness-
//     window) tuple, NOT a per-action binding. True per-action binding
//     is a 1.12 hardening item documented in
//     `docs/runbooks/recommendations.md` §11 (sec-F1 close-out).
//   - Per-actor 5/hour rate-limit on POST (T-R28 sibling of 1.8 T-I31);
//     in-memory token bucket. The pg-boss-backed cross-process variant
//     remains a 1.12 follow-up (recommendation runbook).
//   - The global csrfHeaderGuard catches POST (mutating); the GET
//     download path adds an explicit X-Requested-With check (belt-and-
//     suspenders; matches the 1.7 sec-F2 / 1.8 download posture).
//   - Decrypt every PI plaintext (title, body, per-response author_role
//     + body) inside a single bounded request window. JS strings are
//     immutable; we cannot wipe decrypted title/body/response prose
//     from the V8 heap. The plaintext lives until GC. The buffers we
//     CAN wipe — the signing private key (sodium.memzero), the DEK
//     Uint8Arrays (sodium.memzero inside openRecommendationField),
//     and the rendered PDF + ZIP byte buffers (.fill(0) in the
//     finally) — ARE wiped explicitly. The string-immutability gap is
//     the documented tradeoff carried forward from 1.5 / 1.7 / 1.8
//     (sec-F6 close-out — honest discipline; the dead
//     allPlaintextBuffers array from S4 was removed).
//   - The workplace signing private key is opened just before the sign
//     call and `sodium.memzero`'d in a finally — same posture as the
//     1.7 evidence decrypt private key (workplace_keys).
//   - Mid-render decrypt or hash-mismatch failure aborts the WHOLE
//     export — no partial ZIP lands in Tigris, no chain anchor fires.
//     The 1.9 contract is fixed at eleven audit kinds (nine from S1 +
//     two added in S5: recommendation.export.downloaded and
//     recommendation.draft_patched). We do NOT emit a
//     `recommendation.export_failed` event. The failure surface is the
//     HTTP response.
//   - The chain row's `outputSha256` is the canonical anchor over the
//     PDF (NOT the ZIP — see Option B note on the download handler).
//     The chain row's `signatureSha256` binds the signature.
//   - After Tigris PUT, the route transaction inserts the export_records
//     row + emits the chain anchor. If the transaction rolls back,
//     a best-effort DeleteObject removes the orphan ZIP (sec-F6 mirror).
//   - The download path re-verifies the stored bundle's pdfSha256 +
//     output_sha256 alignment AND signature.bin SHA-256 against
//     export_records.signature_sha256 (S5 sec-F3 close-out — TOCTOU
//     detection now covers consistent-ZIP-swap attacks where the
//     attacker re-signs with a different key but keeps the manifest
//     PDF hash valid). See the inline comment on Option B for the
//     chain-anchor semantic. Full Ed25519 crypto verify on download
//     is a 1.12 hardening item; the SHA-256 cross-check catches the
//     consistent-swap vector the S5 reviewer flagged.
//   - S5 sec-F2 close-out (T-R43): re-download emits a
//     `recommendation.export.downloaded` chain anchor inside a
//     db.transaction AFTER step-up clears, Tigris fetch + TOCTOU
//     verify succeed. Failed paths (401, 404, 410, SHA mismatch,
//     signature mismatch, wrong_kind) do NOT anchor. Mirror of the
//     1.8 inspection.export.downloaded retrofit (priv-F5 close-out).

import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import type { Hono } from 'hono';
import sodium from 'libsodium-wrappers-sumo';
import { z } from 'zod';
import { append, canonicalJsonStringify } from '@jhsc/audit';
import type { RecommendationJurisdiction } from '@jhsc/shared-types';
import { getDb } from '../../db/client';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { rateLimit } from '../../middleware/rate-limit';
import {
  deleteEvidenceObject,
  fetchEvidenceCiphertext,
  putEvidenceObject,
} from '../../evidence/tigris';
import {
  getActiveWorkplaceSigningPublicKey,
  openWorkplaceSigningPrivateKey,
} from '../../evidence/workplace-signing-key';
import { openRecommendationField } from '../../recommendations/crypto';
import {
  computeCitationsHash,
  renderRecommendationPdf,
  type RenderableCitation,
  type RenderableRecommendation,
  type RenderableResponse,
} from '../../recommendations/pdf-renderer';
import { signRecommendationBundle } from '../../recommendations/signing';
import {
  buildSignedZipBundle,
  computeManifestSansSigCanonical,
  type RecommendationBundleManifest,
} from '../../recommendations/zip-builder';

// ---------------------------------------------------------------------------
// Per-actor token bucket — 5 exports per hour per user (mirror 1.8 T-I31)
// ---------------------------------------------------------------------------

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
export function _resetRecommendationExportBucketsForTests(): void {
  exportBuckets.clear();
}

// ---------------------------------------------------------------------------
// Internal sentinel for write aborts (mirror inspections shape)
// ---------------------------------------------------------------------------

class ExportAborted extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(`recommendation_export_aborted: ${status}`);
    this.name = 'RecommendationExportAborted';
    this.status = status;
    this.body = body;
  }
}

const uuidParam = z.string().uuid();

// 1.10 (ADR-0009 §3.3): optional clientId body for the export create
// path. Exports are require-online per §3.6 (server-side PDF render +
// sign + Tigris PUT) but the queue may still surround the call with
// Idempotency-Key + clientId for retry-safe semantics — a network blip
// on the response leg must not double-render + double-anchor the chain.
const exportCreateBody = z
  .object({
    clientId: z.string().uuid().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Resolve the recommendation into the renderable bundle. Decrypts the
// title + body + every response field; resolves each citation to its
// corpus body + body hash. Returns the bundle plus the citationsHash
// (which the route also binds into the chain payload + manifest).
//
// On any failure (recommendation missing, corpus missing, decrypt
// failure) throws `ExportAborted` — the caller's try/catch surfaces
// the HTTP response and runs the memzero / cleanup paths.
// ---------------------------------------------------------------------------

interface ResolvedRender {
  readonly renderable: RenderableRecommendation;
  readonly citationsHash: string;
}

async function resolveRecommendation(
  recommendationId: string,
  db: ReturnType<typeof getDb>,
): Promise<ResolvedRender> {
  const recRows = (await db.execute(sql`
    SELECT id, recommendation_number, jurisdiction, status,
           drafted_by_user_id,
           drafted_at::text AS drafted_at,
           submitted_at::text AS submitted_at,
           resolved_at::text AS resolved_at,
           withdrawn_at::text AS withdrawn_at,
           withdrawn_reason,
           title_ct, title_dek_ct,
           body_ct, body_dek_ct
    FROM recommendations
    WHERE id = ${recommendationId}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    recommendation_number: number;
    jurisdiction: string;
    status: string;
    drafted_by_user_id: string;
    drafted_at: string;
    submitted_at: string | null;
    resolved_at: string | null;
    withdrawn_at: string | null;
    withdrawn_reason: string | null;
    title_ct: Uint8Array;
    title_dek_ct: Uint8Array;
    body_ct: Uint8Array;
    body_dek_ct: Uint8Array;
  }>;
  if (recRows.length === 0) {
    throw new ExportAborted(404, { error: 'recommendation_not_found', recommendationId });
  }
  const rec = recRows[0]!;
  const jurisdiction = rec.jurisdiction as RecommendationJurisdiction;

  // Decrypt title + body inside this bounded window.
  const title = openRecommendationField({ ct: rec.title_ct, dekCt: rec.title_dek_ct });
  const body = openRecommendationField({ ct: rec.body_ct, dekCt: rec.body_dek_ct });

  // Resolve citations. Each row is joined to clauses + statutes to
  // recover the clause body + body_hash + a renderable label. The
  // corpus is append-only-versioned (T-R8 invariant); a triple that
  // was valid at submit time SHOULD still be queryable here. If a
  // corpus rotation between submit and export retired the row, abort
  // with 500 — the export's citationsHash anchor cannot be computed
  // without the body, and shipping a PDF with [missing] footnotes
  // would defeat the evidentiary value.
  const citationRows = (await db.execute(sql`
    SELECT rc.statute_code, rc.clause_id, rc.version_date::text AS version_date, rc.position,
           cl.citation AS clause_citation, cl.body, cl.body_summary, cl.body_kind,
           encode(cl.body_hash, 'hex') AS body_hash_hex
    FROM recommendation_citations rc
    JOIN clauses cl ON cl.id::text = rc.clause_id
    JOIN statutes s ON s.id = cl.statute_id AND s.code = rc.statute_code
    WHERE rc.recommendation_id = ${recommendationId}
    ORDER BY rc.position ASC
  `)) as unknown as Array<{
    statute_code: string;
    clause_id: string;
    version_date: string;
    position: number;
    clause_citation: string;
    body: string;
    body_summary: string | null;
    body_kind: string;
    body_hash_hex: string;
  }>;

  // Check for any orphan citation rows (recommendation_citations entries
  // that don't resolve into clauses) — the JOIN above silently drops
  // them; we cross-reference against the raw row count to detect.
  const rawCitationCount = (await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM recommendation_citations
    WHERE recommendation_id = ${recommendationId}
  `)) as unknown as Array<{ n: number }>;
  if (Number(rawCitationCount[0]!.n) !== citationRows.length) {
    throw new ExportAborted(500, {
      error: 'citation_corpus_missing',
      recommendationId,
      // How many corpus joins are missing — handy for the runbook
      // diagnostic without leaking which (statute, clause, date) tuple.
      expected: Number(rawCitationCount[0]!.n),
      resolved: citationRows.length,
    });
  }

  const citations: RenderableCitation[] = citationRows.map((cr) => {
    // Per CLAUDE.md "Legal Reference Module Rules" #5: third-party-
    // restricted statutes get the body_summary path, never the verbatim
    // body. The corpus seeder enforces this at write time; we honor it
    // at read time by branching on body_kind.
    const bodyText =
      cr.body_kind === 'summary' && cr.body_summary !== null ? cr.body_summary : cr.body;
    return {
      position: cr.position,
      statuteCode: cr.statute_code,
      clauseId: cr.clause_id,
      versionDate: cr.version_date,
      clauseLabel: `${cr.statute_code} ${cr.clause_citation}`,
      clauseBody: bodyText,
      clauseBodyHash: cr.body_hash_hex,
    };
  });
  const citationsHash = computeCitationsHash(citations);

  // Resolve responses. Encrypted fields decrypted inline.
  const responseRows = (await db.execute(sql`
    SELECT id, position, received_at::text AS received_at, received_by_user_id,
           author_role_ct, author_role_dek_ct, body_ct, body_dek_ct
    FROM recommendation_responses
    WHERE recommendation_id = ${recommendationId}
    ORDER BY position ASC
  `)) as unknown as Array<{
    id: string;
    position: number;
    received_at: string;
    received_by_user_id: string;
    author_role_ct: Uint8Array;
    author_role_dek_ct: Uint8Array;
    body_ct: Uint8Array;
    body_dek_ct: Uint8Array;
  }>;
  const responses: RenderableResponse[] = responseRows.map((rr) => ({
    position: rr.position,
    receivedAt: rr.received_at,
    receivedByUserIdPrefix: rr.received_by_user_id.slice(0, 8),
    authorRole: openRecommendationField({
      ct: rr.author_role_ct,
      dekCt: rr.author_role_dek_ct,
    }),
    body: openRecommendationField({ ct: rr.body_ct, dekCt: rr.body_dek_ct }),
  }));

  // Compute the deadline server-side so the renderer doesn't need to
  // import the shared-types deadline helper. ON: submitted_at + 21
  // days; CA-FED: null.
  let deadline: string | null = null;
  if (jurisdiction === 'ON' && rec.submitted_at !== null) {
    const submitted = new Date(rec.submitted_at);
    const due = new Date(submitted.getTime() + 21 * 24 * 3600 * 1000);
    deadline = due.toISOString().slice(0, 10);
  }

  const renderable: RenderableRecommendation = {
    id: rec.id,
    recommendationNumber: rec.recommendation_number,
    jurisdiction,
    title,
    body,
    draftedByUserIdPrefix: rec.drafted_by_user_id.slice(0, 8),
    draftedAt: rec.drafted_at,
    submittedAt: rec.submitted_at,
    deadline,
    resolvedAt: rec.resolved_at,
    withdrawnAt: rec.withdrawn_at,
    withdrawnReason: rec.withdrawn_reason,
    status: rec.status as RenderableRecommendation['status'],
    citations,
    responses,
  };
  return { renderable, citationsHash };
}

// ---------------------------------------------------------------------------
// Manifest construction. Pure function so unit tests can exercise it
// without spinning the DB.
// ---------------------------------------------------------------------------

function buildManifest(input: {
  exportId: string;
  recommendationId: string;
  exportedAt: string;
  pdfSha256Hex: string;
  citationsHash: string;
  signingKeyId: string;
  signingPublicKey: Uint8Array;
}): RecommendationBundleManifest {
  // Base64 (no padding) per RFC 4648 §5. The verifier decodes with
  // sodium.from_base64(..., sodium.base64_variants.URLSAFE_NO_PADDING)
  // or any standard base64url decoder.
  const pkB64 = sodium.to_base64(input.signingPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  return {
    version: 1,
    format: 'recommendation_export.v1',
    recommendationId: input.recommendationId,
    exportId: input.exportId,
    exportedAt: input.exportedAt,
    pdfSha256: input.pdfSha256Hex,
    citationsHash: input.citationsHash,
    signingKeyId: input.signingKeyId,
    signingPublicKeyB64: pkB64,
    signatureAlgorithm: 'ed25519',
    signatureScope: 'pdf_and_manifest',
  };
}

// ---------------------------------------------------------------------------
// Public registration helper. Caller (./index.ts) invokes this on the
// shared recommendationsRoute Hono group AFTER the route group's
// middleware stack is in place.
// ---------------------------------------------------------------------------

export function registerRecommendationExportHandlers(group: Hono): void {
  // Re-apply auth + body-limit explicitly on the export paths so the
  // ordering matches the inspections-exports posture. The parent
  // group's middleware already covers these; the redundant install is
  // a noop in practice and keeps the file readable in isolation.
  group.use('/exports', authMiddleware());
  group.use('/exports/*', authMiddleware());
  group.use('/:id/exports', authMiddleware());
  group.use(
    '/:id/exports',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  );
  // The export-specific rate-limit complements the route group's
  // 60/sec bucket — same pattern as the inspections exports sub-route.
  group.use(
    '/exports/*',
    rateLimit({ name: 'recommendations-exports', capacity: 60, refillPerSecond: 10 }),
  );
  group.use(
    '/:id/exports',
    rateLimit({ name: 'recommendations-exports', capacity: 60, refillPerSecond: 10 }),
  );

  // -----------------------------------------------------------------------
  // POST /api/recommendations/:id/exports
  // -----------------------------------------------------------------------

  group.post('/:id/exports', async (c) => {
    const idParsed = uuidParam.safeParse(c.req.param('id'));
    if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
    const recommendationId = idParsed.data;

    const auth = c.get('auth');

    // CSRF belt-and-suspenders even though the global csrfHeaderGuard
    // already covers POST — keep the discipline mirror with the 1.8
    // exports route so a future refactor of the global middleware
    // can't silently drop this gate.
    if (c.req.header('x-requested-with') !== 'jhsc-web') {
      return c.json({ error: 'csrf_required' }, 403);
    }

    // T-R28: step-up freshness floor of 60s. The action string carries
    // the recommendation id so the client's step-up modal can surface
    // WHICH recommendation is being authorized (UX affordance). The
    // server enforces only the (actor, freshness-window) tuple —
    // checkStepUpFreshness ignores the `action` parameter when matching
    // grants. A grant obtained for any prior step-up action within the
    // 60s window WILL be accepted here; true per-action binding is a
    // 1.12 hardening item (sec-F1 close-out;
    // docs/runbooks/recommendations.md §11).
    const action = `recommendation.export.${recommendationId}`;
    const challenge = checkStepUpFreshness(auth, {
      action,
      maxAgeSeconds: 60,
    });
    if (challenge) {
      c.header(
        'WWW-Authenticate',
        `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
      );
      return c.json({ error: 'step_up_required', action: challenge.action }, 401);
    }

    // Per-actor 5/hour rate limit (T-R28 sibling of 1.8 T-I31). After
    // step-up so the bucket isn't drained by unauthorized callers.
    const bucket = consumeActorToken(auth.userId);
    if (!bucket.ok) {
      c.header('Retry-After', String(bucket.retryAfterSeconds));
      return c.json(
        { error: 'export_rate_limited', retryAfterSeconds: bucket.retryAfterSeconds },
        429,
      );
    }

    const db = getDb();

    // Pre-flight state guard: only submitted / response_received /
    // resolved / withdrawn are exportable. Draft cannot be exported —
    // the citations may not be validated, the body may be mid-edit,
    // and the chain of custody for a draft hasn't started. Surfacing
    // a clear 422 here avoids opening the workplace signing key for a
    // request that's structurally guaranteed to be rejected.
    const stateRows = (await db.execute(sql`
      SELECT status FROM recommendations WHERE id = ${recommendationId} LIMIT 1
    `)) as unknown as Array<{ status: string }>;
    if (stateRows.length === 0) return c.json({ error: 'recommendation_not_found' }, 404);
    const status = stateRows[0]!.status;
    if (status === 'draft') {
      return c.json({ error: 'cannot_export_draft', status }, 422);
    }

    // 1.10 (ADR-0009 §3.3): parse the optional clientId body. The body
    // is optional (legacy callers pass nothing); when present, the
    // clientId becomes the canonical export_records.id.
    const rawBody = await c.req.json().catch(() => null);
    const bodyParsed = exportCreateBody.safeParse(rawBody ?? {});
    if (!bodyParsed.success) {
      return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
    }
    const exportClientId = bodyParsed.data.clientId;

    // 1.10 §3.3 ratchet-level idempotency. requested_by_user_id anchors
    // the actor. Same-actor + clientId reuse → 200 with existing row;
    // cross-actor → 409.
    if (exportClientId) {
      const existing = (await db.execute(sql`
        SELECT id, encode(output_sha256, 'hex') AS output_sha256_hex,
               byte_size, audit_idx, expires_at::text AS expires_at,
               requested_by_user_id, encode(signature_sha256, 'hex') AS signature_sha256_hex
        FROM export_records
        WHERE id = ${exportClientId}
        LIMIT 1
      `)) as unknown as Array<{
        id: string;
        output_sha256_hex: string;
        byte_size: string | number;
        audit_idx: number | string;
        expires_at: string;
        requested_by_user_id: string;
        signature_sha256_hex: string | null;
      }>;
      if (existing.length > 0) {
        const row = existing[0]!;
        if (row.requested_by_user_id !== auth.userId) {
          return c.json({ error: 'client_id_conflict' }, 409);
        }
        return c.json(
          {
            exportId: row.id,
            recommendationId,
            outputSha256: row.output_sha256_hex,
            signatureSha256: row.signature_sha256_hex,
            byteSize: Number(row.byte_size),
            chainIdx: Number(row.audit_idx),
            expiresAt: row.expires_at,
          },
          200,
        );
      }
    }

    // Buffers we own and must memzero on every exit path. JS strings
    // (decrypted title / body / response prose) are intentionally
    // omitted — they're immutable and cannot be wiped from the V8 heap
    // (sec-F6 close-out — the dead `allPlaintextBuffers` array from S4
    // was removed for honesty). The buffers we CAN wipe are listed
    // here; each is zeroed in the finally / catch below.
    let renderedBytes: Uint8Array | null = null;
    let zipBytes: Uint8Array | null = null;
    let signaturePrivateKey: Uint8Array | null = null;
    let signature: Uint8Array | null = null;
    let putStorageKey: string | null = null;

    try {
      // 1. Resolve + decrypt + render the PDF inside the bounded window.
      const { renderable, citationsHash } = await resolveRecommendation(recommendationId, db);

      // Pre-allocate exportId so the storage key is stable across PUT +
      // INSERT. 1.10 §3.3: use clientId when supplied.
      const exportId = exportClientId ?? randomUUID();
      const exportedAtIso = new Date().toISOString();

      // 2. Render the PDF. The chainIdx footer is dropped per the 1.8
      //    sec-F8 close-out (paintFooter ignores the field); we still
      //    pass a value so the type contract is honored.
      renderedBytes = await renderRecommendationPdf(renderable, {
        exportId,
        exportedAt: exportedAtIso,
        chainIdx: 0,
        outputSha256Placeholder: '',
        citationsHash,
      });

      // 3. Compute the PDF's SHA-256. This is the chain anchor's
      //    outputSha256 (Option B — see the download handler note).
      const pdfSha256Hex = createHash('sha256').update(renderedBytes).digest('hex');

      // 4. Load the active signing key + open its private key for the
      //    sign operation. Memzero the private key the moment the
      //    sign() returns. The public key is non-secret and survives
      //    on the manifest.
      await sodium.ready;
      const signingKey = await getActiveWorkplaceSigningPublicKey(db);
      if (!signingKey) {
        throw new ExportAborted(500, {
          error: 'workplace_signing_key_missing',
          // No PI — the workplace simply hasn't completed first-run
          // signing-key seed yet.
        });
      }

      // 5. Build the manifest sans signature + its canonical bytes.
      const manifest = buildManifest({
        exportId,
        recommendationId,
        exportedAt: exportedAtIso,
        pdfSha256Hex,
        citationsHash,
        signingKeyId: signingKey.id,
        signingPublicKey: signingKey.publicKey,
      });
      const manifestCanonical = computeManifestSansSigCanonical(manifest);

      // 6. Open the private key + sign + immediately memzero.
      signaturePrivateKey = await openWorkplaceSigningPrivateKey(db, signingKey.id);
      try {
        signature = signRecommendationBundle(renderedBytes, manifestCanonical, signaturePrivateKey);
      } finally {
        sodium.memzero(signaturePrivateKey);
        signaturePrivateKey = null;
      }
      const signatureSha256Hex = createHash('sha256').update(signature).digest('hex');

      // 7. Assemble the deterministic ZIP. After this point the PDF
      //    bytes are embedded in zipBytes; we can drop our local
      //    Uint8Array.
      zipBytes = await buildSignedZipBundle({
        pdfBytes: renderedBytes,
        signature,
        manifest,
      });
      const byteSize = zipBytes.length;

      // (sec-F6 close-out: removed the dead allPlaintextBuffers loop
      // that never had anything pushed to it. JS strings — title,
      // body, response prose — cannot be memzero'd; the file-header
      // discipline section documents the honest stance. The signing
      // private key + DEK Uint8Arrays + the rendered PDF buffer ARE
      // wiped explicitly via sodium.memzero / .fill(0) below.)

      // 8. PUT the ZIP to Tigris BEFORE the DB transaction. A PUT
      //    failure leaves the DB untouched (no chain anchor fires,
      //    no row inserted) — clean abort.
      const storageKey = `exports/${exportId}/recommendation-${recommendationId}-${exportId}.zip`;
      await putEvidenceObject({
        storageKey,
        bytes: zipBytes,
        // T-R33 close-out: application/zip on the recommendation
        // export, never application/pdf. The download handler also
        // sets this; the PUT mime is what Tigris records as
        // Content-Type on the object.
        mimeType: 'application/zip',
      });
      putStorageKey = storageKey;

      // 9. Single transaction: chain anchor + export_records insert.
      //    sec-F6 mirror: if the transaction rolls back, the catch
      //    below DELETEs the orphan storage_key.
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      let result: { exportId: string; chainIdx: number };
      try {
        result = await db.transaction(async (tx) => {
          const chainRow = await append(tx, {
            actorId: auth.userId,
            payload: {
              kind: 'recommendation.exported',
              exportId,
              recommendationId,
              outputSha256: pdfSha256Hex,
              signatureSha256: signatureSha256Hex,
              signingKeyId: signingKey.id,
              citationsHash,
              byteSize,
            },
            resourceType: 'export_records',
            resourceId: exportId,
          });
          const outputShaBytes = Buffer.from(pdfSha256Hex, 'hex');
          const signatureShaBytes = Buffer.from(signatureSha256Hex, 'hex');
          // The export_records.inspection_ids[] column is NOT NULL
          // with a 1..100 cardinality CHECK (migration 0007). For
          // kind='recommendation_single' we land the recommendation
          // id as the sole element of the array — the column's
          // semantic name is "the resources this export bundles"
          // and that's true for both inspection_single and
          // recommendation_single rows. The migration's column-
          // alignment CHECK (migration 0008) covers signing fields
          // but does NOT require inspection_ids to be NULL for the
          // new kind, so this is the path the schema validates.
          await tx.execute(sql`
            INSERT INTO export_records (
              id, kind, inspection_ids, requested_by_user_id, requested_at,
              output_sha256, byte_size, storage_key, step_up_jti,
              expires_at, audit_idx,
              signing_key_id, signature_sha256
            )
            VALUES (
              ${exportId},
              'recommendation_single',
              ARRAY[${recommendationId}]::uuid[],
              ${auth.userId},
              now(),
              ${outputShaBytes as unknown as Uint8Array},
              ${byteSize},
              ${storageKey},
              ${auth.sessionId},
              ${expiresAt}::timestamptz,
              ${chainRow.idx},
              ${signingKey.id},
              ${signatureShaBytes as unknown as Uint8Array}
            )
          `);
          return { exportId, chainIdx: chainRow.idx };
        });
        // Transaction committed; the storage_key is non-orphan.
        putStorageKey = null;
      } catch (txErr) {
        if (putStorageKey) {
          const del = await deleteEvidenceObject(putStorageKey).catch(() => ({ ok: false }));
          console.warn(
            `[recommendations.exports] orphan ZIP cleanup after transaction failure: storageKey=${putStorageKey} ok=${del.ok}`,
          );
          putStorageKey = null;
        }
        throw txErr;
      }

      return c.json({
        exportId: result.exportId,
        recommendationId,
        outputSha256: pdfSha256Hex,
        signatureSha256: signatureSha256Hex,
        signingKeyId: signingKey.id,
        citationsHash,
        byteSize,
        expiresAt,
        chainIdx: result.chainIdx,
      });
    } catch (err) {
      // Memzero the buffers we control on every error path. (sec-F6
      // close-out: removed the dead allPlaintextBuffers loop. JS
      // strings stay in the heap until GC — documented tradeoff.)
      if (signaturePrivateKey) {
        try {
          sodium.memzero(signaturePrivateKey);
        } catch {
          // intentional
        }
      }
      // Outer catch fallback for orphan cleanup (the inner tx try-block
      // covers the common case; this catches an exception thrown
      // between the PUT and the inner try-block).
      if (putStorageKey) {
        const del = await deleteEvidenceObject(putStorageKey).catch(() => ({ ok: false }));
        console.warn(
          `[recommendations.exports] orphan ZIP cleanup after non-tx failure: storageKey=${putStorageKey} ok=${del.ok}`,
        );
      }
      if (err instanceof ExportAborted) {
        return c.json(err.body, err.status as 400 | 404 | 422 | 500);
      }
      throw err;
    } finally {
      // The PDF bytes are not PI per se (they ARE the disclosable
      // artifact) but we wipe them for symmetry with the inspections
      // exports route's discipline. The ZIP bytes likewise.
      if (renderedBytes) {
        try {
          renderedBytes.fill(0);
        } catch {
          // intentional
        }
      }
      if (zipBytes) {
        try {
          zipBytes.fill(0);
        } catch {
          // intentional
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/recommendations/exports/:id/download
  // -----------------------------------------------------------------------

  group.get('/exports/:id/download', async (c) => {
    if (c.req.header('x-requested-with') !== 'jhsc-web') {
      return c.json({ error: 'csrf_required' }, 403);
    }

    const idParsed = uuidParam.safeParse(c.req.param('id'));
    if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

    const auth = c.get('auth');
    // T-R28: 60s step-up freshness floor. The action string is echoed
    // in the WWW-Authenticate challenge header for the client's UX;
    // the server enforces only the (actor, freshness-window) tuple,
    // NOT a per-action binding (sec-F1 close-out — true per-action
    // binding is a 1.12 hardening item documented in
    // docs/runbooks/recommendations.md §11).
    const challenge = checkStepUpFreshness(auth, {
      action: 'recommendation.export.download',
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
    // S5 sec-F3 close-out: pull signature_sha256 alongside the other
    // chain-anchored hashes so we can verify the ZIP's signature.bin
    // against it after extraction.
    const rows = (await db.execute(sql`
      SELECT id, kind, storage_key,
             encode(output_sha256, 'hex') AS output_sha256_hex,
             encode(signature_sha256, 'hex') AS signature_sha256_hex,
             byte_size,
             inspection_ids,
             expires_at::text AS expires_at
      FROM export_records
      WHERE id = ${idParsed.data}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: string;
      storage_key: string;
      output_sha256_hex: string;
      signature_sha256_hex: string;
      byte_size: number;
      inspection_ids: string[];
      expires_at: string;
    }>;
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
    const r = rows[0]!;
    // T-R31 + T-R32: refuse to serve an inspection export through the
    // recommendation download route. The mime-type dispatch (T-R33) is
    // the second line of defense; this is the structural backstop.
    if (r.kind !== 'recommendation_single') {
      return c.json({ error: 'wrong_kind', kind: r.kind }, 422);
    }
    if (new Date(r.expires_at).getTime() < Date.now()) {
      return c.json({ error: 'export_expired' }, 410);
    }

    // Fetch the ZIP from Tigris.
    const zipBytes = await fetchEvidenceCiphertext(r.storage_key);

    // ---------- Option B TOCTOU verify ----------
    //
    // The chain anchor's outputSha256 binds the PDF, not the ZIP. The
    // manifest is the bridge: manifest.pdfSha256 equals the chain's
    // outputSha256 by construction (the create route uses the same
    // value for both). To verify the stored bundle hasn't been
    // tampered with between PUT and this read, we:
    //   1. Parse manifest.json out of the ZIP.
    //   2. Assert manifest.pdfSha256 === export_records.output_sha256
    //      (the chain-anchored hash).
    //   3. Extract recommendation.pdf out of the ZIP.
    //   4. Hash it, assert equal to manifest.pdfSha256.
    //
    // If ANY of those three assertions fails, the ZIP has been
    // mutated server-side (Tigris-side mutation, runbook recovery is
    // re-issue). The chain anchor on the create path is the
    // ground truth.
    //
    // The cleanest way to parse the ZIP without pulling another
    // dependency would be yauzl + a stream collector. To keep the
    // dependency footprint at "yazl only" we hand-parse just the
    // bits we need from the central directory + per-file headers.
    // The bundle is small (low single-digit KB typical for the
    // manifest + PDF + signature + README), so the parse is cheap.
    try {
      const { manifestJson, pdfBytes, signatureBytes } = extractManifestPdfAndSignature(zipBytes);
      const parsed = JSON.parse(manifestJson) as { pdfSha256?: unknown };
      const manifestPdfSha256 = typeof parsed.pdfSha256 === 'string' ? parsed.pdfSha256 : '';
      if (manifestPdfSha256 !== r.output_sha256_hex) {
        return c.json(
          {
            error: 'export_tamper_detected',
            reason: 'manifest_pdf_sha_mismatch',
          },
          500,
        );
      }
      const observedPdfSha = createHash('sha256').update(pdfBytes).digest('hex');
      if (observedPdfSha !== r.output_sha256_hex) {
        return c.json(
          {
            error: 'export_tamper_detected',
            reason: 'pdf_sha_mismatch',
          },
          500,
        );
      }
      // S5 sec-F3 close-out (T-R45): also verify signature.bin's
      // SHA-256 against the chain-anchored signature_sha256. The PDF
      // hash cross-check above catches a swapped PDF; this catches a
      // swapped signature (the "consistent ZIP swap" attack — attacker
      // re-signs with a different private key and rewrites the
      // manifest's pdfSha256 to point at their PDF). A full Ed25519
      // crypto verify on every download is a 1.12 hardening item
      // (verifyRecommendationBundle); the SHA-256 cross-check is the
      // cheap-and-correct close-out per the S5 reviewer.
      const observedSignatureSha = createHash('sha256').update(signatureBytes).digest('hex');
      if (observedSignatureSha !== r.signature_sha256_hex) {
        return c.json(
          {
            error: 'export_signature_tamper_detected',
            reason: 'signature_sha_mismatch',
          },
          500,
        );
      }
    } catch (parseErr) {
      console.warn(
        `[recommendations.exports] failed to parse ZIP for TOCTOU verify: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`,
      );
      return c.json(
        {
          error: 'export_tamper_detected',
          reason: 'zip_parse_failed',
        },
        500,
      );
    }

    // S5 sec-F2 close-out (T-R43): emit a per-download chain anchor
    // AFTER step-up clears AND Tigris fetch succeeds AND the TOCTOU
    // verify (PDF + signature) passes AND BEFORE bytes return. The
    // ordering matters — a failed re-download (404 / 410 / SHA
    // mismatch / signature mismatch / wrong_kind) does NOT anchor;
    // only a successful, integrity-verified download produces a chain
    // row. Mirror of the 1.8 inspection.export.downloaded retrofit.
    // Wrap the append() in a tiny db.transaction so it runs under the
    // chain's serializing advisory-lock pattern.
    const recommendationIdForAnchor = r.inspection_ids[0] ?? r.id;
    await db.transaction(async (tx) => {
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'recommendation.export.downloaded',
          exportId: r.id,
          recommendationId: recommendationIdForAnchor,
          downloadedByUserId: auth.userId,
        },
        resourceType: 'export_records',
        resourceId: r.id,
      });
    });

    // 1.9 priv-F2 / 1.7 sec-F6 + priv-F10 mirror: attachment,
    // application/zip (T-R33), strict CSP sandbox, no-store / no
    // referrer.
    // Pull the recommendation_number for a friendlier filename, falling
    // back to the exportId prefix if the lookup fails. Reuses
    // recommendationIdForAnchor computed above for the chain anchor.
    const recRows = (await db.execute(sql`
      SELECT recommendation_number FROM recommendations
      WHERE id = ${recommendationIdForAnchor} LIMIT 1
    `)) as unknown as Array<{ recommendation_number: number }>;
    const recNumber = recRows[0]?.recommendation_number ?? 0;
    const filename = `jhsc-recommendation-${recNumber}-${r.id.slice(0, 8)}.zip`;

    return new Response(zipBytes.slice().buffer, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store, max-age=0',
        pragma: 'no-cache',
        expires: '0',
        'referrer-policy': 'no-referrer',
        'content-length': String(zipBytes.length),
      },
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/recommendations/exports  — list (metadata only)
  // -----------------------------------------------------------------------

  group.get('/exports', async (c) => {
    void c; // satisfy the unused-arg lint in case a future ctx-free overload lands
    const db = getDb();
    // No step-up gate on the metadata list (matches inspections + 1.7
    // evidence-list posture); ZIP bytes are gated by the download
    // route. Filter to kind='recommendation_single' so this view does
    // not surface inspection export rows.
    const rows = (await db.execute(sql`
      SELECT id,
             inspection_ids[1] AS recommendation_id,
             requested_by_user_id,
             requested_at::text AS requested_at,
             encode(output_sha256, 'hex') AS output_sha256,
             encode(signature_sha256, 'hex') AS signature_sha256,
             signing_key_id,
             byte_size,
             expires_at::text AS expires_at
      FROM export_records
      WHERE kind = 'recommendation_single'
      ORDER BY requested_at DESC
      LIMIT 200
    `)) as unknown as Array<{
      id: string;
      recommendation_id: string;
      requested_by_user_id: string;
      requested_at: string;
      output_sha256: string;
      signature_sha256: string;
      signing_key_id: string;
      byte_size: number;
      expires_at: string;
    }>;
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        recommendationId: r.recommendation_id,
        requestedByUserId: r.requested_by_user_id,
        requestedAt: r.requested_at,
        outputSha256: r.output_sha256,
        signatureSha256: r.signature_sha256,
        signingKeyId: r.signing_key_id,
        byteSize: Number(r.byte_size),
        expiresAt: r.expires_at,
      })),
    });
  });
}

// ---------------------------------------------------------------------------
// Tiny embedded ZIP reader. Parses the End-of-Central-Directory record
// + per-entry central-directory headers + local-file headers to
// extract `manifest.json` and `recommendation.pdf`. Only handles the
// subset we produce (store mode, no Zip64, no encryption). Used only
// by the download handler's TOCTOU verify; the bundle is small so the
// O(n) scan is fine.
//
// We avoid taking a dependency on yauzl/adm-zip/etc. for two reasons:
//   - yauzl is a peer of yazl but adds 60 KB to the bundle.
//   - adm-zip's API is sync but its DEFLATE path injects timestamps
//     during read in some versions, breaking deterministic hashing of
//     extracted bytes.
// A small custom parser keeps the dependency surface tight and the
// behavior reviewable in one file.
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50; // PK\x05\x06
const CD_HEADER_SIGNATURE = 0x02014b50; // PK\x01\x02
const LFH_SIGNATURE = 0x04034b50; // PK\x03\x04

function readU16(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}
function readU32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

function findEocd(buf: Uint8Array): number {
  // EOCD is at the end of the file; scan backwards from the last 22
  // bytes (the minimum EOCD size). Comment field max 64KB; we cap the
  // scan at 64KB + 22 bytes to bound the loop.
  const maxScan = Math.min(buf.length, 64 * 1024 + 22);
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (readU32(buf, i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('EOCD record not found');
}

interface ParsedEntry {
  readonly name: string;
  readonly localHeaderOffset: number;
  readonly compressedSize: number;
  readonly compressionMethod: number;
}

function parseCentralDirectory(buf: Uint8Array): ParsedEntry[] {
  const eocdAt = findEocd(buf);
  const cdSize = readU32(buf, eocdAt + 12);
  const cdOffset = readU32(buf, eocdAt + 16);
  const entries: ParsedEntry[] = [];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    if (readU32(buf, p) !== CD_HEADER_SIGNATURE) {
      throw new Error(`central directory header signature missing at offset ${p}`);
    }
    const compressionMethod = readU16(buf, p + 10);
    const compressedSize = readU32(buf, p + 20);
    const nameLen = readU16(buf, p + 28);
    const extraLen = readU16(buf, p + 30);
    const commentLen = readU16(buf, p + 32);
    const localHeaderOffset = readU32(buf, p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    entries.push({ name, localHeaderOffset, compressedSize, compressionMethod });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryBytes(buf: Uint8Array, entry: ParsedEntry): Uint8Array {
  if (readU32(buf, entry.localHeaderOffset) !== LFH_SIGNATURE) {
    throw new Error(`local file header signature missing for ${entry.name}`);
  }
  // Local-file header is: 30 bytes + nameLen + extraLen, then data.
  const lhNameLen = readU16(buf, entry.localHeaderOffset + 26);
  const lhExtraLen = readU16(buf, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + lhNameLen + lhExtraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (entry.compressionMethod !== 0) {
    // The bundle builder uses store mode (compress: false) → method 0.
    // Anything else means the bundle was repacked by a third party
    // and is no longer the bytes the chain anchor binds.
    throw new Error(`unexpected compression method ${entry.compressionMethod} for ${entry.name}`);
  }
  return buf.subarray(dataStart, dataEnd);
}

function extractManifestAndPdf(zipBytes: Uint8Array): {
  manifestJson: string;
  pdfBytes: Uint8Array;
} {
  const entries = parseCentralDirectory(zipBytes);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  const pdfEntry = entries.find((e) => e.name === 'recommendation.pdf');
  if (!manifestEntry) throw new Error('manifest.json not in bundle');
  if (!pdfEntry) throw new Error('recommendation.pdf not in bundle');
  const manifestBytes = readEntryBytes(zipBytes, manifestEntry);
  const pdfBytes = readEntryBytes(zipBytes, pdfEntry);
  return {
    manifestJson: new TextDecoder('utf-8').decode(manifestBytes),
    pdfBytes: new Uint8Array(pdfBytes),
  };
}

// S5 sec-F3 close-out: extended extractor that also returns the
// signature.bin entry. The 64-byte Ed25519 detached signature lives at
// a fixed entry name in the deterministic ZIP. We hash it and
// cross-check against export_records.signature_sha256 in the download
// handler.
function extractManifestPdfAndSignature(zipBytes: Uint8Array): {
  manifestJson: string;
  pdfBytes: Uint8Array;
  signatureBytes: Uint8Array;
} {
  const entries = parseCentralDirectory(zipBytes);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  const pdfEntry = entries.find((e) => e.name === 'recommendation.pdf');
  const signatureEntry = entries.find((e) => e.name === 'signature.bin');
  if (!manifestEntry) throw new Error('manifest.json not in bundle');
  if (!pdfEntry) throw new Error('recommendation.pdf not in bundle');
  if (!signatureEntry) throw new Error('signature.bin not in bundle');
  const manifestBytes = readEntryBytes(zipBytes, manifestEntry);
  const pdfBytes = readEntryBytes(zipBytes, pdfEntry);
  const signatureBytes = readEntryBytes(zipBytes, signatureEntry);
  return {
    manifestJson: new TextDecoder('utf-8').decode(manifestBytes),
    pdfBytes: new Uint8Array(pdfBytes),
    signatureBytes: new Uint8Array(signatureBytes),
  };
}

// Re-export for the unit test surface — the route doesn't use these
// directly but the test asserts the parser handles our own bundles.
export const _internalsForTests = {
  extractManifestAndPdf,
  extractManifestPdfAndSignature,
  parseCentralDirectory,
  buildManifest,
  canonicalJsonStringify,
};
