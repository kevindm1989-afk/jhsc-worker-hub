# `audit-log-verify --full --report=json` — schema reference

Companion to `docs/release-1-deploy-runbook.md` §4.7 and
`docs/release-1-backup-restore-runbook.md` §3.6. Documents the
exact JSON shape produced by the audit chain verifier so an operator
can rely on the report's fields without reading the source.

The verifier lives at `apps/api/src/lib/audit-verify-full.ts`; the
CLI entry is `apps/api/scripts/audit-log-verify.ts`. The shape below
matches the `FullVerifyReport` interface (the source of truth) plus
the `renderJsonReport` wire format.

Per S5 M-1 — the runbook references the report; this document makes
the schema-side contract explicit so a future renderer change is a
schema-versioning event, not silent drift.

## Top-level shape

```typescript
{
  /** Whether the entire walk passed. False if ANY divergence appears
   *  in `divergences[]`. The exit code mirrors this — 0 on true, 1 on
   *  false, 2 on operational error (DB unreachable, etc.). */
  ok: boolean;

  /** Number of audit_log rows the walk visited. */
  rowCount: number;

  /** First idx in the walk range. Null when rowCount === 0. */
  lowestIdx: number | null;

  /** Last idx in the walk range. Null when rowCount === 0. */
  highestIdx: number | null;

  /** Per-kind tally of the rows visited. Key = chain kind (e.g.
   *  `auth.signin`, `hazard.created`, `action_item.moved`); value =
   *  count. New kinds added in post-Release-1 milestones surface
   *  here automatically. */
  rowsByKind: Record<string, number>;

  /** Per-class counts. The runbook's pass criterion is "every count
   *  is zero". A non-zero count maps to one or more entries in
   *  `divergences[]` of the corresponding `kind`. */
  counts: {
    /** Row-edit signal — a payload was mutated after the hash was
     *  written. Maps to `divergences[].kind === 'payload_hash_mismatch'`. */
    hashMismatches: number;
    /** Broken prev_hash linkage. Maps to
     *  `divergences[].kind === 'chain_link_mismatch'` and to
     *  `genesis_prev_hash_invalid` for the idx=0 case. */
    chainLinkMismatches: number;
    /** Missing idx in the sequence. Maps to
     *  `divergences[].kind === 'idx_gap'`. */
    gaps: number;
    /** Payload structurally wrong (kind mismatch, not an object,
     *  etc.). Maps to `divergences[].kind === 'payload_shape_mismatch'`. */
    payloadShapeMismatches: number;
    /** Per-actor timestamp regression (substitute for the missing
     *  per-actor sequence column — see Gap-2 in
     *  `release-1-audit-verify-gaps.md`). Maps to
     *  `divergences[].kind === 'actor_timestamp_regression'`. */
    actorTimestampRegressions: number;
  }

  /** Window applied to this run (informational; echoed back so the
   *  consumer can disambiguate divergences without re-parsing CLI
   *  flags). */
  window: {
    sinceIso: string | null;
    fromIdx: number | null;
    toIdx: number | null;
  }

  /** Documented checks that this run did NOT perform (per
   *  `docs/release-1-audit-verify-gaps.md`). The operator sees the
   *  skip list explicitly so the missing checks are not silent. */
  skippedChecks: Array<{ id: string; reason: string }>;

  /** Wall-clock duration of the walk in milliseconds. */
  durationMs: number;

  /** All divergences encountered. Empty array on a clean walk; a
   *  populated array tracks each failure mode discriminated by `kind`.
   *  See the per-kind shapes below. */
  divergences: Array<FullVerifyDivergence>;
}
```

## `FullVerifyDivergence` per-kind shapes

```typescript
// Broken prev_hash link.
{
  kind: 'chain_link_mismatch';
  idx: number;
  detail: string; // `expected prev_hash=... got ...`
}

// Stored this_hash does not match recomputed.
{
  kind: 'payload_hash_mismatch';
  idx: number;
  storedHashHex: string; // 64 hex chars
  recomputedHashHex: string; // 64 hex chars
}

// Missing idx in the sequence. The `windowBoundary` field (added in
// S5 F-S2) disambiguates "operator-intentional window edge" from
// "real deletion at the leading edge".
{
  kind: 'idx_gap';
  idx: number;
  previousIdx: number | null; // null at leading edge
  windowBoundary: boolean;
  //  - true  → the operator passed `--since` (or `--from-idx`) and
  //            the leading row is inside the window deliberately.
  //            Currently the verifier suppresses this entirely; the
  //            field is reserved for forward-compatibility with
  //            informational windowed-walk diagnostics.
  //  - false → real mid-walk or unbounded-walk leading gap.
}

// idx=0 row's prev_hash is not the genesis sentinel.
{
  kind: 'genesis_prev_hash_invalid';
  idx: 0;
}

// Payload structurally wrong.
{
  kind: 'payload_shape_mismatch';
  idx: number;
  detail: string; // e.g. `payload.kind='X' but row.kind='Y'`
}

// Per-actor timestamp went backwards (substitute for missing
// per-actor sequence column — see Gap-2).
{
  kind: 'actor_timestamp_regression';
  actorId: string;
  priorIdx: number;
  priorTsMs: number;
  currentIdx: number;
  currentTsMs: number;
}
```

## Sample clean report

```json
{
  "ok": true,
  "rowCount": 2,
  "lowestIdx": 0,
  "highestIdx": 1,
  "rowsByKind": {
    "audit.genesis": 1,
    "audit.backfill.1_2_auth_events": 1
  },
  "counts": {
    "hashMismatches": 0,
    "chainLinkMismatches": 0,
    "gaps": 0,
    "payloadShapeMismatches": 0,
    "actorTimestampRegressions": 0
  },
  "window": {
    "sinceIso": null,
    "fromIdx": null,
    "toIdx": null
  },
  "skippedChecks": [
    {
      "id": "gap-1",
      "reason": "Ed25519 signature check skipped — no signing_key_id/signature columns on audit_log"
    },
    {
      "id": "gap-2",
      "reason": "per-actor sequence check substituted with per-actor timestamp-monotonicity — no sequence column on audit_log"
    },
    {
      "id": "gap-3",
      "reason": "per-kind field validation deferred to --check-{inspections,recommendations,excel} forward-defense flags"
    }
  ],
  "durationMs": 4521,
  "divergences": []
}
```

## Versioning

This schema is the contract as of Milestone 1.12 S5. Field additions
are backward-compatible (consumers should ignore unknown keys); field
removals or shape changes require a coordinated bump. Tracked in
`docs/release-1-audit-verify-gaps.md` under "Schema versioning".
