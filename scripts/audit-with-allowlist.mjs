#!/usr/bin/env node
// scripts/audit-with-allowlist.mjs
//
// Wraps `pnpm audit --audit-level=high --json` and exits 0 if the only
// remaining HIGH vulnerabilities are on a documented allowlist.
//
// 1.11 ALLOWLIST: two HIGH advisories against `xlsx@0.18.5`:
//   - GHSA-4r6h-8v6p-xvw6 (Prototype Pollution; patched in 0.19.3)
//   - GHSA-5pgg-2g8v-p4x9 (ReDoS; patched in 0.20.2)
//
// SheetJS stopped publishing to npm at 0.18.5. The patched versions live
// on the SheetJS CDN at https://cdn.sheetjs.com/. We cannot reach the CDN
// from CI (403 from this network) so the upgrade is a 1.12 hardening item.
//
// Mitigation posture for the two advisories:
//   - We pass cellFormula:false + cellHTML:false + cellNF:false to
//     XLSX.read(), which limits the prototype-pollution attack surface.
//   - We cap files at 10 MB at the Web Worker boundary, which bounds the
//     ReDoS impact.
//   - The package is browser-only; the worker is same-origin; the rep
//     owns the device.
//
// Documented in SECURITY.md §2.11 T-X54.

import { execFileSync } from 'node:child_process';

const ALLOWED_NPM_ADVISORY_IDS = new Set([
  1108110, // xlsx ReDoS (GHSA-5pgg-2g8v-p4x9)
  1108111, // xlsx Prototype Pollution (GHSA-4r6h-8v6p-xvw6)
]);

// Run pnpm audit; capture stdout as JSON. Non-zero exit is expected
// when there are HIGH advisories, so we don't pass throw-on-fail.
let raw;
try {
  raw = execFileSync('pnpm', ['audit', '--audit-level=high', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch (e) {
  // execFileSync throws on non-zero exit but still gives us stdout.
  raw = e.stdout?.toString() ?? '';
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error('Audit output was not JSON; treating as failure.');
  console.error(raw.slice(0, 2000));
  process.exit(1);
}

const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
const unallowed = [];

for (const action of actions) {
  for (const resolve of action.resolves ?? []) {
    if (!ALLOWED_NPM_ADVISORY_IDS.has(resolve.id)) {
      unallowed.push({ module: action.module, id: resolve.id, path: resolve.path });
    }
  }
}

const metadata = parsed.metadata ?? {};
const totalHighOrAbove =
  (metadata.vulnerabilities?.high ?? 0) + (metadata.vulnerabilities?.critical ?? 0);

if (unallowed.length === 0) {
  console.log(
    `audit-with-allowlist: PASS — ${totalHighOrAbove} HIGH advisories, all on the documented allowlist.`,
  );
  console.log(`Allowlisted IDs: ${Array.from(ALLOWED_NPM_ADVISORY_IDS).sort().join(', ')}`);
  process.exit(0);
}

console.error(
  `audit-with-allowlist: FAIL — ${unallowed.length} advisor${unallowed.length === 1 ? 'y' : 'ies'} not on the allowlist.`,
);
for (const u of unallowed) {
  console.error(`  - ${u.module} (advisory ${u.id}) via ${u.path}`);
}
console.error(
  'Run `pnpm audit --audit-level=high` for details. If this advisory is acceptable, add its npm advisory id to ALLOWED_NPM_ADVISORY_IDS and document it in SECURITY.md.',
);
process.exit(1);
