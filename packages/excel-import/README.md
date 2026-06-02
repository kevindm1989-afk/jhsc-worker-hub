# `@jhsc/excel-import`

Browser-only Excel import parser, PII heuristic, content-hash
canonicalization, and reconciliation engine for the JHSC Worker Hub.

See `docs/adr/0010-excel-import.md` for the architecture, `SECURITY.md`
§2.11 (T-X1..T-X44) for the threat model, and
`docs/excel-import-format.md` for the supported workbook schema.

## Non-Negotiable #11 framing

> _"Excel imports are sanitized. Imported files are parsed in the
> browser, sensitive fields encrypted client-side before server sync.
> Imported data never bypasses the audit chain."_

This package is the **structural mitigation** for that rule. The raw
`.xlsx` / `.xlsm` bytes never reach the API. SheetJS runs in a Web
Worker; sensitive fields are envelope-sealed under the workplace
public key (mirrors `apps/web/src/evidence/crypto.ts: sealEvidence`);
the server only ever sees ciphertext + non-PI metadata.

## No-IO contract

This package performs **no IO**. No `fetch`. No `XMLHttpRequest`. No
`navigator.sendBeacon`. No `node:*` imports. No `console.*` side
effects. Every function is pure — same input always produces the same
output. See SECURITY.md T-X2 / T-X16 for the bundle-grep assertion
that enforces the contract.

## Browser-only

The `tsconfig.json` declares `lib: ["ES2022", "DOM"]` and `types: []`.
The DOM lib is needed for `crypto.subtle` and the `Worker` shape; no
Node types are pulled. Consumers (`apps/web`) bundle the package via
Vite; the test suite runs in Vitest's `node` environment (Node 20+
ships `globalThis.crypto.subtle` natively).

## Public API surface

```ts
// Pure helpers (FULL implementation in S1):
canonicalizeDescription(input: string): string;
canonicalizeStartDate(input: string | Date): string;
computeContentHash(description: string, startDate: string | Date): Promise<Uint8Array>;
contentHashHex(hash: Uint8Array): string;
scanForPii(text: string): PiiFlags;

// Workspace entry points (types in S1; bodies in S2):
parseWorkbook(arrayBuffer: ArrayBuffer): Promise<DetectionResult>;
parseWorkbookInWorker(arrayBuffer: ArrayBuffer): Promise<DetectionResult>;
reconcile(parsed: ParsedSheets, existing: ExistingActionItemView[], importId: string): ReconciliationPlan;
commit(plan: ReconciliationPlan, opts: { workplacePublicKey: Uint8Array; importId: string }): Promise<CommitOperations>;
```

Sub-paths for tree-shaking:

- `@jhsc/excel-import/canonical` — content_hash helpers only
- `@jhsc/excel-import/pii` — the 4-class PII heuristic only

## Slice plan

- **S1 (this slice):** scaffolding + canonical.ts (FULL) + pii.ts
  (FULL) + schema types + worker message contract + reconciliation
  stub. Migration 0010 + shared-types enums + audit kinds + format
  spec land alongside.
- **S2:** parsers + detector + Web Worker body + reconciler body +
  commit builder + server commit/reverse routes + integration tests.
- **S3:** upload + preview + commit web UI.
- **S4:** acceptance fixtures + e2e tests.
- **S5:** security + privacy reviewers + runbook.

## Dependency posture

- `xlsx` (SheetJS) is pinned to an exact version `0.18.5` — no
  `^` / `~` range, lockfile integrity-hashed (SECURITY T-X1).
- `libsodium-wrappers` will be added in S2 for the envelope-encryption
  helpers (same posture as `@jhsc/crypto` + `apps/web/src/evidence/`).
- No other runtime dependencies. The PII heuristic is plain regex; the
  canonical helpers use built-in `String.prototype.normalize` +
  `crypto.subtle.digest`.

## Refused changes

Per CLAUDE.md "Refuse These Prompts":

- **Adding any network IO** (`fetch`, `XMLHttpRequest`,
  `navigator.sendBeacon`) to this package → refuse, point to
  non-negotiable #11.
- **Adding `console.*` in committed code** → refuse, point to
  SECURITY T-X16 + CLAUDE.md pre-merge checklist.
- **Treating action items as a sub-concept of hazards** during import
  reconciliation → refuse, point to non-negotiable #12.
- **Hardcoding workplace identifiers** in fixtures or test data →
  refuse, point to non-negotiable #1.
