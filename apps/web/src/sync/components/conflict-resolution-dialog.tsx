// Three-way merge conflict resolution dialog (Milestone 1.10 S3,
// ADR-0009 §3.7, SECURITY.md §2.10 T-S7 / T-S8 / T-S26 / T-S28 /
// T-S53).
//
// S5 fix bundle (priv-F4 + sec-F3 + sec-F4 close-out, per user
// authorization): the Apply pipeline is DISABLED in 1.10 and lands in
// 1.12. The dialog ships VIEW-ONLY in 1.10. The reasoning:
//
//   sec-F3: the prior defaultEndpointForKind map shipped requests to
//     endpoints that don't exist server-side
//     (action_item_move → /move s.b. /moves; finding_promotion →
//     /findings/:id s.b. /promote; evidence_finalize → /finalize s.b.
//     /; withdraw-duplicate didn't exist anywhere). Every chain-
//     anchored resolution dead-lettered after 8 retries; the amber
//     chip never cleared; the dead-letter row's lastError leaked the
//     attempted URL.
//   sec-F4: the keep_local / manual_merge paths shipped the raw
//     local Dexie row (carrying _sync_* metadata + id + version +
//     createdAt + updatedAt) verbatim as the PATCH body — every
//     server PATCH route uses .strict() Zod schemas, so the request
//     400'd as invalid_body and dead-lettered.
//   priv-F4: the encrypted-field reveal dispatched step-up but never
//     fetched plaintext, so the rep made a substantive evidentiary
//     decision (pick local vs server for an encrypted body) against
//     two unreadable placeholders. Burning a step-up grant on a non-
//     functional affordance is a CLAUDE.md #16 spirit violation.
//
// Per user authorization, the 1.10 surface is:
//
//   - Three-way comparison columns (Yours / Theirs / Base) SHIP — the
//     rep can compare any plaintext metadata fields side-by-side.
//   - Encrypted-field rows render an honest placeholder: "Encrypted.
//     The Apply pipeline ships in 1.12. To compare encrypted bodies
//     in 1.10, contact your operator." No Reveal button (no step-up
//     dispatch for a no-op).
//   - Apply button DISABLED with an explanatory notice pointing the
//     rep at the operator-script path documented in
//     docs/runbooks/offline-sync.md §7 ("Conflict resolution
//     stance").
//   - The defaultEndpointForKind map + the resolution-submission
//     code (applyResolution) are removed entirely. They are not
//     called when Apply is disabled, and keeping the dead code
//     invited a future PR to silently re-enable the broken pipeline.
//
// The 1.12 pipeline backlog covers: correct endpoint mapping per
// entity kind, strip _sync_* metadata before PATCH, wire encrypted-
// field decrypt via the existing reveal endpoints with step-up, full
// integration test against every chain-anchored variant. Documented
// in docs/runbooks/offline-sync.md §12 (1.12 hardening backlog).
//
// The original three-way framing remains in the comments below for
// the 1.12 implementer to follow:
//
//   - "Yours"  — the local snapshot at the time the 409 came back
//   - "Theirs" — the server's canonical row from the 409 response
//   - "Base"   — the _base_state_json the rep had cached before the
//                divergence (i.e. what we thought the server had)
//
// Rights-protective copy (T-S7) is preserved across the dialog:
//   - "Yours" vs "Theirs" — neutral framing.
//   - No "Local edits will be lost" shame copy.
//   - The "Apply unavailable" notice points at the operator path
//     without anxiety-inducing language.

import { useMemo, useState } from 'react';
import { ChevronLeft, GitMerge, Info, Lock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type SyncEntityKind } from '@jhsc/shared-types';
import { type SyncConflictRow } from '../db';

// ---------------------------------------------------------------------------
// Field classification
// ---------------------------------------------------------------------------

/** Set of field names that are ENCRYPTED at rest server-side. Reveal
 * triggers step-up; offline reveal is structurally impossible (the
 * workplace private key lives on the server). Mirrors the server's
 * encrypted-projection list. */
const ENCRYPTED_FIELDS = new Set([
  'description',
  'title',
  'body',
  'observation',
  'correctiveAction',
  'responsibleParty',
  'responsiblePartyText',
  'signatureNote',
  'authorRole',
  'reporter',
  'summary',
]);

/** Set of metadata fields the merge should NEVER diff against — these
 * are sync plumbing or server-controlled fields. */
const METADATA_FIELDS = new Set([
  'id',
  '_sync_state',
  '_local_id',
  '_server_version',
  '_base_state_json',
  '_updated_at_client',
  '_synced_at',
  'version',
  'createdAt',
  'updatedAt',
]);

/** Entity kinds where the chain-anchored "anchor both" resolution
 * would land in the 1.12 pipeline. Kept here as documentation for the
 * 1.12 implementer; not consumed in 1.10 because the Apply path is
 * disabled. */
const CHAIN_ANCHORED_KINDS = new Set<SyncEntityKind>([
  'action_item_move',
  'recommendation',
  'inspection_signature',
]);

/** Lazy-safe JSON parse — returns the input as `unknown` (object/null). */
function safeParse(json: string): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Compute the set of fields that differ between local and server. We
 * skip metadata fields and anything where local === server. */
function diffingFields(
  local: Record<string, unknown> | null,
  server: Record<string, unknown> | null,
): ReadonlyArray<string> {
  if (local === null && server === null) return [];
  const keys = new Set<string>();
  if (local !== null) for (const k of Object.keys(local)) keys.add(k);
  if (server !== null) for (const k of Object.keys(server)) keys.add(k);
  const out: string[] = [];
  for (const k of keys) {
    if (METADATA_FIELDS.has(k)) continue;
    const lv = local?.[k];
    const sv = server?.[k];
    if (JSON.stringify(lv) !== JSON.stringify(sv)) out.push(k);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface ConflictResolutionDialogProps {
  readonly open: boolean;
  readonly conflict: SyncConflictRow;
  readonly onClose: () => void;
  /**
   * No-op in 1.10 (T-S53). Kept on the prop surface so 1.10 call
   * sites (sync-panel) don't need to change; the 1.12 Apply pipeline
   * will start calling it again. The current dialog never resolves
   * anything — Apply is disabled and the conflict-row clearing is an
   * operator action.
   */
  readonly onResolved?: () => void;
}

export function ConflictResolutionDialog({
  open,
  conflict,
  onClose,
  onResolved: _onResolved,
}: ConflictResolutionDialogProps): JSX.Element | null {
  void _onResolved;
  const local = useMemo(() => safeParse(conflict.localStateJson), [conflict.localStateJson]);
  const server = useMemo(() => safeParse(conflict.serverStateJson), [conflict.serverStateJson]);
  const base = useMemo(() => safeParse(conflict.baseStateJson), [conflict.baseStateJson]);
  const differing = useMemo(() => diffingFields(local, server), [local, server]);

  const [activeTab, setActiveTab] = useState<'yours' | 'theirs' | 'base'>('yours');

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-dialog-title"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="flex w-full flex-col bg-card shadow-2xl md:max-h-[90vh] md:max-w-4xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3 md:px-6">
          <div className="flex min-w-0 items-start gap-2">
            <GitMerge
              className="mt-0.5 h-4 w-4 shrink-0 text-status-pending"
              strokeWidth={2}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2
                id="conflict-dialog-title"
                className="text-base font-semibold tracking-tight text-foreground"
              >
                Sync conflict on {humanEntityKind(conflict.entityKind)} — local vs server
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Local id{' '}
                <span className="font-mono tabular-nums">{conflict.entityLocalId.slice(0, 8)}</span>{' '}
                · detected {new Date(conflict.detectedAt).toLocaleString()} · server version{' '}
                <span className="font-mono tabular-nums">{conflict.serverVersion}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        {/* Mobile tab strip — desktop renders all three columns side-by-side. */}
        <nav
          aria-label="Compare versions"
          className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1 md:hidden"
        >
          <TabButton active={activeTab === 'yours'} onClick={() => setActiveTab('yours')}>
            Yours
          </TabButton>
          <TabButton active={activeTab === 'theirs'} onClick={() => setActiveTab('theirs')}>
            Theirs
          </TabButton>
          <TabButton active={activeTab === 'base'} onClick={() => setActiveTab('base')}>
            Base
          </TabButton>
        </nav>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 md:px-6">
          {differing.length === 0 ? (
            <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
              No diffing fields found. The conflict may have resolved itself; try syncing again.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {/* Mobile renders only the active tab; desktop renders all three. */}
              <Column
                title="Yours"
                subtitle="Your local edit"
                state={local}
                base={base}
                otherState={server}
                fields={differing}
                visibleOnMobile={activeTab === 'yours'}
              />
              <Column
                title="Theirs"
                subtitle="The server has"
                state={server}
                base={base}
                otherState={local}
                fields={differing}
                visibleOnMobile={activeTab === 'theirs'}
              />
              <Column
                title="Base"
                subtitle="What we had before"
                state={base}
                base={base}
                otherState={null}
                fields={differing}
                visibleOnMobile={activeTab === 'base'}
              />
            </div>
          )}

          {/* priv-F4 + sec-F3 + sec-F4 close-out (T-S53): operator-script
              notice replaces the broken Resolution picker. The Apply
              path lands in 1.12; until then, the operator-script
              template in docs/runbooks/offline-sync.md §7 is the
              documented recovery path. Rights-protective tone: no
              shame, no anxiety-induce. */}
          <section
            aria-labelledby="conflict-resolution-heading"
            className="mt-4 rounded-md border border-status-pending/40 bg-status-pending/5 p-3"
          >
            <h3
              id="conflict-resolution-heading"
              className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-status-pending"
            >
              <Info className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Conflict resolution lands in 1.12
            </h3>
            <p className="text-sm text-foreground">
              Compare the columns above to understand what diverged. To resolve this conflict in
              1.10, an operator can:
            </p>
            <ol className="ml-5 mt-2 list-decimal space-y-1 text-sm text-foreground">
              <li>Inspect the local and server states above.</li>
              <li>Decide which is canonical.</li>
              <li>
                Run the resolution script (template in
                <span className="ml-1 font-mono text-xs">docs/runbooks/offline-sync.md §7</span>)
                against the server database.
              </li>
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">
              Your local row stays untouched; the conflict remains visible in the sync panel until
              an operator clears it.
            </p>
          </section>
        </div>

        {/* Footer — Apply is disabled in 1.10 (T-S53). */}
        <footer className="flex items-center justify-between gap-2 border-t border-border bg-card px-4 py-3 md:px-6">
          <Button type="button" variant="ghost" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Close
          </Button>
          <Button
            type="button"
            disabled
            aria-label="Apply (unavailable until 1.12)"
            title="Conflict resolution Apply lands in 1.12; see docs/runbooks/offline-sync.md §7"
          >
            Apply (1.12)
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column — renders one of Yours / Theirs / Base. Encrypted fields get a
// "Reveal to compare" button; plain fields render the value directly.
// ---------------------------------------------------------------------------

function Column({
  title,
  subtitle,
  state,
  base,
  otherState,
  fields,
  visibleOnMobile,
}: {
  title: string;
  subtitle: string;
  state: Record<string, unknown> | null;
  base: Record<string, unknown> | null;
  otherState: Record<string, unknown> | null;
  fields: ReadonlyArray<string>;
  visibleOnMobile: boolean;
}): JSX.Element {
  void base;
  void otherState;
  return (
    <section
      aria-label={title}
      className={`rounded-md border border-border bg-background p-3 ${
        visibleOnMobile ? 'block' : 'hidden md:block'
      }`}
    >
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground">{title}</h3>
      <p className="mb-2 text-[11px] text-muted-foreground">{subtitle}</p>
      <ul className="space-y-2 text-xs">
        {fields.map((field) => (
          <li key={field}>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {field}
            </div>
            <FieldValue field={field} value={state?.[field]} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FieldValue({ field, value }: { field: string; value: unknown }): JSX.Element {
  const isEncrypted = ENCRYPTED_FIELDS.has(field);
  if (isEncrypted) {
    // priv-F4 + sec-F6 close-out (T-S53): honest placeholder. The
    // Apply pipeline lands in 1.12; reveal is not wired because the
    // resolution path it would feed is disabled. Burning a step-up
    // grant on a non-functional affordance violates the spirit of
    // CLAUDE.md #16 (step-up should always do useful work).
    return (
      <div className="mt-0.5 flex items-start gap-1 rounded bg-card p-2 text-muted-foreground">
        <Lock className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <span>
          Encrypted. The Apply pipeline ships in 1.12. To compare encrypted bodies in 1.10, contact
          your operator.
        </span>
      </div>
    );
  }
  return (
    <div className="mt-0.5 whitespace-pre-wrap break-words rounded bg-card p-2 font-mono text-[11px] tabular-nums text-foreground">
      {renderPlain(value)}
    </div>
  );
}

function renderPlain(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Resolution radio + apply helpers
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function humanEntityKind(k: SyncEntityKind): string {
  switch (k) {
    case 'hazard':
      return 'hazard';
    case 'action_item':
      return 'action item';
    case 'action_item_move':
      return 'action item move';
    case 'inspection':
      return 'inspection';
    case 'inspection_finding':
      return 'finding';
    case 'inspection_signature':
      return 'inspection signature';
    case 'inspection_finding_promotion':
      return 'finding promotion';
    case 'recommendation':
      return 'recommendation';
    case 'recommendation_response':
      return 'recommendation response';
    case 'recommendation_resolution':
      return 'recommendation resolution';
    case 'recommendation_withdrawal':
      return 'recommendation withdrawal';
    case 'evidence_finalize':
      return 'evidence upload';
  }
}

// ---------------------------------------------------------------------------
// Apply pipeline — DEFERRED to 1.12
// ---------------------------------------------------------------------------
//
// The S2 Apply pipeline was removed in S5 per priv-F4 + sec-F3 + sec-F4
// close-out (T-S53). The removed code:
//
//   - `applyResolution()` — wrote sync_conflicts.resolved=1, dropped
//     conflicting queue rows, absorbed server state for keep_remote,
//     enqueued a fresh PATCH for keep_local / manual_merge, and
//     enqueued a withdraw follow-up for keep_both_chain_anchored.
//   - `defaultEndpointForKind()` — built the URL the PATCH would hit.
//     The map was wrong on FOUR of the seven non-hazard kinds:
//       * action_item_move → /api/action-items/:id/move
//         (server route is /moves — PLURAL — see action-items/index.ts
//         line 825). Every move resolution 404'd → dead-letter.
//       * inspection_finding_promotion → /api/inspections/findings/:id
//         (server route is /api/inspections/findings/:id/promote and
//         requires POST not PATCH). Every promotion resolution failed.
//       * inspection_signature → PATCH /api/inspections/:id/signatures
//         (server route is POST only; PATCH would 405). Signatures are
//         append-only — no PATCH route exists.
//       * evidence_finalize → /api/evidence/:id/finalize
//         (server route is POST /api/evidence — empty suffix; see
//         evidence/index.ts line 190).
//     Plus the synthesized `${endpoint}/withdraw-duplicate` URL the
//     keep_both_chain_anchored branch built — that endpoint doesn't
//     exist anywhere in the server. Every chain-anchored resolution
//     dead-lettered after 8 retries.
//   - `entityKindToTableInline()` — for the keep_remote branch only;
//     not load-bearing without applyResolution.
//   - `chainWithdrawalKind()` — for the keep_both_chain_anchored
//     branch; not load-bearing.
//   - `chainAnchoredCopy()` — the verbatim ADR §3.7 framing surfaced
//     in the chain-anchored radio option's description. Removed
//     because the option is gone in 1.10.
//   - `applyLabel()` — the per-resolution button label
//     ("Keep yours" / "Accept server" / "Anchor both" / "Apply merge"),
//     not load-bearing without the picker.
//   - `ResolutionOption` component — the radio for keep_local /
//     keep_remote / keep_both_chain_anchored / manual_merge.
//   - The per-field manual-merge picker.
//
// All of these were called only from applyResolution() or rendered
// only inside the resolution picker. Removing them together is the
// cleanest signal to the next reviewer that the Apply pipeline is a
// 1.12 deliverable. The 1.12 implementer should also strip the
// _sync_* metadata + id + version + createdAt + updatedAt from the
// payload before enqueueing — sec-F4 documented that the prior
// implementation shipped the raw local Dexie row, which the server's
// .strict() Zod schemas rejected with 400 invalid_body.
//
// See docs/runbooks/offline-sync.md §7 (Conflict resolution stance)
// for the operator-script template that covers the 1.10 manual-
// recovery path and §12 (1.12 hardening backlog) for the full
// Apply pipeline scope.

// Exported for tests. The runtime API surface is intentionally
// narrowed in 1.10 — no applyResolution / chainAnchoredCopy / etc.
// because they don't exist anymore.
export const _internal = {
  ENCRYPTED_FIELDS,
  METADATA_FIELDS,
  CHAIN_ANCHORED_KINDS,
  diffingFields,
  safeParse,
};
