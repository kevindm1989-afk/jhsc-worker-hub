// If-Match etag helpers (Milestone 1.10 S2, ADR-0009 §3.7).
//
// Every PATCH handler on a mutable entity table (hazards, action_items,
// inspections, inspection_findings, recommendations) compares the
// client's `If-Match: "<integer>"` header against the row's current
// `version` column (under FOR UPDATE) and:
//
//   - 428 precondition_required  — header absent.
//   - 409 version_conflict       — header value doesn't match the
//                                   server's current version. Response
//                                   body carries currentVersion +
//                                   serverState so the client's conflict
//                                   UI can render the three-way merge.
//   - 200 + version + 1          — header matches; the route's UPDATE
//                                   bumps version via the migration-0009
//                                   trigger (or the route can write
//                                   `version = OLD.version + 1` explicitly).
//
// The migration's `bump_version_on_update()` trigger noops when the
// route sets version explicitly; documented in migrations/0009_sync.sql.
//
// The helpers here are pure parsers — no DB access. Each PATCH handler
// is responsible for the FOR UPDATE / version SELECT itself (the parse
// happens outside the transaction so a 428 / parse-error returns without
// holding the row lock).

import type { Context } from 'hono';

/** Parse an `If-Match` header value into an integer (the entity's
 * `version` column). Accepts:
 *   - `"123"`  — strong etag, RFC 9110 §13.1.1 form.
 *   - `123`    — bare integer; older clients without quotes.
 *   - `W/"123"` — REJECTED. Weak etags don't satisfy the strong
 *     comparison required by If-Match per RFC 9110 §8.8.3.4.
 *
 * Returns null on any parse failure; the handler returns 428.
 */
export function parseIfMatchVersion(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  // Reject weak etags.
  if (trimmed.startsWith('W/')) return null;
  // Strip surrounding quotes if present.
  const inner = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  if (!/^[0-9]+$/.test(inner)) return null;
  const n = Number.parseInt(inner, 10);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Read + parse `If-Match` from the request. Returns the parsed integer
 * version, or returns a short-circuit 428 Response if missing/invalid. */
export function readIfMatchOr428(c: Context): number | { precondition_required: Response } {
  const raw = c.req.header('if-match');
  const parsed = parseIfMatchVersion(raw);
  if (parsed === null) {
    return {
      precondition_required: c.json(
        {
          error: 'precondition_required',
          hint: 'PATCH requires If-Match: "<integer>" matching the row version',
        },
        428,
      ),
    };
  }
  return parsed;
}

/** Build the 409 version_conflict body — the shape the client's conflict
 * resolution UI consumes. */
export function versionConflictBody(
  currentVersion: number,
  serverState: unknown,
): { error: 'version_conflict'; currentVersion: number; serverState: unknown } {
  return {
    error: 'version_conflict',
    currentVersion,
    serverState,
  };
}
