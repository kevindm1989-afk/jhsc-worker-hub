// Action-item closure verification enums + Zod schemas
// (Milestone 2.2, ADR-0013 §3.5).
//
// Closure verification is the JHSC counter-sign moment for an action
// item moving to `Status = 'Closed'`. The shape parallels the M2.1
// meeting_signatures pattern but is scoped to a single action item.
//
// This module is shared-types ONLY — no DB code, no crypto helpers,
// no I/O. The route Zod schemas (S2) will reference the enums here.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reopen reason — enumerated; never free text. The chain payload
// `action_item.reopened` carries this enum value (no PI, no narrative).
// ---------------------------------------------------------------------------

export const actionItemReopenReason = ['rep_decision', 'jhsc_review', 'mgmt_appeal'] as const;
export type ActionItemReopenReason = (typeof actionItemReopenReason)[number];
export const actionItemReopenReasonSchema = z.enum(actionItemReopenReason);

// ---------------------------------------------------------------------------
// Closure verification row shape — minimal Zod schema for the route
// request body validation (S2 owns the full route surface). The schema
// here is the closure-attestation INSERT shape modulo server-side fields
// (id, attestation_signed_ct, signing_key_id, created_at).
// ---------------------------------------------------------------------------

/**
 * Hex SHA-256 digest — 64 lowercase hex chars. Used for the
 * closureReasonHash + evidenceHash fields in the chain payload.
 */
const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'sha256 hex digest must be 64 lowercase hex chars');

/**
 * Closure rationale envelope (sealed-box, no plaintext fields).
 * Pair-NULL contract: both bytes present or both null.
 */
export const actionItemClosureReasonEnvelopeSchema = z.object({
  // Base64-encoded ciphertext (route layer transcodes to bytea).
  ciphertextB64: z.string().min(1).max(8192),
  dekCiphertextB64: z.string().min(1).max(256),
});
export type ActionItemClosureReasonEnvelope = z.infer<typeof actionItemClosureReasonEnvelopeSchema>;

/**
 * Optional evidence envelope. Mirrors the 1.7 Tigris client-side-
 * encrypt pattern: the rep uploads the encrypted blob to Tigris
 * directly via presign; the API stores the storage key + the
 * envelope ct/dek (so the row can decrypt the blob server-side
 * when generating the closure record PDF in M2.3).
 */
export const actionItemClosureEvidenceSchema = z.object({
  storageKey: z
    .string()
    .min(1)
    .max(512)
    // Mirrors the M2.1 F-L1 Tigris key regex discipline (per
    // meeting_signatures.evidence_storage_key shape).
    .regex(/^[A-Za-z0-9._/-]+$/, 'invalid storage key'),
  envelopeCtB64: z.string().min(1).max(65536),
  envelopeDekCtB64: z.string().min(1).max(256),
});
export type ActionItemClosureEvidence = z.infer<typeof actionItemClosureEvidenceSchema>;

/**
 * The chain payload's evidenceHash field shape. Surfaces as null when
 * no evidence is attached.
 */
export const actionItemClosureEvidenceHashSchema = sha256HexSchema.nullable();
export type ActionItemClosureEvidenceHash = z.infer<typeof actionItemClosureEvidenceHashSchema>;

// Re-exported for the audit-payload union in `./index.ts`.
export const actionItemClosureReasonHashSchema = sha256HexSchema;
export const actionItemClosureAttestationSigHashSchema = sha256HexSchema;
