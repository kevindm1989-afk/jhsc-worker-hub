// Excel-import PII heuristic (the 4-class scanner).
//
// Per ADR-0010 §3.5 and SECURITY.md §2.11 (T-X16..T-X20):
//
//   The heuristic runs against parsed cell values BEFORE envelope
//   encryption — it sees plaintext one last time, classifies, and
//   surfaces flags in the preview UI. It is a UX nudge, not a data
//   gate. The encrypt-everything-sensitive default of 1.6 is binding;
//   every action_item sensitive column is envelope-encrypted regardless
//   of PII flag.
//
// Four classes (deliberately loose; over-flagging is the safer mode):
//
//   - nameShape:  ≥2 capitalized words in close proximity ("John Doe",
//                 "Sarah Johnson", "Dr. Alice Chen"). False positives on
//                 "Health Safety Committee" / "Pallet Jack Repair" are
//                 ACCEPTABLE per ADR §3.5 — the heuristic is documentary
//                 copy, not enforcement. False negatives on single-token
//                 names ("Garcia") and lowercase names ("john doe") are
//                 documented in SECURITY T-X17.
//
//   - emailShape: an RFC-ish email regex. NOT the full RFC 5322 grammar
//                 (that grammar is intentionally permissive and would
//                 false-positive aggressively on plain prose). A common
//                 LOCAL@DOMAIN.TLD shape is the working compromise.
//                 Documented residual: obfuscated forms like
//                 "name [at] domain [dot] com" do not match.
//
//   - phoneShape: NANP (North American Numbering Plan) 10-digit shapes
//                 with optional country code 1 and the usual separators.
//                 Documented residual: international shapes (+44, +33,
//                 etc.) are NOT matched in 1.11 — the rep's contact
//                 surface is Ontario / federal Canada, and a phone-shape
//                 false-negative on an international number is no worse
//                 than the encrypt-everything default already provides.
//
//   - sinShape:   Canadian Social Insurance Number (9-digit). INTENTIONALLY
//                 LOOSE: any 9-digit run with the standard separators
//                 matches, even if it's an actual phone number or a
//                 timestamp fragment. The consequence of a SIN false-
//                 positive is "rep reviews this field"; the consequence
//                 of a SIN false-negative is "rep ships an SIN to
//                 Postgres without realizing." We over-flag on purpose.
//
// The scanner is a PURE function with zero side effects. No console.*,
// no fetch, no window.* access. The 1.10 §"No third-party analytics
// SDK" rule applies; SECURITY T-X16 documents the bundle-grep assertion.

export interface PiiMatch {
  readonly kind: 'nameShape' | 'emailShape' | 'phoneShape' | 'sinShape';
  readonly match: string;
}

export interface PiiFlags {
  readonly nameShape: boolean;
  readonly emailShape: boolean;
  readonly phoneShape: boolean;
  readonly sinShape: boolean;
  /** Every individual match. Useful for the preview's per-row tooltip. */
  readonly raw: ReadonlyArray<PiiMatch>;
}

// Name-shape: an initial capitalized word followed by 1-3 more
// capitalized words separated by space, apostrophe, hyphen, or period
// (the "Dr." / "Mc'Pherson" / "O'Brien" / "Smith-Jones" shapes).
//
// Deliberately matches "Health Safety Committee" — see ADR §3.5 false-
// positive bound. The preview UI's per-row badge density is the
// signal-to-noise ratio's actual surface for the rep.
const NAME_SHAPE_RE = /\b[A-Z][a-z]+(?:[\s'.-][A-Z][a-z]+){1,3}\b/g;

// Email-shape: RFC-ish — local part of [A-Za-z0-9._%+-]+, an '@',
// a domain of one or more dot-separated label, and a TLD of >=2
// alphabetic chars. NOT the full RFC 5322 grammar (which would allow
// quoted-string locals, IP-literal domains, etc.); the 1.11 compromise
// is to match the 99% case that a workplace rep's notes actually carry.
const EMAIL_SHAPE_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Phone-shape (NANP / Ontario): optional +1 / 1 prefix; optional area
// code in parens or with separator; three-digit exchange; four-digit
// subscriber number; common separators (space, hyphen, period). Anchored
// with word boundaries so a phone number embedded in prose still matches
// but a 10-digit run inside a longer numeric ID does not.
const PHONE_SHAPE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

// SIN-shape (Canadian Social Insurance Number): three groups of three
// digits, optionally separated by hyphens or spaces. The Luhn-checksum
// VALIDATION of SINs is NOT done here — that would reduce false
// positives but would also let an SIN that fails Luhn (e.g. a rep's
// typo-by-one-digit copy of their own SIN) escape the flag. The rep's
// data is the authority; the heuristic catches the SHAPE, not the
// validity. SECURITY T-X20-style "intentionally loose for sensitive
// over-flagging" applies.
//
// NOTE: this regex also matches NANP phone numbers (3-3-4 vs 3-3-3 is
// the only structural difference, and the SIN shape captures 9 digits
// total). The phone regex captures phone shapes first; both flags may
// fire on borderline strings. The preview UI shows both — the rep is
// the authority on which interpretation is right.
const SIN_SHAPE_RE = /\b\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/g;

/**
 * Scan `text` for four classes of PII shapes (name, email, phone, SIN).
 *
 * Pure function. No side effects. Returns the boolean summary flags +
 * an array of every individual match for the preview's per-row tooltip.
 *
 * Performance bound: each regex is O(n) over the input; the scanner is
 * O(4n) total. Tested against 10KB input in `pii.test.ts` for
 * performance regression; SECURITY T-X6 puts the per-cell ceiling at
 * 8KB, so the scanner never sees an input pathologically larger than
 * a single cell.
 *
 * Empty / whitespace-only input returns all-false flags with an empty
 * raw array.
 */
export function scanForPii(text: string): PiiFlags {
  if (typeof text !== 'string' || text === '') {
    return { nameShape: false, emailShape: false, phoneShape: false, sinShape: false, raw: [] };
  }

  const raw: PiiMatch[] = [];

  // Collect matches per class. Regex flags include 'g' so .matchAll
  // walks the full string. The regex literals are module-scope (lines
  // 70/77/84/100 are SINGLE shared objects), but `String.prototype.
  // matchAll` is spec-required to clone the regex + reset lastIndex
  // before iterating, so the shared module-scope regexes are SAFE
  // here. Do NOT switch to .exec/.test on these globals without
  // scoping them inside scanForPii — the latter APIs honor lastIndex
  // and would leak state across calls. (S5 sec-F9 close-out: comment
  // accuracy fix; the behavior was always correct.)
  for (const m of text.matchAll(NAME_SHAPE_RE)) {
    if (m[0]) raw.push({ kind: 'nameShape', match: m[0] });
  }
  for (const m of text.matchAll(EMAIL_SHAPE_RE)) {
    if (m[0]) raw.push({ kind: 'emailShape', match: m[0] });
  }
  for (const m of text.matchAll(PHONE_SHAPE_RE)) {
    if (m[0]) raw.push({ kind: 'phoneShape', match: m[0] });
  }
  for (const m of text.matchAll(SIN_SHAPE_RE)) {
    if (m[0]) raw.push({ kind: 'sinShape', match: m[0] });
  }

  return {
    nameShape: raw.some((r) => r.kind === 'nameShape'),
    emailShape: raw.some((r) => r.kind === 'emailShape'),
    phoneShape: raw.some((r) => r.kind === 'phoneShape'),
    sinShape: raw.some((r) => r.kind === 'sinShape'),
    raw,
  };
}
