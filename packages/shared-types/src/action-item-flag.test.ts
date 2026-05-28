import { describe, expect, it } from 'vitest';
import { computeActionFlag } from './action-item-flag';

const TODAY = '2026-05-29';

describe('computeActionFlag — new_business section', () => {
  it('returns aging_under_21 for items <= 21 days old', () => {
    const flag = computeActionFlag({
      section: 'new_business',
      status: 'Not Started',
      startDate: '2026-05-10', // 19 days ago
      closedDate: null,
      today: TODAY,
    });
    expect(flag?.kind).toBe('aging_under_21');
    expect(flag?.label).toBe('🟠 <21 days');
    expect(flag?.severity).toBe('pending');
  });

  it('returns aging_under_21 for items exactly 21 days old (boundary inclusive)', () => {
    const flag = computeActionFlag({
      section: 'new_business',
      status: 'In Progress',
      startDate: '2026-05-08', // 21 days ago
      closedDate: null,
      today: TODAY,
    });
    expect(flag?.kind).toBe('aging_under_21');
  });

  it('returns aging_over_21 once the item passes 21 days', () => {
    const flag = computeActionFlag({
      section: 'new_business',
      status: 'In Progress',
      startDate: '2026-05-07', // 22 days ago
      closedDate: null,
      today: TODAY,
    });
    expect(flag?.kind).toBe('aging_over_21');
    expect(flag?.label).toContain('>21 days');
  });

  it('returns recently_closed when status=Closed regardless of age', () => {
    const flag = computeActionFlag({
      section: 'new_business',
      status: 'Closed',
      startDate: '2026-01-01',
      closedDate: '2026-05-29',
      today: TODAY,
    });
    expect(flag?.kind).toBe('recently_closed');
  });
});

describe('computeActionFlag — old_business section', () => {
  it('returns null when not closed (no flag needed; already in old business)', () => {
    expect(
      computeActionFlag({
        section: 'old_business',
        status: 'In Progress',
        startDate: '2026-01-01',
        closedDate: null,
        today: TODAY,
      }),
    ).toBeNull();
  });

  it('returns recently_closed when status=Closed', () => {
    const flag = computeActionFlag({
      section: 'old_business',
      status: 'Closed',
      startDate: '2026-01-01',
      closedDate: '2026-05-28',
      today: TODAY,
    });
    expect(flag?.kind).toBe('recently_closed');
  });
});

describe('computeActionFlag — recommendation section', () => {
  it('returns response_countdown with daysRemaining when within 21 days', () => {
    const flag = computeActionFlag({
      section: 'recommendation',
      status: 'In Progress',
      startDate: '2026-05-22', // 7 days ago
      closedDate: null,
      today: TODAY,
    });
    expect(flag?.kind).toBe('response_countdown');
    if (flag?.kind === 'response_countdown') {
      expect(flag.daysRemaining).toBe(14);
      expect(flag.label).toContain('14 days');
    }
  });

  it('returns response_overdue once past 21 days without a response', () => {
    const flag = computeActionFlag({
      section: 'recommendation',
      status: 'In Progress',
      startDate: '2026-05-07', // 22 days ago
      closedDate: null,
      today: TODAY,
    });
    expect(flag?.kind).toBe('response_overdue');
    expect(flag?.label).toContain('s.9(21)');
    expect(flag?.severity).toBe('open');
  });

  it('returns response_received when hasManagementResponse=true', () => {
    const flag = computeActionFlag({
      section: 'recommendation',
      status: 'Pending Review',
      startDate: '2026-05-01',
      closedDate: null,
      today: TODAY,
      hasManagementResponse: true,
    });
    expect(flag?.kind).toBe('response_received');
  });
});

describe('computeActionFlag — completed_this_period section', () => {
  it('returns recently_closed when closed <= 21 days ago', () => {
    const flag = computeActionFlag({
      section: 'completed_this_period',
      status: 'Closed',
      startDate: '2026-01-01',
      closedDate: '2026-05-10', // 19 days ago
      today: TODAY,
    });
    expect(flag?.kind).toBe('recently_closed');
  });

  it('returns archive_due once closedDate > 21 days', () => {
    const flag = computeActionFlag({
      section: 'completed_this_period',
      status: 'Closed',
      startDate: '2026-01-01',
      closedDate: '2026-05-07', // 22 days ago
      today: TODAY,
    });
    expect(flag?.kind).toBe('archive_due');
    expect(flag?.severity).toBe('archived');
  });

  it('falls back to recently_closed when closedDate is null (rep forgot to fill it)', () => {
    const flag = computeActionFlag({
      section: 'completed_this_period',
      status: 'Closed',
      startDate: '2026-01-01',
      closedDate: null,
      today: TODAY,
    });
    expect(flag?.kind).toBe('recently_closed');
  });
});

describe('computeActionFlag — archived section', () => {
  it('returns null (no flag for archived items)', () => {
    expect(
      computeActionFlag({
        section: 'archived',
        status: 'Closed',
        startDate: '2025-01-01',
        closedDate: '2025-12-01',
        today: TODAY,
      }),
    ).toBeNull();
  });
});

describe('computeActionFlag — invalid input', () => {
  it('throws on malformed ISO dates rather than returning a wrong flag', () => {
    expect(() =>
      computeActionFlag({
        section: 'new_business',
        status: 'Not Started',
        startDate: 'not-a-date',
        closedDate: null,
        today: TODAY,
      }),
    ).toThrow(/invalid date/);
  });
});
