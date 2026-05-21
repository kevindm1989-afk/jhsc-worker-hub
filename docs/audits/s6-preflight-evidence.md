# S6 Pre-flight Evidence — drizzle-kit bump research

**Date:** 2026-05-20
**Scope:** Research-only enumeration for S6 (drizzle-kit `0.28.1` → `0.31.10` bump). Bump deferred to next session pending path 1 residual decision.
**Outcome:** Bump alone closes 2 of 3 esbuild reachability paths. Path 1 residual via `@esbuild-kit/core-utils` tilde-pin requires separate mitigation (`pnpm.overrides` or wait for drizzle-kit 1.0.0).

---

## Context

S2 (Group B commit `aefe6a5`) closed 2 of the audit's original "4 moderate CVEs" framing; the S2 commit body reframed at closure to name drizzle-kit as the residual source. The remaining 2 instances of advisory `GHSA-67mh-4wv8-2f99` surface via `apps/api > drizzle-kit@0.28.1` chains. The Group B retro (commit `8083644`) named "drizzle-kit bump past 0.28.1" as the Group C / future audit candidate. This document enumerates what the bump would and wouldn't close, ahead of authoring an actual bump PR.

---

## CVE/GHSA distinction

Our advisory is **`GHSA-67mh-4wv8-2f99`** — esbuild dev-server CORS leak, allows cross-origin reads of dev-server responses. Verified via `pnpm audit --json`: `"cves": []` — no CVE assigned to this advisory.

The drizzle-kit 0.31.0 release notes mention "goog-vulnz flags CVE-2024-24790 in esbuild 0.19.7" — this is a **different vulnerability** in esbuild's older Go runtime, not our advisory.

Both vulnerabilities are addressed by drizzle-kit's direct esbuild dep bump (now `^0.25.4`), but only for paths 2 and 3. Path 1's `@esbuild-kit/*` chain pins esbuild to `~0.18.20` regardless of drizzle-kit's direct esbuild version — so `GHSA-67mh-4wv8-2f99` remains reachable via path 1 even after the bump.

**Framing implication for the eventual bump commit body:** do not claim "closes CVE-2024-24790" (not our vuln). The honest framing is "the bump's esbuild target (`^0.25.4`) crosses our advisory's patched floor (`>=0.25.0`) for paths 2 and 3; path 1 remains until separately mitigated."

---

## The 3 reachability paths (empirically verified)

From `pnpm audit --audit-level=moderate` on commit `8083644`:

1. **Path 1:** `apps/api > drizzle-kit@0.28.1 > @esbuild-kit/esm-loader@2.6.5 > @esbuild-kit/core-utils@3.3.2 > esbuild@0.18.20`
2. **Path 2:** `apps/api > drizzle-kit@0.28.1 > esbuild@0.19.12` (direct)
3. **Path 3:** `apps/api > drizzle-kit@0.28.1 > esbuild-register@3.6.0 > esbuild@0.19.12`

Audit table shows 3 paths; `--json` resolves array shows 2 unique findings (esbuild 0.18.20 + 0.19.12; paths 2 and 3 dedupe to the same esbuild instance via pnpm).

---

## drizzle-kit 0.31.10 dep tree shifts (from npm registry)

Verbatim from `pnpm view drizzle-kit@0.31.10 dependencies`:

```
{
  tsx: '^4.21.0',
  esbuild: '^0.25.4',
  '@drizzle-team/brocli': '^0.10.2',
  '@esbuild-kit/esm-loader': '^2.5.5'
}
```

- Direct `esbuild`: bumped to `^0.25.4` (crosses our patched floor `>=0.25.0`)
- `esbuild-register`: **dropped** (not in 0.31.10 deps)
- `@esbuild-kit/esm-loader`: **retained** (`^2.5.5` declared)
- `@drizzle-team/brocli`, `tsx`: additions outside esbuild-CVE scope

---

## Path 1 residual (the bump doesn't close it)

From `pnpm view`:

- `@esbuild-kit/esm-loader@2.6.5` deps: `{ 'get-tsconfig': '^4.7.0', '@esbuild-kit/core-utils': '^3.3.2' }`
- `@esbuild-kit/core-utils@3.3.2` deps: `{ esbuild: '~0.18.20', 'source-map-support': '^0.5.21' }`

The `~` tilde pin (`>=0.18.20 <0.19.0`) structurally locks this chain to the vulnerable esbuild line. No patch within the 0.18.x line escapes the vulnerability.

`@esbuild-kit/*` packages appear unmaintained — esbuild 0.18.20 is from June 2023, the tilde pin has not been bumped since. The same author family also publishes `esbuild-register@3.6.0` (latest, published ~a year ago) — same staleness signal.

---

## Bump-or-defer evidence summary

| Path | Reachability                             | esbuild version | Bump alone closes?                                 |
| ---- | ---------------------------------------- | --------------- | -------------------------------------------------- |
| 1    | via @esbuild-kit/esm-loader > core-utils | 0.18.20         | ✗ (chain retained; esbuild tilde-pinned)           |
| 2    | direct drizzle-kit dep                   | 0.19.12         | ✓ (bumped to ^0.25.4)                              |
| 3    | via esbuild-register                     | 0.19.12         | ✓ (esbuild-register dropped from drizzle-kit deps) |

Net effect of bump alone: vulnerable esbuild instances reduced from 2 to 1.

---

## Exploit-path applicability (shapes urgency, not just hygiene)

`GHSA-67mh-4wv8-2f99` is a dev-server CORS leak — applies only when esbuild runs in dev-server mode (`esbuild --serve`), where it binds a localhost HTTP server intended for a browser to fetch bundled output. The attack scenario requires a victim's browser to access an attacker-controlled page while also having esbuild's dev server running locally; the malicious page then issues cross-origin `fetch()` to the dev server and reads the response because esbuild sets `Access-Control-Allow-Origin: *`.

drizzle-kit invokes esbuild as a CLI bundler for migration scripts (`drizzle-kit generate`, `drizzle-kit migrate`) — no server bound, no browser interaction, no `--serve` mode. The vulnerability is **technically present** in our dep tree but doesn't apply to our usage path.

This shapes the urgency: the residual is a hygiene concern, not a security one. Deferral is acceptable specifically because we are not exposed via the actual exploit shape — only via the audit-tool's path-based reachability count.

---

## Open questions for next session

- **`pnpm.overrides` viability:** can we force `@esbuild-kit/core-utils > esbuild` to `>=0.25.0` without breaking drizzle-kit's migration generation? Test surface: `pnpm db:generate` + `pnpm db:migrate` against a throwaway schema.
- **drizzle-kit 1.0.0 ETA:** latest published is `1.0.0-rc.4-*` builds; no stable `1.0.0` yet. Does `1.0.0` drop `@esbuild-kit/esm-loader`? (0.30.0 release teased an "updated migration workflow" — possibly the dep-cleanup point.)
- **Bump scope decision:** if `1.0.0` lands soon and drops the `@esbuild-kit/esm-loader` chain entirely, the cleanest path is to wait. If `1.0.0` is months away or doesn't drop the chain, `pnpm.overrides` becomes the path.

---

## State at write

- Local main = origin/main = `8083644` (post-Group B retro)
- Working tree clean prior to this commit
- Memory dir: 12 entries (unchanged this session)
- `pnpm audit --audit-level=moderate`: exit 1, 2 vulnerabilities (both `GHSA-67mh-4wv8-2f99` instances; esbuild 0.18.20 + 0.19.12)
- drizzle-kit current: `0.28.1` (apps/api devDep)
- drizzle-kit latest stable: `0.31.10`; `1.0.0` in RC (`rc.4`)
