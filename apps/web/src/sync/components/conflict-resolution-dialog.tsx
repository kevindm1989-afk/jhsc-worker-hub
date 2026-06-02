// Three-way merge conflict resolution dialog (Milestone 1.10 S3,
// ADR-0009 §3.7, SECURITY.md §2.10 T-S7 / T-S8 / T-S26 / T-S28).
//
// The hardest UI in this slice. The rep arrives here via the
// SyncPanel → "Resolve" button on a sync_conflicts row. The dialog
// presents three columns:
//
//   - "Yours"  — the local snapshot at the time the 409 came back
//   - "Theirs" — the server's canonical row from the 409 response
//   - "Base"   — the _base_state_json the rep had cached before the
//                divergence (i.e. what we thought the server had)
//
// Rights-protective copy is a hard requirement (T-S7):
//   - "Yours" vs "Theirs" — neutral framing.
//   - No "Local edits will be lost" shame copy.
//   - The chain-anchored option uses the verbatim ADR §3.7 framing
//     ("You submitted #3 offline at 10:14am; the server received
//     another submit for #3 at 11:02am. Both are now anchored in
//     the chain. Pick which one is the canonical text; the other
//     becomes a withdrawn record.").
//
// Encrypted-field handling (T-S26, T-S28):
//   - Encrypted fields (observation, body, response body, signature
//     note, description) render as "Encrypted · Reveal to compare"
//     with a button. Tapping fires
//     stepUpEmitter.dispatch('conflict.reveal.<entityKind>') so the
//     global step-up modal can grant a 60s freshness window.
//   - The workplace KEK lives on the server; offline reveal is
//     structurally impossible (ADR §3.6). When offline, the dialog
//     surfaces the NetworkRequiredBanner inline.
//
// Resolution paths:
//   - keep_local — Apply button → "Keep yours"; queues a retry with
//     the local payload + serverVersion as If-Match
//   - keep_remote — "Accept server"; clears the local dirty state +
//     drops the queue row; entity row absorbs serverState
//   - keep_both_chain_anchored — only for chain-anchored events
//     (action_item.moved, recommendation.submitted, inspection.signed,
//     recommendation.exported). Picks a canonical, marks the other a
//     withdrawn duplicate.
//   - manual_merge — opens a per-differing-field picker (Keep yours /
//     Keep theirs); the merged payload is queued as a fresh PATCH.

import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, Eye, GitMerge, Lock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { stepUpEmitter } from '@/auth/api';
import { type SyncConflictResolution, type SyncEntityKind } from '@jhsc/shared-types';
import { baseStateKey, cleanSyncMetadata, db, nowIso, type SyncConflictRow } from '../db';
import { enqueueOp } from '../queue-worker';
import { newClientId } from '../typed-client';
import { NetworkRequiredBanner } from './network-required-banner';

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

/** Entity kinds where keep_both_chain_anchored is a valid resolution.
 * Per ADR §3.7, these are the chain-anchored events whose duplicate
 * can be carried as a withdrawn record rather than discarded. */
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
  readonly onResolved: () => void;
}

export function ConflictResolutionDialog({
  open,
  conflict,
  onClose,
  onResolved,
}: ConflictResolutionDialogProps): JSX.Element | null {
  const local = useMemo(() => safeParse(conflict.localStateJson), [conflict.localStateJson]);
  const server = useMemo(() => safeParse(conflict.serverStateJson), [conflict.serverStateJson]);
  const base = useMemo(() => safeParse(conflict.baseStateJson), [conflict.baseStateJson]);
  const differing = useMemo(() => diffingFields(local, server), [local, server]);

  const [resolution, setResolution] = useState<SyncConflictResolution>('keep_local');
  const [perFieldChoice, setPerFieldChoice] = useState<Record<string, 'yours' | 'theirs'>>({});
  const [revealed, setRevealed] = useState<Record<string, { yours: string; theirs: string }>>({});
  const [activeTab, setActiveTab] = useState<'yours' | 'theirs' | 'base'>('yours');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkBanner, setNetworkBanner] = useState(false);

  const supportsChainAnchored = CHAIN_ANCHORED_KINDS.has(conflict.entityKind);

  const onRevealField = useCallback(
    async (field: string): Promise<void> => {
      setError(null);
      // The workplace KEK is server-side; offline reveal is impossible
      // (T-S26). Surface the banner instead of dispatching step-up that
      // can't complete.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setNetworkBanner(true);
        return;
      }
      // Dispatch step-up so the global StepUpModal opens. The actual
      // decrypt-reveal endpoint is a future cross-cutting concern (the
      // 1.7/1.8/1.9 reveal endpoints each have their own; the server-
      // side conflict-reveal route lands in S2 already wired). For
      // now we surface the affordance + announce the action so the
      // step-up modal can grant the freshness window.
      stepUpEmitter.dispatch(`conflict.reveal.${conflict.entityKind}`);
      // Optimistically mark the field as "revealed" — the actual
      // ciphertext is in localStateJson / serverStateJson under
      // _ct_b64 sister fields, and the server-side reveal route would
      // return plaintext for both. Until that wire is hot we render a
      // placeholder; the dialog still demonstrates the contract.
      setRevealed((prev) => ({
        ...prev,
        [field]: {
          yours: '(reveal pending — complete step-up to load plaintext)',
          theirs: '(reveal pending — complete step-up to load plaintext)',
        },
      }));
    },
    [conflict.entityKind],
  );

  const onApply = useCallback(async (): Promise<void> => {
    if (conflict.id === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await applyResolution({
        conflict,
        resolution,
        perFieldChoice,
        local,
        server,
      });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [conflict, resolution, perFieldChoice, local, server, onResolved]);

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
          {networkBanner ? (
            <div className="mb-3">
              <NetworkRequiredBanner action="Reveal" onDismiss={() => setNetworkBanner(false)} />
            </div>
          ) : null}

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
                revealed={revealed}
                onRevealField={(f) => {
                  void onRevealField(f);
                }}
                visibleOnMobile={activeTab === 'yours'}
              />
              <Column
                title="Theirs"
                subtitle="The server has"
                state={server}
                base={base}
                otherState={local}
                fields={differing}
                revealed={revealed}
                onRevealField={(f) => {
                  void onRevealField(f);
                }}
                visibleOnMobile={activeTab === 'theirs'}
              />
              <Column
                title="Base"
                subtitle="What we had before"
                state={base}
                base={base}
                otherState={null}
                fields={differing}
                revealed={revealed}
                onRevealField={(f) => {
                  void onRevealField(f);
                }}
                visibleOnMobile={activeTab === 'base'}
              />
            </div>
          )}

          {/* Resolution picker */}
          <section
            aria-labelledby="conflict-resolution-heading"
            className="mt-4 rounded-md border border-border bg-background p-3"
          >
            <h3
              id="conflict-resolution-heading"
              className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Resolution
            </h3>
            <div className="space-y-2">
              <ResolutionOption
                value="keep_local"
                current={resolution}
                onChange={setResolution}
                title="Keep yours"
                description="Discard the server's changes and push your version."
              />
              <ResolutionOption
                value="keep_remote"
                current={resolution}
                onChange={setResolution}
                title="Accept server"
                description="Discard your changes and take what the server has."
              />
              {supportsChainAnchored ? (
                <ResolutionOption
                  value="keep_both_chain_anchored"
                  current={resolution}
                  onChange={setResolution}
                  title="Anchor both"
                  description={chainAnchoredCopy(conflict.entityKind)}
                />
              ) : null}
              <ResolutionOption
                value="manual_merge"
                current={resolution}
                onChange={setResolution}
                title="Manual merge"
                description="Choose field-by-field which version to keep."
              />
            </div>

            {resolution === 'manual_merge' && differing.length > 0 ? (
              <div className="mt-3 rounded-md border border-border bg-card p-3">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Per-field picks
                </p>
                <ul className="space-y-2">
                  {differing.map((field) => (
                    <li key={field}>
                      <div className="mb-1 text-xs font-medium text-foreground">{field}</div>
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="radio"
                            name={`pf-${field}`}
                            value="yours"
                            checked={perFieldChoice[field] === 'yours'}
                            onChange={() => setPerFieldChoice((p) => ({ ...p, [field]: 'yours' }))}
                          />
                          <span>Keep yours</span>
                        </label>
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="radio"
                            name={`pf-${field}`}
                            value="theirs"
                            checked={perFieldChoice[field] === 'theirs'}
                            onChange={() => setPerFieldChoice((p) => ({ ...p, [field]: 'theirs' }))}
                          />
                          <span>Keep theirs</span>
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          {error ? (
            <div
              role="alert"
              aria-live="polite"
              className="mt-3 rounded-md border border-status-open/40 bg-status-open/10 p-3 text-sm text-status-open"
            >
              {error}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-2 border-t border-border bg-card px-4 py-3 md:px-6">
          <Button type="button" variant="ghost" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void onApply();
            }}
            disabled={
              busy || (resolution === 'manual_merge' && differing.some((f) => !perFieldChoice[f]))
            }
            aria-label={applyLabel(resolution)}
          >
            {busy ? 'Applying…' : applyLabel(resolution)}
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
  revealed,
  onRevealField,
  visibleOnMobile,
}: {
  title: string;
  subtitle: string;
  state: Record<string, unknown> | null;
  base: Record<string, unknown> | null;
  otherState: Record<string, unknown> | null;
  fields: ReadonlyArray<string>;
  revealed: Record<string, { yours: string; theirs: string }>;
  onRevealField: (field: string) => void;
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
            <FieldValue
              field={field}
              value={state?.[field]}
              columnKind={title.toLowerCase() as 'yours' | 'theirs' | 'base'}
              revealed={revealed}
              onReveal={onRevealField}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FieldValue({
  field,
  value,
  columnKind,
  revealed,
  onReveal,
}: {
  field: string;
  value: unknown;
  columnKind: 'yours' | 'theirs' | 'base';
  revealed: Record<string, { yours: string; theirs: string }>;
  onReveal: (field: string) => void;
}): JSX.Element {
  const isEncrypted = ENCRYPTED_FIELDS.has(field);
  const wasRevealed = revealed[field];
  if (isEncrypted) {
    if (wasRevealed && (columnKind === 'yours' || columnKind === 'theirs')) {
      return (
        <div className="mt-0.5 whitespace-pre-wrap break-words rounded bg-card p-2 text-foreground">
          {columnKind === 'yours' ? wasRevealed.yours : wasRevealed.theirs}
        </div>
      );
    }
    if (columnKind === 'base') {
      return (
        <div className="mt-0.5 flex items-center gap-1 rounded bg-card p-2 text-muted-foreground">
          <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          <span>Encrypted</span>
        </div>
      );
    }
    return (
      <div className="mt-0.5 flex items-center justify-between gap-2 rounded bg-card p-2 text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Encrypted · Reveal to compare
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onReveal(field)}
          aria-label={`Reveal ${field} to compare`}
        >
          <Eye className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          Reveal
        </Button>
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

function ResolutionOption({
  value,
  current,
  onChange,
  title,
  description,
}: {
  value: SyncConflictResolution;
  current: SyncConflictResolution;
  onChange: (v: SyncConflictResolution) => void;
  title: string;
  description: string;
}): JSX.Element {
  const checked = current === value;
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
        checked ? 'border-primary bg-primary/5' : 'border-border bg-card'
      }`}
    >
      <input
        type="radio"
        name="conflict-resolution"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1"
      />
      <div className="min-w-0">
        <div className="font-medium text-foreground">{title}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}

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

function applyLabel(r: SyncConflictResolution): string {
  switch (r) {
    case 'keep_local':
      return 'Keep yours';
    case 'keep_remote':
      return 'Accept server';
    case 'keep_both_chain_anchored':
      return 'Anchor both';
    case 'manual_merge':
      return 'Apply merge';
  }
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

/**
 * Chain-anchored framing per ADR §3.7 — verbatim, with a per-entity-kind
 * concrete scenario so the rep understands what they're anchoring.
 *
 * Exported for tests.
 */
export function chainAnchoredCopy(kind: SyncEntityKind): string {
  switch (kind) {
    case 'recommendation':
      return 'You submitted #3 offline at 10:14am; the server received another submit for #3 at 11:02am. Both are now anchored in the chain. Pick which one is the canonical text; the other becomes a withdrawn record.';
    case 'action_item_move':
      return 'Your section move at 10:14am and another rep’s move at 11:02am both touched this action item. Both are now anchored. Pick which target section is canonical; the other becomes a withdrawn move record.';
    case 'inspection_signature':
      return 'Your offline signature at 10:14am and another rep’s signature at 11:02am both arrived for this role. Both are now anchored. Pick which signature is canonical; the other becomes a withdrawn record.';
    default:
      return 'Both versions are now anchored in the chain. Pick which one is the canonical text; the other becomes a withdrawn record.';
  }
}

// ---------------------------------------------------------------------------
// Apply — write the resolution into Dexie + enqueue the follow-up op
// ---------------------------------------------------------------------------

async function applyResolution(args: {
  conflict: SyncConflictRow;
  resolution: SyncConflictResolution;
  perFieldChoice: Record<string, 'yours' | 'theirs'>;
  local: Record<string, unknown> | null;
  server: Record<string, unknown> | null;
}): Promise<void> {
  const { conflict, resolution, perFieldChoice, local, server } = args;
  if (conflict.id === undefined) return;

  // Resolve which payload we ship to the server.
  let payload: Record<string, unknown> | null = null;
  switch (resolution) {
    case 'keep_local':
      payload = local;
      break;
    case 'keep_remote':
      payload = null; // no follow-up PATCH needed; we just accept server state
      break;
    case 'keep_both_chain_anchored':
      // For 1.10 we mark the conflict resolved and enqueue a follow-up
      // withdrawal op carrying the duplicate-side payload. The server's
      // S2 contract owns the withdrawal kind for each chain-anchored
      // entity kind.
      payload = local;
      break;
    case 'manual_merge': {
      const merged: Record<string, unknown> = { ...(server ?? {}) };
      for (const [field, choice] of Object.entries(perFieldChoice)) {
        if (choice === 'yours') merged[field] = local?.[field];
        else merged[field] = server?.[field];
      }
      payload = merged;
      break;
    }
  }

  await db.transaction('rw', [db.sync_queue, db.sync_conflicts, db._base_state], async () => {
    // Mark the conflict resolved.
    await db.sync_conflicts.update(conflict.id!, { resolved: 1 });
    // Drop any conflicting queue rows for this entity so we don't
    // double-ship.
    const queueRows = await db.sync_queue
      .where('entityLocalId')
      .equals(conflict.entityLocalId)
      .toArray();
    for (const qr of queueRows) {
      if (qr.id !== undefined && qr.state === 'conflicting') {
        await db.sync_queue.delete(qr.id);
      }
    }
  });

  if (resolution === 'keep_remote') {
    // Absorb server state into the entity row + base-state cache.
    const tableName = entityKindToTableInline(conflict.entityKind);
    if (tableName && server !== null) {
      const meta = cleanSyncMetadata(
        conflict.entityLocalId,
        conflict.serverVersion,
        JSON.stringify(server),
      );
      await db.table(tableName).put({
        ...server,
        id: conflict.entityLocalId,
        ...meta,
      });
      await db._base_state.put({
        key: baseStateKey(conflict.entityKind, conflict.entityLocalId),
        entityKind: conflict.entityKind,
        entityLocalId: conflict.entityLocalId,
        version: conflict.serverVersion,
        stateJson: JSON.stringify(server),
        cachedAt: nowIso(),
      });
    }
    return;
  }

  // For all other resolutions, queue a fresh PATCH carrying the resolved
  // payload + the server-reported version as If-Match.
  if (payload !== null) {
    await enqueueOp({
      kind: 'update',
      entityKind: conflict.entityKind,
      entityLocalId: conflict.entityLocalId,
      payload,
      httpMethod: 'PATCH',
      endpoint: defaultEndpointForKind(conflict.entityKind, conflict.entityLocalId),
      ifMatchEtag: conflict.serverVersion,
      idempotencyKey: newClientId(),
    });
  }

  if (resolution === 'keep_both_chain_anchored') {
    // Enqueue a withdrawal follow-up that carries the non-canonical
    // payload. The chain-anchored kinds each have a withdraw / move-
    // back primitive; we surface a single 'transition' op so the
    // server's S2 route can interpret per its withdraw semantics.
    await enqueueOp({
      kind: 'transition',
      entityKind: chainWithdrawalKind(conflict.entityKind),
      entityLocalId: conflict.entityLocalId,
      payload: { reason: 'chain_anchored_duplicate', duplicate: server },
      httpMethod: 'POST',
      endpoint: `${defaultEndpointForKind(conflict.entityKind, conflict.entityLocalId)}/withdraw-duplicate`,
      ifMatchEtag: conflict.serverVersion,
      idempotencyKey: newClientId(),
    });
  }
}

function entityKindToTableInline(kind: SyncEntityKind): string | null {
  switch (kind) {
    case 'hazard':
      return 'hazards';
    case 'action_item':
      return 'action_items';
    case 'action_item_move':
      return 'action_item_moves';
    case 'inspection':
      return 'inspections';
    case 'inspection_finding':
    case 'inspection_finding_promotion':
      return 'inspection_findings';
    case 'inspection_signature':
      return 'inspection_signatures';
    case 'recommendation':
    case 'recommendation_resolution':
    case 'recommendation_withdrawal':
      return 'recommendations';
    case 'recommendation_response':
      return 'recommendation_responses';
    case 'evidence_finalize':
      return 'evidence_files';
  }
}

function defaultEndpointForKind(kind: SyncEntityKind, id: string): string {
  switch (kind) {
    case 'hazard':
      return `/api/hazards/${encodeURIComponent(id)}`;
    case 'action_item':
      return `/api/action-items/${encodeURIComponent(id)}`;
    case 'action_item_move':
      return `/api/action-items/${encodeURIComponent(id)}/move`;
    case 'inspection':
      return `/api/inspections/${encodeURIComponent(id)}`;
    case 'inspection_finding':
    case 'inspection_finding_promotion':
      return `/api/inspections/findings/${encodeURIComponent(id)}`;
    case 'inspection_signature':
      return `/api/inspections/${encodeURIComponent(id)}/signatures`;
    case 'recommendation':
      return `/api/recommendations/${encodeURIComponent(id)}`;
    case 'recommendation_response':
      return `/api/recommendations/${encodeURIComponent(id)}/responses`;
    case 'recommendation_resolution':
      return `/api/recommendations/${encodeURIComponent(id)}/resolve`;
    case 'recommendation_withdrawal':
      return `/api/recommendations/${encodeURIComponent(id)}/withdraw`;
    case 'evidence_finalize':
      return `/api/evidence/${encodeURIComponent(id)}/finalize`;
  }
}

function chainWithdrawalKind(kind: SyncEntityKind): SyncEntityKind {
  switch (kind) {
    case 'recommendation':
      return 'recommendation_withdrawal';
    case 'action_item_move':
      return 'action_item_move';
    case 'inspection_signature':
      return 'inspection_signature';
    default:
      return kind;
  }
}

// Exported for tests.
export const _internal = {
  ENCRYPTED_FIELDS,
  METADATA_FIELDS,
  CHAIN_ANCHORED_KINDS,
  diffingFields,
  safeParse,
  applyResolution,
  chainAnchoredCopy,
  applyLabel,
};
