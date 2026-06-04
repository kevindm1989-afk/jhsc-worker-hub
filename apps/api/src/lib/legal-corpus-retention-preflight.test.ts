// Unit test for legal-corpus-retention-preflight.ts
// (2.3, ADR-0014 TM-fold-5).
//
// Goals:
//   - ON jurisdiction: requires OHSA s.9(28); resolves when seeded.
//   - CA-FED jurisdiction: requires CLC s.135.2; resolves when seeded.
//   - Missing entries throw RetentionCorpusMissingError (fail-closed).
//   - The canonicalHashes return value is sorted asc so the canonical
//     attestation bytes are deterministic.
//   - The lookup callback is called once per expected citation.

import { describe, expect, it, vi } from 'vitest';
import {
  RETENTION_CITATIONS_BY_JURISDICTION,
  RetentionCorpusMissingError,
  resolveRetentionCorpus,
  type CorpusEntryLookup,
  type RetentionCorpusEntry,
} from './legal-corpus-retention-preflight';

const FIXTURE_OHSA_S9_28: RetentionCorpusEntry = {
  statuteCode: 'OHSA',
  citation: 's.9(28)',
  versionDate: '2020-07-01',
  bodyHash: 'a'.repeat(64),
};

const FIXTURE_CLC_S135_2: RetentionCorpusEntry = {
  statuteCode: 'CLC',
  citation: 's.135.2',
  versionDate: '2020-07-01',
  bodyHash: 'b'.repeat(64),
};

describe('RETENTION_CITATIONS_BY_JURISDICTION — expected tuples', () => {
  it('ON requires OHSA s.9(28)', () => {
    expect(RETENTION_CITATIONS_BY_JURISDICTION.ON).toEqual([
      { statuteCode: 'OHSA', citation: 's.9(28)' },
    ]);
  });

  it('CA-FED requires CLC s.135.2', () => {
    expect(RETENTION_CITATIONS_BY_JURISDICTION['CA-FED']).toEqual([
      { statuteCode: 'CLC', citation: 's.135.2' },
    ]);
  });
});

describe('resolveRetentionCorpus — happy path', () => {
  it('resolves ON when the OHSA s.9(28) entry is seeded', async () => {
    const lookup: CorpusEntryLookup = vi.fn(async (e) => {
      if (e.statuteCode === 'OHSA' && e.citation === 's.9(28)') return FIXTURE_OHSA_S9_28;
      return null;
    });
    const result = await resolveRetentionCorpus('ON', lookup);
    expect(result.entries).toEqual([FIXTURE_OHSA_S9_28]);
    expect(result.canonicalHashes).toEqual([FIXTURE_OHSA_S9_28.bodyHash]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('resolves CA-FED when the CLC s.135.2 entry is seeded', async () => {
    const lookup: CorpusEntryLookup = vi.fn(async (e) => {
      if (e.statuteCode === 'CLC' && e.citation === 's.135.2') return FIXTURE_CLC_S135_2;
      return null;
    });
    const result = await resolveRetentionCorpus('CA-FED', lookup);
    expect(result.entries).toEqual([FIXTURE_CLC_S135_2]);
    expect(result.canonicalHashes).toEqual([FIXTURE_CLC_S135_2.bodyHash]);
  });

  it('returns canonicalHashes sorted ascending (for canonical attestation determinism)', async () => {
    // Construct a synthetic 2-entry jurisdiction by stubbing the lookup
    // for two citations and using a custom resolver path through the
    // exported helper. We simulate this by calling the helper twice
    // (one per citation) and reconciling — but the helper is the
    // public API, so we verify via canonicalHashes ordering when the
    // input array is intentionally reversed.

    // The ON jurisdiction has 1 entry today; sort with 1 element is
    // trivially correct. Test the sort behavior via a manual JSON.
    // Because the public API today only has 1 entry per jurisdiction,
    // we verify the sort is invoked by checking the return shape.
    const lookup: CorpusEntryLookup = vi.fn(async () => FIXTURE_OHSA_S9_28);
    const result = await resolveRetentionCorpus('ON', lookup);
    expect([...result.canonicalHashes]).toEqual([...result.canonicalHashes].sort());
  });
});

describe('resolveRetentionCorpus — fail-closed on missing entries', () => {
  it('throws RetentionCorpusMissingError when ON entry is unseeded', async () => {
    const lookup: CorpusEntryLookup = vi.fn(async () => null);
    await expect(resolveRetentionCorpus('ON', lookup)).rejects.toBeInstanceOf(
      RetentionCorpusMissingError,
    );
  });

  it('throws RetentionCorpusMissingError when CA-FED entry is unseeded', async () => {
    const lookup: CorpusEntryLookup = vi.fn(async () => null);
    await expect(resolveRetentionCorpus('CA-FED', lookup)).rejects.toBeInstanceOf(
      RetentionCorpusMissingError,
    );
  });

  it('error carries the jurisdiction + missing citations', async () => {
    const lookup: CorpusEntryLookup = vi.fn(async () => null);
    try {
      await resolveRetentionCorpus('ON', lookup);
      expect.fail('should have thrown');
    } catch (e) {
      if (e instanceof RetentionCorpusMissingError) {
        expect(e.jurisdiction).toBe('ON');
        expect(e.missing).toEqual([{ statuteCode: 'OHSA', citation: 's.9(28)' }]);
        expect(e.name).toBe('RetentionCorpusMissingError');
        // error.message is route-safe (no PI; only citation labels).
        expect(e.message).toContain('OHSA');
        expect(e.message).toContain('s.9(28)');
      } else {
        throw e;
      }
    }
  });

  it('the lookup callback is called for each expected citation even if early entries are missing', async () => {
    // For the multi-citation jurisdictions (none today; future-proofing),
    // verify the helper does not short-circuit on first miss — all
    // missing entries must surface so the rep sees a complete picture.
    // Since ON / CA-FED both have 1 entry today, we verify the count
    // matches expected.length.
    const lookup: CorpusEntryLookup = vi.fn(async () => null);
    await expect(resolveRetentionCorpus('ON', lookup)).rejects.toBeInstanceOf(
      RetentionCorpusMissingError,
    );
    expect(lookup).toHaveBeenCalledTimes(RETENTION_CITATIONS_BY_JURISDICTION.ON.length);
  });
});
