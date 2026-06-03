// Unit tests for the M2.1 S4 agenda template seed.
//
// These tests run against pure helpers (no DB). The DB-side integration
// behavior (idempotency, audit anchor) is exercised indirectly via the
// shape assertions plus a hand-rolled in-memory fake that simulates the
// transaction semantics enough to assert the SELECT-first-then-INSERT
// idempotency contract.

import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify, type DrizzlePg } from '@jhsc/audit';
import {
  MEETING_TEMPLATE_CODE,
  MEETING_TEMPLATE_V1_NAME,
  MEETING_TEMPLATE_V1_VERSION,
  buildTemplateV1Sections,
  seedMeetingTemplate,
  templateV1Hash,
} from '../seed-meeting-template';

describe('seed-meeting-template — canonical v1 sections', () => {
  it('passes the Zod schema validation and round-trips deterministically', () => {
    const a = buildTemplateV1Sections();
    const b = buildTemplateV1Sections();
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('instantiates 11 ordered rows (10 distinct sections + 1 adjournment closer)', () => {
    // Per the brief: 10 sections from the 12-value enum, with
    // adjournment at order_idx=10 (next_meeting + adjournment occupy
    // separate slots). 11 total entries.
    const sections = buildTemplateV1Sections();
    expect(sections.length).toBe(11);

    // Confirm order_idx values are unique + sequential 0..10.
    const orderIdxs = sections.map((s) => s.order_idx);
    expect(orderIdxs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('places sections in the documented canonical order', () => {
    const sections = buildTemplateV1Sections();
    expect(sections.map((s) => s.section_type)).toEqual([
      'call_to_order',
      'roll_call_quorum',
      'minutes_review',
      'old_business',
      'new_business',
      'inspections_review',
      'incident_review',
      'recommendations',
      'other_business',
      'next_meeting',
      'adjournment',
    ]);
  });

  it('does NOT instantiate complaints_review (12th enum slot reserved as forward seam)', () => {
    const sections = buildTemplateV1Sections();
    expect(sections.find((s) => s.section_type === 'complaints_review')).toBeUndefined();
  });

  it('sums to 120 scheduled minutes across the canonical defaults', () => {
    // 5+5+10+20+20+15+10+15+10+5+5 = 120.
    const sections = buildTemplateV1Sections();
    const total = sections.reduce((sum, s) => sum + s.default_time_alloc_minutes, 0);
    expect(total).toBe(120);
  });

  it('marks every section as visibility=standard at v1 (co_chair_only is TM-fold-2 forward seam)', () => {
    const sections = buildTemplateV1Sections();
    for (const s of sections) {
      expect(s.default_visibility).toBe('standard');
    }
  });
});

describe('seed-meeting-template — template hash determinism', () => {
  it('returns a 64-character hex SHA-256 string', () => {
    const h = templateV1Hash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash across multiple invocations', () => {
    expect(templateV1Hash()).toBe(templateV1Hash());
  });
});

// ---------------------------------------------------------------------------
// In-memory fake DB for the idempotency + chain-payload assertions
// ---------------------------------------------------------------------------

interface FakeAuditRow {
  readonly payload: Record<string, unknown>;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly actorId: string | null;
}

interface FakeTemplateRow {
  readonly template_code: string;
  readonly version_number: number;
  readonly jurisdiction: string;
  readonly sections_json_canonical: string;
  readonly id: string;
}

/**
 * Minimal Drizzle-shaped fake. Implements only the surface the seed
 * script touches: `transaction(fn)`, `execute(sqlTemplate)` for the
 * SELECT-id lookup + INSERT, and the @jhsc/audit append() path's
 * `execute` for the chain-tail SELECT + INSERT.
 *
 * The `execute` parser is a strncmp-style classifier on the SQL
 * fragment; it does not run real SQL. This is the same shape as the
 * `makeFakeDb` helper in audit-log-verify.test.ts (per-test light
 * fakes; no shared mock framework).
 */
function makeFakeDb(): {
  db: DrizzlePg;
  templates: FakeTemplateRow[];
  auditRows: FakeAuditRow[];
} {
  const templates: FakeTemplateRow[] = [];
  const auditRows: FakeAuditRow[] = [];

  // The append() implementation in @jhsc/audit issues these queries via
  // `tx.execute(sql\`...\`)` and `tx.insert(auditLog).values({...})`.
  // We intercept BOTH paths.

  function classify(query: unknown): {
    kind: 'select_template' | 'insert_template' | 'select_audit_tail' | 'advisory_lock' | 'unknown';
    params: ReadonlyArray<unknown>;
  } {
    // Drizzle's `sql` template carries SQLChunks: StringChunk (literals;
    // `value: string[]`) and Param (interpolations; `value: T`). We
    // walk both shapes and project a normalized literal string + a
    // param list for matching.
    const chunks =
      query && typeof query === 'object' && 'queryChunks' in (query as Record<string, unknown>)
        ? ((query as { queryChunks?: unknown }).queryChunks as ReadonlyArray<unknown>)
        : [];
    let literalText = '';
    const params: unknown[] = [];
    for (const c of chunks) {
      if (c && typeof c === 'object') {
        const r = c as Record<string, unknown>;
        // StringChunk: `value: string[]` — the literal between
        // interpolations.
        if (Array.isArray(r.value) && r.value.every((v) => typeof v === 'string')) {
          literalText += ' ' + (r.value as string[]).join(' ');
          continue;
        }
        // Param-like object: `.value` holds the interpolated value.
        if ('value' in r) {
          params.push(r.value);
          continue;
        }
      }
      // Drizzle inlines primitive `${'string'}` and `${42}` directly into
      // the chunks array — they appear as raw string/number/boolean
      // alongside StringChunk objects. Treat them as interpolated params.
      if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
        params.push(c);
      }
    }
    if (/pg_advisory_xact_lock/i.test(literalText)) {
      return { kind: 'advisory_lock', params };
    }
    if (/SELECT\s+id\s+FROM\s+meeting_templates/i.test(literalText)) {
      return { kind: 'select_template', params };
    }
    if (/INSERT\s+INTO\s+meeting_templates/i.test(literalText)) {
      return { kind: 'insert_template', params };
    }
    if (/FROM\s+audit_log/i.test(literalText) && /ORDER\s+BY\s+idx\s+DESC/i.test(literalText)) {
      return { kind: 'select_audit_tail', params };
    }
    return { kind: 'unknown', params };
  }

  function makeTx(): DrizzlePg {
    return {
      transaction: async (fn: (tx: DrizzlePg) => Promise<unknown>) => fn(makeTx()),

      execute: async (query: any) => {
        const c = classify(query);
        if (c.kind === 'select_template') {
          const [code, version] = c.params as [string, number];
          const found = templates.find(
            (t) => t.template_code === code && t.version_number === version,
          );
          return found ? [{ id: found.id }] : [];
        }
        if (c.kind === 'insert_template') {
          const [code, version, _name, jurisdiction, sectionsJson] = c.params as [
            string,
            number,
            string,
            string,
            string,
          ];
          templates.push({
            template_code: code,
            version_number: version,
            jurisdiction,
            sections_json_canonical: sectionsJson,
            id: `template-${templates.length + 1}`,
          });
          return [];
        }
        if (c.kind === 'select_audit_tail') {
          return [];
        }
        if (c.kind === 'advisory_lock') {
          return [];
        }
        return [];
      },

      insert: () => ({
        values: async (row: any) => {
          auditRows.push({
            payload: row.payload as Record<string, unknown>,
            resourceType: row.resourceType ?? null,
            resourceId: row.resourceId ?? null,
            actorId: row.actorId ?? null,
          });
        },
      }),
    } as any;
  }

  return { db: makeTx(), templates, auditRows };
}

describe('seed-meeting-template — idempotency contract', () => {
  it('inserts on first run and skips on second run for the same jurisdiction', async () => {
    const { db, templates, auditRows } = makeFakeDb();
    const first = await seedMeetingTemplate(db, 'ON');
    expect(first.inserted).toBe(1);
    expect(first.skipped).toBe(0);
    expect(templates.length).toBe(1);
    expect(auditRows.length).toBe(1);

    const second = await seedMeetingTemplate(db, 'ON');
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    // Still only one template row + one chain anchor.
    expect(templates.length).toBe(1);
    expect(auditRows.length).toBe(1);
  });

  it('persists the template_code, version_number, and jurisdiction the seed was asked to write', async () => {
    const { db, templates } = makeFakeDb();
    await seedMeetingTemplate(db, 'CA-FED');
    expect(templates[0]).toMatchObject({
      template_code: MEETING_TEMPLATE_CODE,
      version_number: MEETING_TEMPLATE_V1_VERSION,
      jurisdiction: 'CA-FED',
    });
  });
});

describe('seed-meeting-template — chain payload PI-cleanliness', () => {
  it('emits exactly one audit.meeting_template.seeded event with PI-clean fields', async () => {
    const { db, auditRows } = makeFakeDb();
    await seedMeetingTemplate(db, 'ON');
    expect(auditRows.length).toBe(1);
    const payload = auditRows[0]!.payload as Record<string, unknown>;
    expect(payload.kind).toBe('audit.meeting_template.seeded');
    expect(payload.templateVersion).toBe(MEETING_TEMPLATE_V1_VERSION);
    expect(payload.jurisdiction).toBe('ON');
    expect(payload.templateHash).toBe(templateV1Hash());
    // PI-clean: no name field, no displayName, no workplace identifier.
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('displayName');
    expect(payload).not.toHaveProperty('workplaceName');
    expect(payload).not.toHaveProperty('actorName');
    // The v1 template's display name is `MEETING_TEMPLATE_V1_NAME` and
    // the DB row carries it; the chain payload does NOT.
    expect(JSON.stringify(payload)).not.toContain(MEETING_TEMPLATE_V1_NAME);
  });

  it('produces a stable templateHash across seed runs (deterministic across processes)', async () => {
    const { db: db1 } = makeFakeDb();
    const { db: db2 } = makeFakeDb();
    const r1 = await seedMeetingTemplate(db1, 'ON');
    const r2 = await seedMeetingTemplate(db2, 'ON');
    expect(r1.templateHash).toBe(r2.templateHash);
    expect(r1.templateHash).toBe(templateV1Hash());
  });
});
