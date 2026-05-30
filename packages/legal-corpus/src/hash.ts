// Body hash for ADR-0003 historical anchoring.
//
// body_hash = SHA-256(body || version_date.toISOString())
//
// The version_date in ISO-8601 form (YYYY-MM-DD) is what Postgres returns
// for a `date` column read through node-postgres or postgres-js; we accept
// either a `Date` or a YYYY-MM-DD string so the hash is byte-identical
// whether computed in the seeder (Date), in a recommendation-write path
// (the picker passes a Date), or in the verify script (reads the column
// as a string).

import { createHash } from 'node:crypto';

export function normalizeVersionDate(d: Date | string): string {
  if (typeof d === 'string') {
    // Accept 'YYYY-MM-DD' verbatim; reject anything else explicitly so we
    // don't paper over a bug that would silently shift the anchor.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`version_date must be YYYY-MM-DD, got: ${d}`);
    }
    return d;
  }
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function computeBodyHash(body: string, versionDate: Date | string): Uint8Array {
  const dateStr = normalizeVersionDate(versionDate);
  const h = createHash('sha256');
  h.update(body, 'utf8');
  h.update(dateStr, 'utf8');
  return new Uint8Array(h.digest());
}

export function bodyHashHex(body: string, versionDate: Date | string): string {
  return Buffer.from(computeBodyHash(body, versionDate)).toString('hex');
}
