import { describe, expect, it } from 'vitest';
import {
  checkCopyrightGuard,
  checkSummaryGuard,
  statuteFixtureSchema,
  type StatuteFixture,
} from './fixtures';

const ohsa: StatuteFixture = {
  code: 'OHSA',
  jurisdiction: 'ON',
  title: 'Occupational Health and Safety Act, R.S.O. 1990, c. O.1',
  licence: 'crown_copyright_open',
  source_url: 'https://www.ontario.ca/laws/statute/90o01',
  clauses: [
    {
      citation: 's.9(20)',
      hierarchy_path: ['Part II', 'Joint Health and Safety Committees', 's.9', '(20)'],
      heading: 'Recommendations',
      body: 'A committee shall make recommendations to the constructor or employer.',
      body_kind: 'full_text',
      version_date: '2020-07-01',
      verified_by: 'kdm',
      source_url: 'https://www.ontario.ca/laws/statute/90o01#BK14',
    },
  ],
};

describe('statuteFixtureSchema', () => {
  it('accepts a valid fixture', () => {
    expect(statuteFixtureSchema.safeParse(ohsa).success).toBe(true);
  });

  it('rejects an unknown licence', () => {
    const bad = { ...ohsa, licence: 'public_domain' };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-https source_url', () => {
    const bad = { ...ohsa, source_url: 'http://www.ontario.ca/laws/statute/90o01' };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects extra unknown fields (strict)', () => {
    const bad = { ...ohsa, secret_field: 'oops' };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a malformed version_date', () => {
    const bad: StatuteFixture = {
      ...ohsa,
      clauses: [{ ...ohsa.clauses[0]!, version_date: '2020-7-1' }],
    };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a code with invalid characters', () => {
    const bad = { ...ohsa, code: 'OHSA Act' };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty hierarchy_path', () => {
    const bad: StatuteFixture = {
      ...ohsa,
      clauses: [{ ...ohsa.clauses[0]!, hierarchy_path: [] }],
    };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  // sec-F1 XSS guard: text fields must not carry `<` `>` so a fixture
  // author can't smuggle markup that ts_headline echoes verbatim into
  // the search snippet.
  it('rejects a body containing `<`', () => {
    const bad: StatuteFixture = {
      ...ohsa,
      clauses: [{ ...ohsa.clauses[0]!, body: 'foo <script>x</script> bar' }],
    };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a heading containing `>`', () => {
    const bad: StatuteFixture = {
      ...ohsa,
      clauses: [{ ...ohsa.clauses[0]!, heading: 'A > B' }],
    };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a body_summary containing `<`', () => {
    const bad: StatuteFixture = {
      ...ohsa,
      licence: 'third_party_restricted',
      source_url: 'https://example.org/x',
      clauses: [
        {
          ...ohsa.clauses[0]!,
          body_kind: 'summary',
          body: 'paraphrase',
          body_summary: 'a <b> tag is here',
        },
      ],
    };
    expect(statuteFixtureSchema.safeParse(bad).success).toBe(false);
  });
});

describe('checkCopyrightGuard (T-LC4)', () => {
  it('passes a crown_copyright_open fixture with full_text bodies', () => {
    expect(checkCopyrightGuard(ohsa)).toEqual([]);
  });

  it('flags every full_text clause under a restricted licence', () => {
    const csa: StatuteFixture = {
      ...ohsa,
      code: 'CSA-Z1000',
      title: 'CSA Z1000 — Occupational health and safety management',
      licence: 'third_party_restricted',
      source_url: 'https://www.csagroup.org/store/product/CSA%20Z1000:14/',
      clauses: [
        {
          ...ohsa.clauses[0]!,
          citation: '4.3.1',
          body_kind: 'full_text',
          body: 'COPYRIGHTED TEXT',
        },
        {
          ...ohsa.clauses[0]!,
          citation: '4.3.2',
          body_kind: 'summary',
          body: 'paraphrase',
          body_summary: 'paraphrase',
        },
      ],
    };
    const violations = checkCopyrightGuard(csa);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      statute: 'CSA-Z1000',
      citation: '4.3.1',
      reason: 'full_text_under_restricted_licence',
    });
  });

  it('passes a third_party_restricted fixture that only uses summary bodies', () => {
    const csa: StatuteFixture = {
      ...ohsa,
      code: 'CSA-Z1000',
      title: 'CSA Z1000',
      licence: 'third_party_restricted',
      source_url: 'https://www.csagroup.org/store/product/CSA%20Z1000:14/',
      clauses: [
        {
          ...ohsa.clauses[0]!,
          body_kind: 'summary',
          body: 'paraphrase',
          body_summary: 'paraphrase',
        },
      ],
    };
    expect(checkCopyrightGuard(csa)).toEqual([]);
  });
});

describe('checkSummaryGuard', () => {
  it('flags a summary row missing body_summary', () => {
    const bad: StatuteFixture = {
      ...ohsa,
      licence: 'third_party_restricted',
      source_url: 'https://example.org/x',
      clauses: [
        {
          ...ohsa.clauses[0]!,
          body_kind: 'summary',
          body: 'paraphrase',
        },
      ],
    };
    const v = checkSummaryGuard(bad);
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toBe('summary_missing');
  });

  it('flags a full_text row that carries a body_summary', () => {
    const bad: StatuteFixture = {
      ...ohsa,
      clauses: [
        {
          ...ohsa.clauses[0]!,
          body_kind: 'full_text',
          body_summary: 'should not be here',
        },
      ],
    };
    const v = checkSummaryGuard(bad);
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toBe('summary_on_full_text');
  });

  it('passes a clean fixture', () => {
    expect(checkSummaryGuard(ohsa)).toEqual([]);
  });
});
