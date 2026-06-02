// Integration tests for /api/recommendations/* (Milestone 1.9 S2).
// Skips when DATABASE_URL is unset — matches the 1.5 / 1.6 / 1.7 / 1.8
// pattern.
//
// Coverage map (ADR-0008 §3.1 / §3.3 / §3.4 / §3.5 + SECURITY.md §2.9):
//   - POST happy path (allocates per-jurisdiction recommendation_number).
//   - POST with citations: corpus-present (200) and corpus-missing (422
//     citation_corpus_drift).
//   - POST with marker/position density mismatch -> 422.
//   - PATCH only accepts edits in draft state; rejects in submitted
//     state with 422 not_draft_state.
//   - PATCH cannot change jurisdiction (422
//     jurisdiction_immutable_after_draft_save).
//   - POST /submit happy path: action_item row created with
//     source_type='recommendation' + section='recommendation', link table
//     row inserted, chain anchor carries citationCount.
//   - POST /submit when status is already submitted -> 422 not_draft_state.
//   - POST /api/action-items with sourceType='recommendation' rejects
//     with 400 recommendation_source_requires_submit_route (T-R14 / sec-F2
//     mirror).
//   - POST /responses: status flips submitted -> response_received;
//     second response leaves status pinned; position 51 -> 422
//     response_cap_exceeded.
//   - POST /resolve: linked action_item moves to completed_this_period +
//     status='Closed'; chain anchor fires.
//   - POST /resolve without a response -> 422 requires_response.
//   - POST /withdraw from draft (no linked action_item); from submitted
//     (linked action_item archived + Cancelled); from resolved -> 422;
//     from withdrawn -> 422.
//   - GET /:id/reveal step-up rejection + after-step-up returns
//     decrypted fields.

import { sql } from 'drizzle-orm';
import { decodeBase32IgnorePadding } from '@oslojs/encoding';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verify } from '@jhsc/audit';
import { app } from '../../index';
import { getDb } from '../../db/client';
import { bootAuthTestEnv } from '../../auth/test-setup';
import { cleanAuthTables, hasDb } from '../../auth/test-db';
import { _internals as totpInternals } from '../../auth/totp';
import { _resetRateLimitForTests } from '../../middleware/rate-limit';

const SKIP = !hasDb();
const EMAIL = 'cochair@workplace.invalid';
const PASSWORD = 'SafeP@ssword!12345';
const DISPLAY_NAME = 'Worker Co-Chair';

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  _resetRateLimitForTests();
  await cleanAuthTables();
});

function cookieKv(setCookie: string): string {
  return setCookie.split(';')[0]!.trim();
}

async function loginAsRep(): Promise<{ cookie: string; userId: string }> {
  const setupRes = await app.request('/api/auth/first-run/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: DISPLAY_NAME }),
  });
  const setupBody = (await setupRes.json()) as { provisioning: string; totpSecretB32: string };
  const secret = decodeBase32IgnorePadding(setupBody.totpSecretB32);
  const code = totpInternals.hotpForStep(secret, totpInternals.currentStep(Date.now()));
  const confirmRes = await app.request('/api/auth/first-run/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web' },
    body: JSON.stringify({ provisioning: setupBody.provisioning, totpCode: code }),
  });
  const setCookies = confirmRes.headers.getSetCookie?.() ?? [];
  const access = setCookies.find((c) => c.startsWith('__Host-access='))!;
  const refresh = setCookies.find((c) => c.startsWith('__Secure-refresh='))!;
  const cookie = `${cookieKv(access)}; ${cookieKv(refresh)}`;
  const sessionRes = await app.request('/api/auth/session', { headers: { cookie } });
  const sessionBody = (await sessionRes.json()) as { userId: string };
  return { cookie, userId: sessionBody.userId };
}

async function loginWithStepUp(): Promise<{ cookie: string; userId: string }> {
  const session = await loginAsRep();
  // Grant a fresh step-up window directly via the sessions table. The
  // existing access-token cookie already carries the session id; the
  // next request's checkStepUpFreshness sees the bumped step_up_until.
  // Mirrors the inspections-integration-test helper.
  const db = getDb();
  await db.execute(sql`
    UPDATE sessions SET step_up_until = now() + interval '5 minutes'
    WHERE user_id = ${session.userId}
  `);
  return session;
}

// 1.10 S2 (ADR-0009 §3.7): every PATCH carries If-Match: "<version>".
// The helper reads the current version from the DB so PATCH chains land
// across multiple bumps without churning the test bodies.
async function getRecommendationVersion(id: string): Promise<number> {
  const db = getDb();
  const rows = (await db.execute(
    sql`SELECT version FROM recommendations WHERE id = ${id}`,
  )) as unknown as Array<{ version: number }>;
  return rows[0]!.version;
}

async function patchRecommendation(
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const version = await getRecommendationVersion(id);
  return app.request(`/api/recommendations/${id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'jhsc-web',
      'if-match': `"${version}"`,
      cookie,
    },
    body: JSON.stringify(body),
  });
}

async function createRecommendation(
  cookie: string,
  override?: Partial<{
    title: string;
    body: string;
    jurisdiction: 'ON' | 'CA-FED';
    citations: Array<{
      statuteCode: string;
      clauseId: string;
      versionDate: string;
      position: number;
    }>;
  }>,
): Promise<{ id: string; recommendationNumber: number }> {
  const res = await app.request('/api/recommendations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
    body: JSON.stringify({
      title: override?.title ?? 'Lockout procedure update for the compactor',
      body:
        override?.body ??
        'The compactor lockout procedure has not been updated since 2023. Recommend immediate review.',
      jurisdiction: override?.jurisdiction ?? 'ON',
      ...(override?.citations !== undefined ? { citations: override.citations } : {}),
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; recommendationNumber: number };
}

describe.skipIf(SKIP)('POST /api/recommendations — create draft', () => {
  it('creates a draft + allocates per-jurisdiction recommendation_number', async () => {
    const { cookie } = await loginAsRep();
    const a = await createRecommendation(cookie, { jurisdiction: 'ON' });
    expect(a.recommendationNumber).toBe(1);
    const b = await createRecommendation(cookie, { jurisdiction: 'ON' });
    expect(b.recommendationNumber).toBe(2);
    // CA-FED sequence advances independently.
    const c = await createRecommendation(cookie, { jurisdiction: 'CA-FED' });
    expect(c.recommendationNumber).toBe(1);

    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'recommendation.drafted'
    `)) as unknown as Array<{
      payload: { recommendationId: string; recommendationNumber: number; jurisdiction: string };
    }>;
    expect(chain).toHaveLength(3);
    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('rejects POST with citation pointing at a (statuteCode, clauseId, versionDate) triple absent from corpus -> 422 citation_corpus_drift', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'Bogus citation test',
        body: 'A reference [[cite:1]] to a nonexistent corpus row.',
        jurisdiction: 'ON',
        citations: [
          {
            statuteCode: 'OHSA',
            clauseId: '00000000-0000-0000-0000-000000000000',
            versionDate: '2020-01-01',
            position: 1,
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('citation_corpus_drift');
  });

  it('rejects POST with marker/position mismatch -> 422 citation_marker_mismatch', async () => {
    const { cookie } = await loginAsRep();
    // Citation list has position 1 but no [[cite:1]] marker in the body.
    const res = await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'Marker mismatch test',
        body: 'No markers here at all but there is a citation in the list.',
        jurisdiction: 'ON',
        citations: [
          {
            // Use any uuid/code/date; corpus-presence check runs AFTER
            // marker density. We want the marker gate to fire first.
            statuteCode: 'OHSA',
            clauseId: '11111111-1111-1111-1111-111111111111',
            versionDate: '2020-01-01',
            position: 1,
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('citation_marker_mismatch');
  });
});

describe.skipIf(SKIP)('PATCH /api/recommendations/:id — draft-state-only edits', () => {
  it('accepts title + body changes in draft state', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const res = await patchRecommendation(cookie, rec.id, {
      title: 'Updated title',
      body: 'Updated body text.',
    });
    expect(res.status).toBe(200);
  });

  it('rejects PATCH on submitted recommendation with 422 not_draft_state', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const submit = await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(submit.status).toBe(200);
    const res = await patchRecommendation(cookie, rec.id, { title: 'Cannot edit' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_draft_state');
  });

  it('rejects jurisdiction change with 422 jurisdiction_immutable_after_draft_save', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie, { jurisdiction: 'ON' });
    const res = await patchRecommendation(cookie, rec.id, { jurisdiction: 'CA-FED' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('jurisdiction_immutable_after_draft_save');
  });
});

describe.skipIf(SKIP)('POST /api/recommendations/:id/submit — bridge to action_items', () => {
  it('creates an action_items row with source_type=recommendation + section=recommendation + link table row + chain anchor', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie, { jurisdiction: 'ON' });
    const res = await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      submittedAt: string;
      deadline: string | null;
      linkedActionItemId: string;
    };
    expect(body.status).toBe('submitted');
    expect(body.linkedActionItemId).toMatch(/^[0-9a-f-]{36}$/);
    // ON jurisdiction -> 21-day deadline computed and surfaced.
    expect(body.deadline).not.toBeNull();

    const db = getDb();
    const aiRows = (await db.execute(sql`
      SELECT source_type, source_id, section, type, status, risk
      FROM action_items WHERE id = ${body.linkedActionItemId}
    `)) as unknown as Array<{
      source_type: string;
      source_id: string;
      section: string;
      type: string;
      status: string;
      risk: string;
    }>;
    expect(aiRows[0]!.source_type).toBe('recommendation');
    expect(aiRows[0]!.source_id).toBe(rec.id);
    expect(aiRows[0]!.section).toBe('recommendation');
    expect(aiRows[0]!.type).toBe('REC');
    expect(aiRows[0]!.status).toBe('Not Started');
    expect(aiRows[0]!.risk).toBe('Medium');

    const linkRows = (await db.execute(sql`
      SELECT recommendation_id, action_item_id, link_kind
      FROM recommendation_action_item_links WHERE recommendation_id = ${rec.id}
    `)) as unknown as Array<{
      recommendation_id: string;
      action_item_id: string;
      link_kind: string;
    }>;
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]!.action_item_id).toBe(body.linkedActionItemId);
    expect(linkRows[0]!.link_kind).toBe('tracks');

    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'recommendation.submitted'
    `)) as unknown as Array<{
      payload: {
        recommendationId: string;
        recommendationNumber: number;
        jurisdiction: string;
        citationCount: number;
        linkedActionItemId: string;
      };
    }>;
    expect(chain).toHaveLength(1);
    expect(chain[0]!.payload.citationCount).toBe(0);
    expect(chain[0]!.payload.linkedActionItemId).toBe(body.linkedActionItemId);
    expect(chain[0]!.payload.jurisdiction).toBe('ON');

    // Verify chain still walks cleanly.
    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('rejects second submit with 422 not_draft_state', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const first = await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe('not_draft_state');
  });
});

describe.skipIf(SKIP)('POST /api/action-items rejects sourceType=recommendation (T-R14)', () => {
  it('returns 400 recommendation_source_requires_submit_route', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        type: 'REC',
        description: 'd',
        status: 'Not Started',
        risk: 'Medium',
        section: 'recommendation',
        startDate: '2026-05-29',
        sourceType: 'recommendation',
        sourceId: '00000000-0000-0000-0000-000000000000',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues?: { fieldErrors?: Record<string, string[]> };
    };
    expect(body.error).toBe('invalid_body');
    const flat = body.issues?.fieldErrors?.sourceType ?? [];
    expect(flat.some((m) => m.includes('recommendation_source_requires_submit_route'))).toBe(true);
  });
});

describe.skipIf(SKIP)('POST /api/recommendations/:id/responses — append-only', () => {
  async function setupSubmitted(cookie: string): Promise<{ id: string }> {
    const rec = await createRecommendation(cookie);
    const submit = await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(submit.status).toBe(200);
    return { id: rec.id };
  }

  it('first response flips status to response_received; second leaves it pinned', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await setupSubmitted(cookie);

    const first = await app.request(`/api/recommendations/${id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        authorRole: 'VP Operations',
        body: 'We agree with the recommendation and will action it within 30 days.',
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { position: number };
    expect(firstBody.position).toBe(1);

    const second = await app.request(`/api/recommendations/${id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        authorRole: 'Plant Manager',
        body: 'Amendment to the prior response: timeline is now 14 days.',
      }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { position: number };
    expect(secondBody.position).toBe(2);

    const db = getDb();
    const statusRows = (await db.execute(sql`
      SELECT status FROM recommendations WHERE id = ${id}
    `)) as unknown as Array<{ status: string }>;
    expect(statusRows[0]!.status).toBe('response_received');
  });

  it('rejects position 51 with 422 response_cap_exceeded (T-R42)', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await setupSubmitted(cookie);
    // Pre-load 50 responses directly via the route (rate-limit bucket
    // is 60/sec; this is fine).
    for (let i = 1; i <= 50; i++) {
      const r = await app.request(`/api/recommendations/${id}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({ authorRole: `Role ${i}`, body: `Body ${i}` }),
      });
      expect(r.status).toBe(201);
    }
    const overflow = await app.request(`/api/recommendations/${id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ authorRole: 'Cap exceeded', body: 'Should reject' }),
    });
    expect(overflow.status).toBe(422);
    const body = (await overflow.json()) as { error: string };
    expect(body.error).toBe('response_cap_exceeded');
  });
});

describe.skipIf(SKIP)('POST /api/recommendations/:id/resolve', () => {
  it('happy path: linked action_item moves to completed_this_period + status=Closed; chain anchor fires', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const submit = await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    const submitBody = (await submit.json()) as { linkedActionItemId: string };
    const linkedActionItemId = submitBody.linkedActionItemId;

    await app.request(`/api/recommendations/${rec.id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ authorRole: 'VP Operations', body: 'Agreed.' }),
    });

    const resolve = await app.request(`/api/recommendations/${rec.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(resolve.status).toBe(200);

    const db = getDb();
    const aiRows = (await db.execute(sql`
      SELECT section, status, closed_date FROM action_items WHERE id = ${linkedActionItemId}
    `)) as unknown as Array<{ section: string; status: string; closed_date: string | null }>;
    expect(aiRows[0]!.section).toBe('completed_this_period');
    expect(aiRows[0]!.status).toBe('Closed');
    expect(aiRows[0]!.closed_date).not.toBeNull();

    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'recommendation.resolved'
    `)) as unknown as Array<{
      payload: { recommendationId: string; linkedActionItemId: string };
    }>;
    expect(chain).toHaveLength(1);
    expect(chain[0]!.payload.linkedActionItemId).toBe(linkedActionItemId);
    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('rejects resolve without a response with 422 requires_response', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    const res = await app.request(`/api/recommendations/${rec.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('requires_response');
  });
});

describe.skipIf(SKIP)('POST /api/recommendations/:id/withdraw', () => {
  it('from draft: chain payload carries linkedActionItemId=null', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const res = await app.request(`/api/recommendations/${rec.id}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ reason: 'addressed_pre_submission' }),
    });
    expect(res.status).toBe(200);
    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'recommendation.withdrawn'
    `)) as unknown as Array<{
      payload: { recommendationId: string; linkedActionItemId: string | null };
    }>;
    expect(chain).toHaveLength(1);
    expect(chain[0]!.payload.linkedActionItemId).toBeNull();
  });

  it('from submitted: linked action_item moves to archived + Cancelled', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const submit = await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    const submitBody = (await submit.json()) as { linkedActionItemId: string };
    const linkedActionItemId = submitBody.linkedActionItemId;

    const wd = await app.request(`/api/recommendations/${rec.id}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ reason: 'rescinded' }),
    });
    expect(wd.status).toBe(200);

    const db = getDb();
    const aiRows = (await db.execute(sql`
      SELECT section, status FROM action_items WHERE id = ${linkedActionItemId}
    `)) as unknown as Array<{ section: string; status: string }>;
    expect(aiRows[0]!.section).toBe('archived');
    expect(aiRows[0]!.status).toBe('Cancelled');
  });

  it('rejects withdraw from resolved with 422 cannot_withdraw_in_state', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    await app.request(`/api/recommendations/${rec.id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ authorRole: 'VP Operations', body: 'Agreed.' }),
    });
    await app.request(`/api/recommendations/${rec.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    const res = await app.request(`/api/recommendations/${rec.id}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ reason: 'rescinded' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cannot_withdraw_in_state');
  });

  it('rejects withdraw from already-withdrawn state with 422', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const first = await app.request(`/api/recommendations/${rec.id}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ reason: 'rescinded' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/recommendations/${rec.id}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ reason: 'superseded' }),
    });
    expect(second.status).toBe(422);
  });
});

describe.skipIf(SKIP)('GET /api/recommendations/:id/reveal — step-up gated decrypt', () => {
  it('rejects without step-up with 401 step_up_required + WWW-Authenticate', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie, {
      title: 'Reveal test title',
      body: 'Reveal test body content.',
    });
    const res = await app.request(`/api/recommendations/${rec.id}/reveal`, {
      headers: { cookie },
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toContain('StepUp');
    expect(wwwAuth).toContain('action="recommendation.read"');
    expect(wwwAuth).toContain('max_age="60"');
  });

  it('returns decrypted title + body + response data when step-up is fresh', async () => {
    const { cookie } = await loginWithStepUp();
    const rec = await createRecommendation(cookie, {
      title: 'Reveal test title fixture',
      body: 'Reveal test body fixture content.',
    });
    await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    await app.request(`/api/recommendations/${rec.id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        authorRole: 'VP Operations',
        body: 'We agree with the recommendation.',
      }),
    });
    const res = await app.request(`/api/recommendations/${rec.id}/reveal`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      body: string;
      responses: Array<{ authorRole: string; body: string; position: number }>;
    };
    expect(body.title).toBe('Reveal test title fixture');
    expect(body.body).toBe('Reveal test body fixture content.');
    expect(body.responses).toHaveLength(1);
    expect(body.responses[0]!.authorRole).toBe('VP Operations');
    expect(body.responses[0]!.body).toBe('We agree with the recommendation.');
  });
});

// ---------------------------------------------------------------------------
// S4 PDF export + Ed25519 signed ZIP bundle route tests.
//
// The create path requires step-up + Tigris. We grant step-up directly
// via the sessions table (same shortcut as the inspections-exports
// tests). Tigris isn't available in the unit-test harness; the
// create happy path is therefore additionally SKIPPED when
// TIGRIS_BUCKET is unset. The step-up rejection + list + state guard
// tests run without Tigris.
// ---------------------------------------------------------------------------

const SKIP_TIGRIS = !process.env.TIGRIS_BUCKET;

describe.skipIf(SKIP)('POST /api/recommendations/:id/exports (step-up gated)', () => {
  it('rejects with 401 when step-up freshness is stale', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    const res = await app.request(`/api/recommendations/${rec.id}/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toContain('StepUp');
    // T-R29 close-out: the action string carries the recommendation id
    // so a grant for one rec cannot replay against another.
    expect(wwwAuth).toContain(`action="recommendation.export.${rec.id}"`);
    expect(wwwAuth).toContain('max_age="60"');
  });

  it('rejects with 422 cannot_export_draft when the recommendation is still in draft state', async () => {
    const { cookie } = await loginWithStepUp();
    const rec = await createRecommendation(cookie);
    const res = await app.request(`/api/recommendations/${rec.id}/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; status: string };
    expect(body.error).toBe('cannot_export_draft');
    expect(body.status).toBe('draft');
  });
});

describe.skipIf(SKIP)('GET /api/recommendations/exports (list)', () => {
  it('returns an empty list when no recommendation exports have run', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/recommendations/exports', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
  });

  it('list endpoint requires auth (drops to 401 without a cookie)', async () => {
    // Belt-and-suspenders: the list endpoint sits inside the
    // authMiddleware'd route group. A missing cookie returns 401, not
    // an empty list. The kind-filter happens server-side so a
    // future regression that drops `WHERE kind = 'recommendation_single'`
    // can't leak inspection-export metadata through this list path.
    const res = await app.request('/api/recommendations/exports');
    expect(res.status).toBe(401);
  });
});

describe.skipIf(SKIP || SKIP_TIGRIS)(
  'POST /api/recommendations/:id/exports — happy path with Tigris',
  () => {
    it('signs + stores + emits a chain anchor with all the recommendation.exported payload fields', async () => {
      const { cookie } = await loginWithStepUp();
      const rec = await createRecommendation(cookie);
      await app.request(`/api/recommendations/${rec.id}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({}),
      });

      const res = await app.request(`/api/recommendations/${rec.id}/exports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        exportId: string;
        outputSha256: string;
        signatureSha256: string;
        signingKeyId: string;
        citationsHash: string;
        byteSize: number;
        expiresAt: string;
        chainIdx: number;
      };
      expect(body.exportId).toMatch(/^[0-9a-f-]{36}$/);
      // PDF sha and signature sha are 64-char hex digests.
      expect(body.outputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.signingKeyId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.citationsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.byteSize).toBeGreaterThan(0);

      // Verify the chain anchor.
      const db = getDb();
      const chainRows = (await db.execute(sql`
        SELECT payload FROM audit_log
        WHERE kind = 'recommendation.exported' AND resource_id = ${body.exportId}
      `)) as unknown as Array<{
        payload: {
          kind: string;
          exportId: string;
          recommendationId: string;
          outputSha256: string;
          signatureSha256: string;
          signingKeyId: string;
          citationsHash: string;
          byteSize: number;
        };
      }>;
      expect(chainRows).toHaveLength(1);
      const payload = chainRows[0]!.payload;
      expect(payload.recommendationId).toBe(rec.id);
      expect(payload.outputSha256).toBe(body.outputSha256);
      expect(payload.signatureSha256).toBe(body.signatureSha256);
      expect(payload.signingKeyId).toBe(body.signingKeyId);
      expect(payload.citationsHash).toBe(body.citationsHash);
      expect(payload.byteSize).toBe(body.byteSize);

      // Verify the export_records row with the correct kind.
      const recordRows = (await db.execute(sql`
        SELECT kind, encode(output_sha256, 'hex') AS output_sha,
               encode(signature_sha256, 'hex') AS sig_sha,
               signing_key_id
        FROM export_records WHERE id = ${body.exportId}
      `)) as unknown as Array<{
        kind: string;
        output_sha: string;
        sig_sha: string;
        signing_key_id: string;
      }>;
      expect(recordRows).toHaveLength(1);
      expect(recordRows[0]!.kind).toBe('recommendation_single');
      expect(recordRows[0]!.output_sha).toBe(body.outputSha256);
      expect(recordRows[0]!.sig_sha).toBe(body.signatureSha256);
      expect(recordRows[0]!.signing_key_id).toBe(body.signingKeyId);

      // Chain verify still passes (no broken hash chain from the new
      // recommendation.exported kind).
      const v = await verify(db);
      expect(v.ok).toBe(true);
    });

    it('list returns the new export row', async () => {
      const { cookie } = await loginWithStepUp();
      const rec = await createRecommendation(cookie);
      await app.request(`/api/recommendations/${rec.id}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({}),
      });
      const create = await app.request(`/api/recommendations/${rec.id}/exports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({}),
      });
      const createBody = (await create.json()) as { exportId: string };

      const list = await app.request('/api/recommendations/exports', {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as {
        items: Array<{ id: string; recommendationId: string; signingKeyId: string }>;
      };
      const match = listBody.items.find((i) => i.id === createBody.exportId);
      expect(match).toBeDefined();
      expect(match!.recommendationId).toBe(rec.id);
      expect(match!.signingKeyId).toMatch(/^[0-9a-f-]{36}$/);
    });
  },
);

describe.skipIf(SKIP)('GET /api/recommendations/exports/:id/download — step-up gates', () => {
  it('rejects with 401 when step-up freshness is stale', async () => {
    const { cookie } = await loginAsRep();
    // Any uuid — the step-up gate runs BEFORE the export_records
    // lookup so we don't need a real export row to exercise it.
    const res = await app.request(
      `/api/recommendations/exports/00000000-0000-0000-0000-000000000000/download`,
      {
        headers: { cookie, 'x-requested-with': 'jhsc-web' },
      },
    );
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toContain('StepUp');
    expect(wwwAuth).toContain('action="recommendation.export.download"');
    expect(wwwAuth).toContain('max_age="60"');
  });

  it('rejects with 403 csrf_required when X-Requested-With is missing', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request(
      `/api/recommendations/exports/00000000-0000-0000-0000-000000000000/download`,
      {
        headers: { cookie },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('csrf_required');
  });
});

// ---------------------------------------------------------------------------
// 1.9 S5 sec-F4 close-out (T-R44): PATCH chain anchor
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)(
  'PATCH /api/recommendations/:id emits recommendation.draft_patched (S5 sec-F4)',
  () => {
    it('emits the anchor on body-only PATCH with bodyChanged=true + identical hashes', async () => {
      const { cookie } = await loginAsRep();
      const rec = await createRecommendation(cookie);
      const res = await patchRecommendation(cookie, rec.id, {
        body: 'Revised draft body without any markers.',
      });
      expect(res.status).toBe(200);

      const db = getDb();
      const rows = (await db.execute(sql`
      SELECT payload FROM audit_log
      WHERE kind = 'recommendation.draft_patched' AND resource_id = ${rec.id}
    `)) as unknown as Array<{
        payload: {
          recommendationId: string;
          recommendationNumber: number;
          priorCitationsHash: string;
          newCitationsHash: string;
          bodyChanged: boolean;
        };
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.recommendationId).toBe(rec.id);
      expect(rows[0]!.payload.bodyChanged).toBe(true);
      // No citations changed; the two hashes are equal.
      expect(rows[0]!.payload.priorCitationsHash).toBe(rows[0]!.payload.newCitationsHash);
      // Hashes are 64-char hex strings.
      expect(rows[0]!.payload.priorCitationsHash).toMatch(/^[0-9a-f]{64}$/);

      const v = await verify(db);
      expect(v.ok).toBe(true);
    });

    it('emits the anchor on citation-only PATCH (empty -> empty churn, bodyChanged=false)', async () => {
      const { cookie } = await loginAsRep();
      // Create a recommendation with no citations + no markers (the
      // simplest case that exercises the gate without depending on a
      // specific corpus fixture). PATCH with an explicit empty
      // citations array — body unchanged, citations unchanged
      // structurally, but the request DID include `citations`, so
      // `hasMutation` is true and the anchor fires.
      const rec = await createRecommendation(cookie);
      const res = await patchRecommendation(cookie, rec.id, { citations: [] });
      expect(res.status).toBe(200);

      const db = getDb();
      const rows = (await db.execute(sql`
        SELECT payload FROM audit_log
        WHERE kind = 'recommendation.draft_patched' AND resource_id = ${rec.id}
      `)) as unknown as Array<{
        payload: { bodyChanged: boolean; priorCitationsHash: string; newCitationsHash: string };
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.bodyChanged).toBe(false);
      // No prior citations + no new citations -> identical hashes
      // (empty-array hash). The anchor still fires because the PATCH
      // request DID include a citations field.
      expect(rows[0]!.payload.priorCitationsHash).toBe(rows[0]!.payload.newCitationsHash);
    });

    it('does NOT emit the anchor on a no-op PATCH (empty body)', async () => {
      const { cookie } = await loginAsRep();
      const rec = await createRecommendation(cookie);
      const res = await patchRecommendation(cookie, rec.id, {});
      expect(res.status).toBe(200);

      const db = getDb();
      const rows = (await db.execute(sql`
      SELECT payload FROM audit_log
      WHERE kind = 'recommendation.draft_patched' AND resource_id = ${rec.id}
    `)) as unknown as Array<unknown>;
      expect(rows).toHaveLength(0);
    });

    it('does NOT emit the anchor on a failed PATCH (jurisdiction change rejected)', async () => {
      const { cookie } = await loginAsRep();
      const rec = await createRecommendation(cookie, { jurisdiction: 'ON' });
      const res = await patchRecommendation(cookie, rec.id, { jurisdiction: 'CA-FED' });
      expect(res.status).toBe(422);
      const db = getDb();
      const rows = (await db.execute(sql`
      SELECT payload FROM audit_log
      WHERE kind = 'recommendation.draft_patched' AND resource_id = ${rec.id}
    `)) as unknown as Array<unknown>;
      expect(rows).toHaveLength(0);
    });
  },
);

// ---------------------------------------------------------------------------
// 1.9 S5 sec-F8 close-out: body-only PATCH re-validates against existing
// citations
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('PATCH body-only re-validates citation markers (S5 sec-F8)', () => {
  it('rejects a body-only PATCH that adds a dangling marker with 422 citation_marker_mismatch', async () => {
    const { cookie } = await loginAsRep();
    // Create a recommendation with NO citations; new body adds a
    // marker without a matching citation row.
    const rec = await createRecommendation(cookie, { body: 'Original body with no markers.' });
    const res = await patchRecommendation(cookie, rec.id, {
      body: 'Edited body with a dangling [[cite:1]] marker.',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('citation_marker_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 1.9 S5 priv-F14 close-out: noHtmlBounded on create/patch/response
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('priv-F14 noHtmlBounded — HTML + BiDi rejects', () => {
  it('rejects a body with <script> tags as 400 invalid_body', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'HTML reject test',
        body: 'A body with <script>alert(1)</script> embedded.',
        jurisdiction: 'ON',
      }),
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { error: string };
    expect(errBody.error).toBe('invalid_body');
  });

  it('rejects a body with a BiDi override (U+202E) as 400 invalid_body', async () => {
    const { cookie } = await loginAsRep();
    const bidi = '‮';
    const res = await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'BiDi reject test',
        body: `Visible text${bidi}reversed evil.`,
        jurisdiction: 'ON',
      }),
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { error: string };
    expect(errBody.error).toBe('invalid_body');
  });

  it('rejects a response body with a control character as 400 invalid_body', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    // U+0007 BEL is a C0 control character; the refinement rejects it.
    const res = await app.request(`/api/recommendations/${rec.id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        authorRole: 'VP Operations',
        body: 'Acknowledged with hidden control char.',
      }),
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { error: string };
    expect(errBody.error).toBe('invalid_body');
  });
});

// ---------------------------------------------------------------------------
// 1.9 S5 sec-F2 close-out (T-R43): recommendation.export.downloaded
// chain anchor
// ---------------------------------------------------------------------------

describe.skipIf(SKIP || SKIP_TIGRIS)(
  'GET /api/recommendations/exports/:id/download emits recommendation.export.downloaded (S5 sec-F2)',
  () => {
    it('emits the anchor on a successful download AFTER the TOCTOU verify passes', async () => {
      const { cookie } = await loginWithStepUp();
      const rec = await createRecommendation(cookie);
      await app.request(`/api/recommendations/${rec.id}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({}),
      });
      const createRes = await app.request(`/api/recommendations/${rec.id}/exports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({}),
      });
      const createBody = (await createRes.json()) as { exportId: string };

      const dlRes = await app.request(
        `/api/recommendations/exports/${createBody.exportId}/download`,
        {
          headers: { cookie, 'x-requested-with': 'jhsc-web' },
        },
      );
      expect(dlRes.status).toBe(200);

      const db = getDb();
      const rows = (await db.execute(sql`
        SELECT payload FROM audit_log
        WHERE kind = 'recommendation.export.downloaded' AND resource_id = ${createBody.exportId}
      `)) as unknown as Array<{
        payload: {
          exportId: string;
          recommendationId: string;
          downloadedByUserId: string;
        };
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.exportId).toBe(createBody.exportId);
      expect(rows[0]!.payload.recommendationId).toBe(rec.id);

      const v = await verify(db);
      expect(v.ok).toBe(true);
    });

    it('does NOT emit the anchor on a 401 step_up_required download', async () => {
      // Use a non-stepped-up session — the gate rejects with 401 BEFORE
      // the export_records lookup, so the anchor never fires.
      const { cookie } = await loginAsRep();
      const res = await app.request(
        `/api/recommendations/exports/00000000-0000-0000-0000-000000000000/download`,
        {
          headers: { cookie, 'x-requested-with': 'jhsc-web' },
        },
      );
      expect(res.status).toBe(401);
      const db = getDb();
      const rows = (await db.execute(sql`
        SELECT id FROM audit_log WHERE kind = 'recommendation.export.downloaded'
      `)) as unknown as Array<unknown>;
      expect(rows).toHaveLength(0);
    });
  },
);

// ---------------------------------------------------------------------------
// 1.10 (ADR-0009 §3.3): clientId ratchet on POST /api/recommendations,
// POST /:id/responses, and POST /:id/exports.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /api/recommendations — clientId idempotency (1.10 S1)', () => {
  const REC_CLIENT_ID = '66666666-6666-4666-8666-666666666666';

  it('first POST with clientId returns 201 with id=clientId', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        clientId: REC_CLIENT_ID,
        title: 'Clientside-allocated recommendation',
        body: 'A recommendation whose id is allocated client-side per ADR-0009 §3.3.',
        jurisdiction: 'ON',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(REC_CLIENT_ID);
  });

  it('replay with same clientId + same payload returns 200 with the existing row', async () => {
    const { cookie } = await loginAsRep();
    const payload = JSON.stringify({
      clientId: REC_CLIENT_ID,
      title: 'Clientside-allocated recommendation',
      body: 'A recommendation whose id is allocated client-side per ADR-0009 §3.3.',
      jurisdiction: 'ON',
    });
    await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: payload,
    });
    const res = await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; recommendationNumber: number };
    expect(body.id).toBe(REC_CLIENT_ID);
    // The sequence number didn't advance — only one draft row exists.
    expect(body.recommendationNumber).toBe(1);
  });

  it('absent clientId falls back to gen_random_uuid()', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/recommendations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'No clientId',
        body: 'A recommendation drafted without a client-supplied id.',
        jurisdiction: 'ON',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.id).not.toBe(REC_CLIENT_ID);
  });
});

describe.skipIf(SKIP)('POST /api/recommendations/:id/responses — clientId idempotency', () => {
  const RESP_CLIENT_ID = '77777777-7777-4777-8777-777777777777';

  it('replay with same clientId returns 200 with the existing response row', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    // Submit so the recommendation can accept responses.
    await app.request(`/api/recommendations/${rec.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    const payload = JSON.stringify({
      clientId: RESP_CLIENT_ID,
      authorRole: 'manager',
      body: 'Acknowledged; will review and respond by month end.',
    });
    const first = await app.request(`/api/recommendations/${rec.id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: payload,
    });
    expect(first.status).toBe(201);
    const replay = await app.request(`/api/recommendations/${rec.id}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: payload,
    });
    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { id: string; position: number };
    expect(body.id).toBe(RESP_CLIENT_ID);
    expect(body.position).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 1.10 S2 (ADR-0009 §3.7): If-Match etag ratchet on the draft PATCH handler.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('PATCH /api/recommendations/:id — If-Match etag (1.10 S2)', () => {
  it('returns 428 precondition_required when If-Match is absent', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const res = await app.request(`/api/recommendations/${rec.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ body: 'No etag → 428.' }),
    });
    expect(res.status).toBe(428);
    expect(((await res.json()) as { error: string }).error).toBe('precondition_required');
  });

  it('returns 409 version_conflict when If-Match is stale', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const first = await patchRecommendation(cookie, rec.id, { body: 'First edit.' });
    expect(first.status).toBe(200);
    const stale = await app.request(`/api/recommendations/${rec.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        'if-match': '"1"',
        cookie,
      },
      body: JSON.stringify({ body: 'Stale edit.' }),
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      error: string;
      currentVersion: number;
      serverState: { status: string; version: number };
    };
    expect(body.error).toBe('version_conflict');
    expect(body.currentVersion).toBe(2);
    expect(body.serverState.version).toBe(2);
  });

  it('200 + bumped version on matching If-Match', async () => {
    const { cookie } = await loginAsRep();
    const rec = await createRecommendation(cookie);
    const res = await patchRecommendation(cookie, rec.id, { body: 'Matching etag PATCH.' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(2);
  });
});
