// Pure recipient-hash canonicalization for minutes distributions
// (Milestone 2.3, ADR-0014 TM-fold-3 — T-MD18 / T-MD23 / T-MD37).
//
// The chain payload carries recipientHash (NEVER the recipient's
// plaintext display name) per the T-AC9-class invariant. This module
// computes the canonical hash so the route layer + a future verifier
// produce identical bytes for the same logical recipient.
//
// Canonicalization shape:
//   sha256_hex(canonical_json({role, displayName, method}))
// where canonical_json uses alphabetically-sorted keys (the same
// recipe as @jhsc/audit canonicalJsonStringify).
//
// What enters:
//   - role        — the 9-value MinutesDocumentRecipientRole enum
//   - displayName — the decrypted recipient name (server-side only,
//                   inside the bounded private-key window; memzero'd
//                   before this function returns)
//   - method      — the 4-value MinutesDocumentSentMethod enum
//
// What does NOT enter:
//   - sent_at    — the rep's recorded send time; a re-send to the
//                  same recipient at a different time produces the
//                  same recipient_hash (the chain anchors each send
//                  event independently via distributionId)
//   - notes      — none in the schema; would be encrypted-only anyway
//   - documentId — the distribution row's document_id is FK + a
//                  separate chain payload field
//
// Pure function; no I/O.

import { createHash } from 'node:crypto';
import type { MinutesDocumentRecipientRole, MinutesDocumentSentMethod } from '@jhsc/shared-types';

export interface RecipientHashInput {
  readonly role: MinutesDocumentRecipientRole;
  readonly displayName: string;
  readonly method: MinutesDocumentSentMethod;
}

/**
 * Stable stringifier — JSON.stringify with alphabetically-sorted keys.
 * Mirrors the @jhsc/audit canonicalJsonStringify recipe; this module
 * does not depend on @jhsc/audit because the hashed object is a fixed
 * 3-field record, not an arbitrary AuditPayload.
 */
function canonicalRecipientJson(input: RecipientHashInput): string {
  const ordered: Record<string, string> = {
    displayName: input.displayName,
    method: input.method,
    role: input.role,
  };
  return JSON.stringify(ordered);
}

/**
 * Compute the chain-payload-safe recipient hash. Returns 64 lowercase
 * hex chars; the DB CHECK on minutes_distributions.recipient_hash
 * enforces the same shape.
 */
export function computeRecipientHash(input: RecipientHashInput): string {
  const canonical = canonicalRecipientJson(input);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
