import { describe, expect, it } from 'vitest';
import { scanForPii } from './pii';

describe('scanForPii — nameShape', () => {
  it('detects a simple two-word name', () => {
    const r = scanForPii('Reported by John Doe at 3pm');
    expect(r.nameShape).toBe(true);
    expect(r.raw.some((m) => m.kind === 'nameShape' && m.match === 'John Doe')).toBe(true);
  });

  it('detects a multi-word name (3+ tokens)', () => {
    const r = scanForPii('Witness was Sarah Johnson Marie Chen');
    expect(r.nameShape).toBe(true);
  });

  it('detects a name with a title (Dr. Alice Chen)', () => {
    const r = scanForPii('Spoke to Dr. Alice Chen about the corrective action');
    expect(r.nameShape).toBe(true);
  });

  it('detects a hyphenated surname (Smith-Jones)', () => {
    const r = scanForPii('Mary Smith-Jones signed the form');
    expect(r.nameShape).toBe(true);
  });

  it('FALSE POSITIVE (documented per ADR §3.5): lone "John" surrounded by lowercase prose stays false', () => {
    // A single capitalized word with no neighbouring capitalized words
    // is NOT a name shape — the heuristic requires ≥2 capitalized
    // words in close proximity, so a lone given-name in lowercase prose
    // is a true negative. This case is documented because the rep may
    // intuit the opposite (that any capitalized name should flag); the
    // bound is documented in ADR §3.5 + the rep is the authority.
    const r = scanForPii('quoted john verbatim from the report');
    expect(r.nameShape).toBe(false);
  });

  it('FALSE POSITIVE (documented per ADR §3.5): "Health Safety Committee" reads as a name-shape', () => {
    // The heuristic over-flags on capitalized two/three-word phrases
    // that are organizational nouns, not people. The preview UI's
    // tolerance for this is documented in ADR §3.5 / SECURITY T-X18.
    const r = scanForPii('The Health Safety Committee approved the policy');
    expect(r.nameShape).toBe(true);
  });

  it('FALSE NEGATIVE (documented per ADR §3.5): single-token surname "Garcia" misses', () => {
    // The heuristic requires ≥2 capitalized words in close proximity;
    // a lone surname does not trigger. The rep is the authority and
    // the encrypt-everything-sensitive default catches this anyway.
    const r = scanForPii('Garcia reported the incident');
    expect(r.nameShape).toBe(false);
  });

  it('FALSE NEGATIVE (documented per ADR §3.5): lowercase "john doe" misses', () => {
    const r = scanForPii('reported by john doe');
    expect(r.nameShape).toBe(false);
  });
});

describe('scanForPii — emailShape', () => {
  it('detects a standard email', () => {
    const r = scanForPii('contact ops@example.com for follow-up');
    expect(r.emailShape).toBe(true);
    expect(r.raw.some((m) => m.kind === 'emailShape' && m.match === 'ops@example.com')).toBe(true);
  });

  it('detects an email with plus-aliasing and dots in the local part', () => {
    const r = scanForPii('alice.smith+jhsc@example.org sent the document');
    expect(r.emailShape).toBe(true);
  });

  it('FALSE NEGATIVE (documented): obfuscated "name [at] domain [dot] com" misses', () => {
    // SECURITY T-X17 documents this residual; the rep's encrypt-
    // everything default catches it anyway.
    const r = scanForPii('reach me at name [at] example [dot] com');
    expect(r.emailShape).toBe(false);
  });
});

describe('scanForPii — phoneShape (NANP / Ontario)', () => {
  it('detects (416) 555-0123 style', () => {
    const r = scanForPii('Call (416) 555-0123 if questions');
    expect(r.phoneShape).toBe(true);
  });

  it('detects 416-555-0123 style', () => {
    const r = scanForPii('Phone 416-555-0123 to confirm');
    expect(r.phoneShape).toBe(true);
  });

  it('detects 1-800-555-0123 style', () => {
    const r = scanForPii('Reach the hotline at 1-800-555-0123');
    expect(r.phoneShape).toBe(true);
  });

  it('detects bare-10-digit 4165550123 style', () => {
    const r = scanForPii('Saved 4165550123 in my contacts');
    expect(r.phoneShape).toBe(true);
  });
});

describe('scanForPii — sinShape (intentionally loose)', () => {
  it('detects 123-456-789 style', () => {
    const r = scanForPii('SIN 123-456-789 was on the form');
    expect(r.sinShape).toBe(true);
  });

  it('detects 123 456 789 style with spaces', () => {
    const r = scanForPii('SIN 123 456 789 on the file');
    expect(r.sinShape).toBe(true);
  });

  it('detects 123456789 bare 9-digit (over-flags on purpose per T-X18)', () => {
    // A bare 9-digit run gets flagged even though it could be a
    // timestamp fragment or a part number. The over-flag is the
    // safer mode per ADR §3.5.
    const r = scanForPii('Reference 123456789 in the report');
    expect(r.sinShape).toBe(true);
  });
});

describe('scanForPii — multi-class + boundary cases', () => {
  it('detects multiple classes in one input', () => {
    const r = scanForPii('John Doe (ops@example.com, 416-555-0123) reported it');
    expect(r.nameShape).toBe(true);
    expect(r.emailShape).toBe(true);
    expect(r.phoneShape).toBe(true);
    expect(r.sinShape).toBe(false);
  });

  it('returns all-false for an empty input', () => {
    const r = scanForPii('');
    expect(r.nameShape).toBe(false);
    expect(r.emailShape).toBe(false);
    expect(r.phoneShape).toBe(false);
    expect(r.sinShape).toBe(false);
    expect(r.raw).toEqual([]);
  });

  it('returns all-false for whitespace-only input', () => {
    const r = scanForPii('   \n  \t  ');
    expect(r.nameShape).toBe(false);
    expect(r.emailShape).toBe(false);
    expect(r.phoneShape).toBe(false);
    expect(r.sinShape).toBe(false);
  });

  it('returns all-false for non-string input (defensive guard)', () => {
    // @ts-expect-error — defense against a buggy caller passing null.
    const r = scanForPii(null);
    expect(r.nameShape).toBe(false);
    expect(r.raw).toEqual([]);
  });

  it('performance: scans 10KB of text in well under a second', () => {
    // Build a 10KB string with one name and one email near the end so
    // the regex engines have to walk most of the input.
    const filler = 'lorem ipsum dolor sit amet '.repeat(370); // ~9.9KB
    const input = `${filler} John Doe (john@example.com)`;
    expect(input.length).toBeGreaterThan(10_000);
    const start = Date.now();
    const r = scanForPii(input);
    const elapsedMs = Date.now() - start;
    expect(r.nameShape).toBe(true);
    expect(r.emailShape).toBe(true);
    // 1s is a generous ceiling; in practice this runs in single-digit ms.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('multiple matches of same kind are all captured in raw', () => {
    const r = scanForPii('John Doe and Jane Smith met with ops@example.com');
    const nameMatches = r.raw.filter((m) => m.kind === 'nameShape');
    expect(nameMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('purity: scanning the same text twice returns identical raw arrays', () => {
    const text = 'John Doe ops@example.com';
    const a = scanForPii(text);
    const b = scanForPii(text);
    expect(a.raw.map((m) => m.match)).toEqual(b.raw.map((m) => m.match));
  });

  it('purity: scan does not mutate the input string', () => {
    const text = 'John Doe ops@example.com';
    const before = text;
    scanForPii(text);
    expect(text).toBe(before);
  });
});

// S5 priv-F5 close-out: the heuristic now runs against the source
// filename, the Minutes attendance string, and the joined Inspection
// Review snapshot in addition to the four per-row action_item fields.
// These tests assert the scanner handles those input shapes correctly
// (and that empty / whitespace-only input returns clean flags).
describe('scanForPii — extended-surface input shapes (S5 priv-F5)', () => {
  it('scans a filename string + flags workplace-name-shape', () => {
    // The heuristic's name-shape regex requires capitalized words with
    // lowercase tails (e.g. "Acme Foods" matches but "ACME Foods" does
    // not — all-caps tokens fail `[A-Z][a-z]+`). The rep is encouraged
    // (via the runbook §6) to rename files with all-caps shouty
    // workplace names BEFORE upload because the heuristic does not
    // catch them; the sealed-box encryption catches them regardless.
    const r = scanForPii('Minutes Acme Foods Q3.xlsx');
    expect(r.nameShape).toBe(true);
  });

  it('scans an attendance list + flags multiple name-shape entries', () => {
    const r = scanForPii('Jane Doe, John Smith, Sarah Chen, Maria Garcia');
    expect(r.nameShape).toBe(true);
    // The rollup count expects at least 2 distinct name-shape matches.
    const nameMatches = r.raw.filter((m) => m.kind === 'nameShape');
    expect(nameMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('scans a joined inspection-review snapshot + flags name + phone shapes', () => {
    const snapshot = [
      'Zone 1\tOK\tno issues',
      'Zone 2\tflagged\twitness John Doe at 555-123-4567',
      'Zone 3\tOK\tsupervisor Sarah Chen reviewed',
    ].join('\n');
    const r = scanForPii(snapshot);
    expect(r.nameShape).toBe(true);
    expect(r.phoneShape).toBe(true);
  });

  it('empty filename / attendance / snapshot returns clean flags (no false positives)', () => {
    const r = scanForPii('');
    expect(r.nameShape).toBe(false);
    expect(r.emailShape).toBe(false);
    expect(r.phoneShape).toBe(false);
    expect(r.sinShape).toBe(false);
    expect(r.raw).toEqual([]);
  });

  it('whitespace-only input returns clean flags', () => {
    const r = scanForPii('   \n\t  ');
    expect(r.nameShape).toBe(false);
    expect(r.raw).toEqual([]);
  });
});
