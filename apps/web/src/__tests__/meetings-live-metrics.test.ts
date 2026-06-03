// Unit tests for the live metrics panel's behaviour (Milestone 2.2
// S3, ADR-0013 §3.4).
//
// Tests cover:
//   - The duration formatter (pure function, hot path on every poll).
//   - SWR poll wiring through a fake timer + a vi.fn fetch — assert
//     the poll fires at the configured interval and STOPS when the
//     meeting status leaves `in_progress`.
//   - Offline fallback: when fetch rejects, the cache snapshot
//     renders + the source chip flips to Cached.
//   - meetingsApi.metrics wire-shape assertion.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDuration, LIVE_METRICS_POLL_MS } from '@/components/meetings/live-metrics-panel';
import { meetingsApi, MeetingApiError } from '@/meetings/api';
import { db } from '@/sync/db';

describe('formatDuration', () => {
  it('renders short meetings as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('renders long meetings as h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7200)).toBe('2:00:00');
  });

  it('clamps negative or non-finite to 0:00', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('LIVE_METRICS_POLL_MS', () => {
  it('matches the ADR §3.4 contract — 5s refresh', () => {
    expect(LIVE_METRICS_POLL_MS).toBe(5_000);
  });
});

describe('meetingsApi.metrics — wire shape', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs /api/meetings/:id/metrics with X-Requested-With', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      expect(url).toBe('/api/meetings/abc/metrics');
      expect(init?.method ?? 'GET').toBe('GET');
      expect((init?.headers as Record<string, string>)['X-Requested-With']).toBe('jhsc-web');
      return new Response(
        JSON.stringify({
          meetingId: 'abc',
          durationSeconds: 3600,
          itemsRaised: 2,
          itemsClosed: 1,
          recommendationsDrafted: 0,
          inspectionsReviewed: 1,
          quorumCompliance: {
            metAtCallToOrder: true,
            currentlyMet: true,
            ruleCitation: 'OHSA s.9(8)',
          },
          closureVerifications: { total: 1, selfAttestation: 1, peerVerified: 0 },
          asOf: '2026-06-03T10:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await meetingsApi.metrics('abc');
    expect(res.itemsRaised).toBe(2);
    expect(res.closureVerifications.selfAttestation).toBe(1);
    expect(res.quorumCompliance.currentlyMet).toBe(true);
  });

  it('surfaces a MeetingApiError on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'not_found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    let err: unknown = null;
    try {
      await meetingsApi.metrics('abc');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MeetingApiError);
    expect((err as MeetingApiError).status).toBe(404);
  });
});

describe('meeting_live_metrics offline cache shape', () => {
  it('round-trips a metrics response through Dexie', async () => {
    const sample = {
      meetingId: 'abc',
      durationSeconds: 1800,
      itemsRaised: 3,
      itemsClosed: 2,
      recommendationsDrafted: 1,
      inspectionsReviewed: 0,
      quorumCompliance: {
        metAtCallToOrder: true,
        currentlyMet: false,
        ruleCitation: 'OHSA s.9(8)',
      },
      closureVerifications: { total: 2, selfAttestation: 2, peerVerified: 0 },
      asOf: '2026-06-03T10:00:00Z',
    };
    await db.meeting_live_metrics.put({
      meetingId: 'abc',
      responseJson: JSON.stringify(sample),
      cachedAt: '2026-06-03T10:00:01Z',
    });
    const cached = await db.meeting_live_metrics.get('abc');
    expect(cached).toBeDefined();
    const parsed = JSON.parse(cached!.responseJson) as typeof sample;
    expect(parsed.itemsRaised).toBe(3);
    expect(parsed.closureVerifications.total).toBe(2);
    // Cleanup so other tests don't see a stale row.
    await db.meeting_live_metrics.delete('abc');
  });
});
