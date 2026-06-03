// content_hash canonicalization for Excel-import reconciliation.
//
// Per ADR-0010 §3.6 and CLAUDE.md Excel Import Rule 5:
//   "Same Description + Start Date = same item across imports."
//
// The content_hash is the deterministic dedup key. Re-uploading the
// same workbook yields the same hashes for unchanged rows; the
// reconciler classifies those as `skipped` and the import is idempotent.
//
// The canonicalization is intentionally lossy in a documented, narrow
// way (NFC + trim + collapse-whitespace + lowercase). Each rule has a
// reason:
//
//   - NFC: an Excel cell typed on macOS may use decomposed combining
//     characters (NFD) while the same string typed on Windows uses
//     composed (NFC). Without normalization the two would hash
//     differently. ICU's NFC mapping is stable across V8/SpiderMonkey/
//     WebKit per Unicode 15.x; documented residual in SECURITY T-X21.
//   - trim + collapse-whitespace: a rep who pasted from a richer source
//     (Word, an email body) may carry stray double-spaces or
//     leading/trailing whitespace. Two reps editing the same line in
//     different sessions should reconcile as the same row.
//   - lowercase: the rep's case choice is rep-specific; reconciliation
//     should not be sensitive to it. The original (pre-canonical)
//     description is what the action_item stores; the canonical form
//     is only used to derive the hash.
//
// The function is pure and deterministic — no side effects, no IO,
// no `Date.now()`. Web Crypto's `crypto.subtle.digest` is the only
// runtime dependency (available in browsers and Node 20+).
//
// SECURITY mapping (SECURITY.md §2.11):
//   T-X21 — canonicalization drift across runtime versions
//   T-X22 — section is intentionally orthogonal to identity
//   T-X12 — empty canonical inputs are rejected

const WHITESPACE_RE = /\s+/g;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Canonicalize a description string for content_hash derivation.
 *
 * `s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()`
 *
 * Pure function. Non-mutating. Documented per ADR-0010 §3.6.
 *
 * Throws on null/undefined; an empty-after-canonicalization input is
 * NOT thrown here — the caller's content_hash computation in
 * `computeContentHash` enforces non-empty (T-X12 fail-closed).
 */
export function canonicalizeDescription(input: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(`canonicalizeDescription: expected string, got ${typeof input}`);
  }
  return input.normalize('NFC').trim().replace(WHITESPACE_RE, ' ').toLowerCase();
}

/**
 * Canonicalize a start_date input to the ISO YYYY-MM-DD form.
 *
 * Accepts:
 *   - A `Date` object — interpreted in UTC, formatted YYYY-MM-DD.
 *   - A string in YYYY-MM-DD form — passed through after calendar
 *     validation (rejects `2024-13-45`).
 *   - A string the platform's Date parser accepts (ISO timestamp,
 *     YYYY/MM/DD, Excel-shape) — re-parsed into a Date then formatted.
 *
 * Rejects:
 *   - empty/whitespace-only strings
 *   - invalid Date values (NaN)
 *   - non-numeric or out-of-range month/day in YYYY-MM-DD strings
 *
 * Throws on rejection so the per-row parser surfaces the failure in
 * `import_warnings` (S2 wires the catch).
 *
 * NOTE: Excel-serial dates (the 1900/1904 epoch numeric form) are NOT
 * accepted here directly — SheetJS's `raw: false` returns formatted
 * strings, which this function then parses. Calling code that gets a
 * raw serial integer must convert via SheetJS's date helper first.
 */
export function canonicalizeStartDate(input: string | Date): string {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new TypeError('canonicalizeStartDate: invalid Date (NaN)');
    }
    return formatDateUTC(input);
  }
  if (typeof input !== 'string') {
    throw new TypeError(`canonicalizeStartDate: expected string or Date, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new TypeError('canonicalizeStartDate: empty string');
  }
  // Fast path: already YYYY-MM-DD. Calendar-validate so '2024-13-45'
  // rejects rather than passing through as a literal.
  if (ISO_DATE_RE.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map((n) => Number.parseInt(n, 10)) as [
      number,
      number,
      number,
    ];
    // Construct a UTC Date and round-trip it: any out-of-range month/day
    // gets normalized by JS, so if the round-trip doesn't match the
    // input it was out of range.
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(dt.getTime())) {
      throw new TypeError(`canonicalizeStartDate: invalid date ${trimmed}`);
    }
    const roundTripped = formatDateUTC(dt);
    if (roundTripped !== trimmed) {
      throw new TypeError(`canonicalizeStartDate: out-of-range date ${trimmed}`);
    }
    return trimmed;
  }
  // Slow path: try platform parsing for ISO timestamps with a time
  // component, or other Excel-shape strings the platform recognizes.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`canonicalizeStartDate: unparseable date ${trimmed}`);
  }
  return formatDateUTC(parsed);
}

function formatDateUTC(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute the SHA-256 content_hash for a parsed action_item row.
 *
 *   content_hash = sha256(canonical(description) || '|' || canonical(start_date))
 *
 * The pipe separator prevents (description='a b', date='c') from
 * colliding with (description='a', date='b c'). Returns the 32-byte
 * digest as a Uint8Array.
 *
 * Throws if either canonical input is empty (T-X12 fail-closed). The
 * caller's per-row parser is expected to have already validated that
 * description is non-empty and start_date is parseable; this is the
 * second-line backstop.
 *
 * Pure async function (the only `await` is `crypto.subtle.digest`).
 * Identical inputs MUST produce identical output across runtimes
 * (T-X21 documented invariant).
 */
export async function computeContentHash(
  description: string,
  startDate: string | Date,
): Promise<Uint8Array> {
  const canonDesc = canonicalizeDescription(description);
  if (canonDesc === '') {
    throw new Error('computeContentHash: canonicalized description is empty');
  }
  const canonDate = canonicalizeStartDate(startDate);
  // canonicalizeStartDate already rejects empty / NaN so this is
  // defense in depth — a future change to the canonicalization that
  // accidentally allowed an empty result would still trip here.
  if (canonDate === '') {
    throw new Error('computeContentHash: canonicalized start_date is empty');
  }
  const payload = `${canonDesc}|${canonDate}`;
  const encoded = new TextEncoder().encode(payload);
  // Detach into a plain ArrayBuffer view — newer @types/dom narrows
  // BufferSource to exclude SharedArrayBuffer-backed Uint8Arrays. This
  // matches the same pattern in apps/web/src/evidence/crypto.ts.
  const copy = new Uint8Array(encoded.length);
  copy.set(encoded);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(digest);
}

/**
 * Render a 32-byte content_hash as a 64-char lowercase hex string.
 *
 * Hex is the canonical wire form for the chain anchor payload + the
 * `excel_import_items.content_hash` column inspection in audit-log-
 * verify; the bytea column itself stores the raw 32 bytes.
 */
export function contentHashHex(hash: Uint8Array): string {
  if (hash.length !== 32) {
    throw new TypeError(`contentHashHex: expected 32 bytes, got ${hash.length}`);
  }
  let out = '';
  for (let i = 0; i < hash.length; i++) {
    out += hash[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
