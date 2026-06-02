// Integration tests for /api/excel-imports/* — Milestone 1.11 S2.
//
// Skips when DATABASE_URL is unset, matching the 1.5 / 1.6 / 1.7 / 1.8 /
// 1.9 / 1.10 pattern. S2 lands STUBS — describe.skipIf wrappers around
// the test names so the test surface is visible in the suite even when
// the bodies are deferred to S4. S4 fleshes out each `it.todo` into a
// real assertion against a fixture workbook + a posted batch + the
// resulting chain.
//
// Stub coverage map:
//   1.  POST creates a pending import + chain anchor.
//   2.  PATCH transitions pending → preview.
//   3.  POST /items batch-inserts excel_import_items in preview state.
//   4.  POST /commit happy path (creates + updates + skips; chain
//       anchor fires).
//   5.  POST /commit with conflicts → 422 conflicts_unresolved.
//   6.  POST /commit twice → second hits Idempotency-Key cache.
//   7.  POST /commit without step-up → 401 with WWW-Authenticate.
//   8.  POST /reverse happy path.
//   9.  POST /reverse after 30 days → 410 import_too_old_to_reverse.
//   10. POST /reverse without step-up → 401.
//   11. POST /cancel from pending → 200.
//   12. POST /cancel from committed → 422 invalid_state_transition.
//   13. Trigger fail-closed: INSERT action_items with
//       source_type='excel_import' + bogus source_id → SQL exception.

import { beforeAll, beforeEach, describe, it } from 'vitest';
import { app } from '../../index';
import { bootAuthTestEnv } from '../../auth/test-setup';
import { cleanAuthTables, hasDb } from '../../auth/test-db';
import { _resetRateLimitForTests } from '../../middleware/rate-limit';
import { _resetExcelImportBucketsForTests } from './index';

const SKIP = !hasDb();

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  _resetRateLimitForTests();
  _resetExcelImportBucketsForTests();
  await cleanAuthTables();
});

// Touching `app` keeps the symbol in the typechecker's mind for the
// S4 close-out; the test bodies all use `await app.request(...)`.
void app;

describe.skipIf(SKIP)('/api/excel-imports — S2 stubs (S4 lands the full bodies)', () => {
  it.todo('POST / creates a pending import with chain anchor (excel_import.uploaded)');
  it.todo('PATCH /:id transitions pending → preview + stamps previewed_at');
  it.todo('POST /:id/items batch-inserts excel_import_items in preview state');
  it.todo('POST /:id/items rejects duplicate content_hash within one import (422)');
  it.todo('POST /:id/commit happy path: creates + updates + skips; emits chain anchors');
  it.todo('POST /:id/commit emits per-row anchors carrying createdByImportId');
  it.todo('POST /:id/commit with conflict_pending items → 422 conflicts_unresolved');
  it.todo('POST /:id/commit twice with same Idempotency-Key → cache hit on second');
  it.todo('POST /:id/commit without step-up → 401 + WWW-Authenticate: StepUp');
  it.todo('POST /:id/reverse happy path: deletes created + reverts updated; emits anchor');
  it.todo('POST /:id/reverse after 30 days → 410 import_too_old_to_reverse');
  it.todo('POST /:id/reverse without step-up → 401 + WWW-Authenticate: StepUp');
  it.todo('POST /:id/cancel from pending → 200 + status=cancelled');
  it.todo('POST /:id/cancel from committed → 422 invalid_state_transition');
  it.todo('Trigger fail-closed: INSERT action_items source_type=excel_import + bogus source_id');
  it.todo('GET / lists actor imports with per-status counts');
  it.todo('GET /:id decrypts source_filename for display');
  it.todo('GET /:id/items paginates with default limit=100, max=500');
  it.todo('Cross-actor GET /:id returns 404 (single-tenant boundary)');
});
