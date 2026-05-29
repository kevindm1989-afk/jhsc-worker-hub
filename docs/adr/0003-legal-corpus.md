# ADR-0003: Legal Corpus — versioned statute schema, `<CitationRef />`, and FTS-backed Legal Reference screen

**Status:** Accepted
**Date:** 2026-05-29
**Decider(s):** architect (this session) — to be reviewed by user

---

## Context

Milestone 1.4 of `ROADMAP.md` lands the **single source of truth** for legal references the app uses. CLAUDE.md non-negotiables #5 and the §"Legal Reference Module Rules" section make the design constraints explicit:

- Every entry has `source_url`, `version_date`, `verified_by` fields.
- App never generates a citation outside the corpus.
- Generated documents record the corpus entry hash in provenance metadata.
- Corpus updates = versioned migrations, never edited in place.
- CSA / ISO / ACGIH are copyrighted — store summaries, citations, clause numbers; never full text.

  1.5 (Hazards) wants `<CitationRef />` so a hazard linked to s.25(2)(h) OHSA renders the clause card on hover/tap-hold. 1.6 (Recommendations) needs the same component for s.9(20) drafting. 1.9 (Recommendations PDF generation) needs the corpus-entry hash for provenance metadata.

Scope of seed data per ROADMAP:

- **OHSA** core sections (Ontario _Occupational Health and Safety Act_, R.S.O. 1990, c. O.1) — supervisor duties (s.25, s.27), worker rights (s.43 refusal, s.50 reprisal), JHSC operation (s.8, s.9), inspector powers (s.54–s.57).
- **O. Reg. 851** — _Industrial Establishments_ under OHSA; subset relevant to JHSC operation.
- **CLC Part II** (federal _Canada Labour Code Part II_) — work refusal s.128, reprisal s.147, committee operation s.135.
- **COHSR** — _Canada Occupational Health and Safety Regulations_ under CLC Part II; subset relevant to JHSC.

## Decision drivers

- Generated citations must be **verifiable** — the rep must be able to defend a recommendation that cites s.9(20) by clicking the citation in their own UI and seeing the exact text, the consolidation date, and the regulator-source URL.
- Corpus updates are **immutable** — a 2026 consolidation of OHSA cannot retroactively change the text shown on a recommendation drafted in 2025. The recommendation records the corpus entry's hash at the moment of drafting; the same hash always retrieves the same body.
- Statute lookups must be **fast at the FTS layer** (full-text search over the loaded corpus on the Legal Reference screen) and **O(1) at the citation layer** (`<CitationRef section="s.9(20)" statute="OHSA" />` resolves by primary key, not search).
- The corpus must work **offline** once loaded. 1.10 lands the Dexie sync layer; 1.4 designs the table shape that's syncable.
- **Copyright safety:** the schema must make it structurally impossible to seed a CSA standard's full text. The seeder rejects entries whose `body` exceeds a configured length for copyrighted-source statutes.

## Options considered

### Option A: Two tables — `statutes` + `clauses` — plus a `corpus_versions` ledger

Land `packages/legal-corpus` with:

- `statutes` (one row per Act / Regulation): id, jurisdiction, name, short_name, citation_form, source_url, last_consolidation, copyright_status.
- `clauses` (one row per leaf citation): id, statute_id, citation (`s.9(20)`), section_hierarchy (jsonb path for ordering), body, body_hash (SHA-256), version_date, verified_by, source_url, search_tsv (tsvector, generated column), corpus_version (FK).
- `corpus_versions` (ledger of every seed/migration run): version, seeded_at, operator, source_consolidation_date, clause_count, content_hash.

Citation hash provenance: when a recommendation cites a clause, it stores `clause_id` + `body_hash` at the moment of drafting. If the corpus is later re-seeded with new text for the same clause, the new row gets a new `id`; the old row stays. The recommendation's stored `clause_id` continues to resolve the old text — chain-of-evidence preserved.

The `<CitationRef />` component is purely a UI concern in `packages/ui` (where the existing design tokens live). The hover/tap-hold interaction is delegated to a shadcn/ui Popover. The component fetches by `(statute_short_name, citation)` from `apps/api`.

**Pros:**

- Clean separation: statutes (small, ~10 rows) + clauses (a few hundred rows). FTS only on clauses.
- Hash-anchored historical lookups: a 2025 recommendation's citation stays defensible even after a 2026 OHSA consolidation.
- `corpus_versions` ledger satisfies CLAUDE.md "corpus updates = versioned migrations." Audit-chain-anchored via `audit.corpus.seeded` event (declared in `@jhsc/shared-types` AuditPayload union — new kind).
- Drizzle migrations naturally encode the "never edit in place" rule: each seed update is an INSERT-only migration that supersedes prior rows by version. Drizzle-kit refuses to UPDATE-by-default.

**Cons:**

- Two tables + ledger is more ceremony than a single flat JSON file.
- FTS tuning (English vs French dictionary; AODA — Phase 2 bilingual is post-Release per ROADMAP) needs a single jurisdiction-specific configuration in 1.4; bilingual lands later.

### Option B: Single denormalized `legal_citations` table

One table: id, statute, citation, body, version_date, etc.

**Pros:** Simplest schema. One JOIN saved.

**Cons:**

- Statute metadata (citation form, copyright status, last consolidation) repeats per row.
- Makes the "only seed summaries for copyrighted statutes" enforcement awkward — it'd be a per-row check rather than a per-statute policy.
- Harder to render a Legal Reference screen that groups by statute (the common UI shape) without GROUP BY gymnastics.

### Option C: Flat JSON files in the package, no DB tables

`packages/legal-corpus/data/ohsa.json` etc., loaded into memory at boot.

**Pros:** No DB migration; corpus updates are PR-reviewable diffs.

**Cons:**

- No FTS without re-implementing it client-side.
- Audit-chain-anchored seeding becomes "audit each PR merge" instead of "audit each deploy."
- Sync to Dexie (1.10) is now a bespoke JSON-to-IndexedDB import path rather than a generic table sync.
- Corpus entry hashes drift with file formatting changes (whitespace, key order) unless we canonical-JSON the file at seed time.

## Decision

**Option A.** Two tables (`statutes` + `clauses`) plus a `corpus_versions` ledger. `<CitationRef />` ships in `packages/ui`, fetches via `apps/api`, audit-anchored corpus seeding.

### Rationale

Hash-anchored historical lookups are the constraint that closes the design space. Option B's flat schema can't model "the 2024 text of s.9(20)" alongside "the 2026 text of s.9(20)" without per-row version columns that re-invent the statutes table. Option C loses FTS and audit-anchoring. Option A is the canonical relational shape and it costs ~150 LOC of Drizzle schema.

### Reversibility

- **Easy** to add new statute rows later (Quebec LSST, Alberta OHS Act, etc.). The schema is jurisdiction-keyed.
- **Hard** to retro-rewrite a clause body in place. That's the point — historical evidence preservation. If a regulator-issued correction needs to land, the operator INSERTs a new clause row (new id, same citation, new version_date) and emits `audit.corpus.amended` with `{prev_clause_id, new_clause_id}` so the chain records the rationale.

## Schema

### `statutes`

```
statutes (
  id              uuid primary key default gen_random_uuid(),
  jurisdiction    text not null,      -- 'ON' | 'CA-FED'
  short_name      text not null unique, -- 'OHSA', 'OREG851', 'CLC2', 'COHSR'
  long_name       text not null,      -- 'Occupational Health and Safety Act, R.S.O. 1990, c. O.1'
  citation_form   text not null,      -- 's.{section}' or 'reg.{section}'
  source_url      text not null,
  last_consolidation date not null,   -- the consolidation date the seed reflects
  copyright_status text not null check (copyright_status in ('public_domain','crown_copyright_open','third_party_restricted')),
  -- 'crown_copyright_open' covers Ontario / Canada statutes which are crown
  -- copyright but reproducible under the Reproduction of Federal Law Order
  -- and the Ontario equivalent — full text storage is allowed.
  -- 'third_party_restricted' is CSA / ISO / ACGIH — summaries only.
  notes           text                -- operator-facing context
);
```

### `clauses`

```
clauses (
  id              uuid primary key default gen_random_uuid(),
  statute_id      uuid not null references statutes(id) on delete restrict,
  citation        text not null,                -- 's.9(20)', 's.43(3)(b)', 'reg.79'
  hierarchy_path  text[] not null,              -- ['9','20'] for ordering
  heading         text,                         -- 'Recommendations and response'
  body            text not null,                -- full text (crown_copyright_open) or summary (third_party_restricted)
  body_summary    text,                         -- the rep-friendly plain-language summary; required when body is a summary
  body_kind       text not null check (body_kind in ('full_text','summary')),
  body_hash       bytea not null,               -- SHA-256(body || version_date.toISOString())
  version_date    date not null,                -- the consolidation date this row reflects
  verified_by     text not null,                -- operator identifier; metadata-only per privacy review priv-F4
  source_url      text not null,                -- direct link to the regulator's text
  corpus_version  text not null references corpus_versions(version) on delete restrict,
  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(heading,'')), 'A') ||
                    setweight(to_tsvector('english', citation), 'B') ||
                    setweight(to_tsvector('english', body), 'C')
                  ) stored,
  superseded_by   uuid references clauses(id) on delete set null,
  -- when a clause is amended, the new row's id lands here on the prior row;
  -- the old row stays addressable for historical citations.
  unique (statute_id, citation, version_date)
);
create index clauses_statute_citation_idx on clauses(statute_id, citation);
create index clauses_search_idx on clauses using gin(search_tsv);
```

`body_hash` covers `body || version_date.toISOString()` so a re-seed that changes the body OR the version_date produces a new hash and a new row (because of the unique constraint on `(statute_id, citation, version_date)`). The hash is what recommendations / hazards / minutes store as their provenance anchor.

### `corpus_versions`

```
corpus_versions (
  version           text primary key,         -- e.g. '2026-05-29-r1'
  seeded_at         timestamptz not null default now(),
  operator          text not null,            -- whose admin CLI invoked the seed
  source_consolidation_date date not null,    -- the consolidation date the seed reflects
  clause_count      integer not null,
  content_hash      bytea not null            -- SHA-256(canonical_json(all clauses inserted by this version))
);
```

The seed script writes one `corpus_versions` row per invocation, then `clauses` rows referencing it. The seeder also appends one `audit.corpus.seeded` event into `audit_log` carrying `{version, sourceConsolidationDate, clauseCount, contentHash}` so re-seed events are chain-anchored.

## API surface

`apps/api/src/routes/legal/index.ts`:

- `GET /api/legal/clauses?statute=OHSA&citation=s.9(20)` — exact lookup. Returns the latest non-superseded row.
- `GET /api/legal/clauses/{id}` — by id; used by hash-anchored citations from prior recommendations.
- `GET /api/legal/search?q=refusal&statute=OHSA&limit=20` — FTS via `search_tsv` + `ts_rank_cd`. Pagination via offset; small corpus — pagination is for UI consistency, not scale.
- `GET /api/legal/statutes` — small list for the Legal Reference screen filters.

No write endpoints. Corpus mutation is migration-only.

## `<CitationRef />` component

Lives in `packages/ui` (next to the existing tailwind preset). Public surface:

```tsx
<CitationRef statute="OHSA" citation="s.9(20)" />
<CitationRef clauseId="..." />        // hash-anchored historical
```

Behavior:

- **Inline rendering:** the citation token in the body text, styled as an underline-on-hover link (accent color).
- **Desktop:** hover for 350 ms → opens a Popover (shadcn/ui primitive — Radix under the hood, already on the locked stack).
- **Mobile:** long-press 500 ms → bottom-sheet card. (`@radix-ui/react-dialog` for the bottom sheet shape; matches the step-up modal pattern.)
- **Card content:** heading, citation, full body (or summary + "summary only — see source"), version_date, source_url (external link with `target="_blank" rel="noopener noreferrer"`), "Insert into current draft" button when a draft context is provided via React Context.
- **Print:** the citation token renders as plain inline text with the citation string and a footnote reference; the printed footnote carries the body_hash for evidence.
- **Accessibility:** focus-visible state opens the Popover; ESC closes. `aria-describedby` points at the popover content.

The component takes a `useCitation()` hook that calls `api.legal.clauses` with `(statute, citation)` and caches in React Query (already on the locked stack via shadcn? — confirm at slice time; if not, light-weight in-memory cache keyed by `${statute}:${citation}`).

## Legal Reference screen (`/legal`)

- Tab bar entry — "Legal" replaces the "More" entry's existing dead-end stub for the legal sub-card.
- Filter chips by statute: `OHSA`, `O. Reg. 851`, `CLC Part II`, `COHSR`. The chip carries `statute.short_name`.
- Search box: debounced 250 ms → `GET /api/legal/search`. Results render as cards, sorted by `ts_rank_cd` desc.
- Empty-state when no filter + no search: render an A-Z table of contents grouped by statute, jurisdiction header per group.
- Each card opens to the same Popover/sheet shape as `<CitationRef />`, with an additional "Cite this" action that copies the canonical citation string to the clipboard.

Mobile-primary; the screen is the canonical shape every other module's citation hover delegates to.

## Tables added in 1.4

| Table             | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| `statutes`        | One row per Act / Regulation.                   |
| `clauses`         | One row per leaf citation. Includes FTS column. |
| `corpus_versions` | Ledger of every seed run.                       |

No PI in any of these tables. The `verified_by` and `operator` columns carry OS-username class strings (privacy-reviewer F4 / T-AC11 posture); the seed runbook applies the same reason-hygiene rule as auth (runbook §2).

## Seeding

`apps/api/scripts/seed-legal-corpus.ts` (was a 1.1 stub) — implemented in 1.4 to:

1. Read structured TOML fixtures from `packages/legal-corpus/seed/` — one file per statute.
2. Validate via Zod schema: every clause has citation, hierarchy_path, body or body_summary, body_kind, version_date, source_url. `body_kind='summary'` rejects when `statute.copyright_status='crown_copyright_open'`; `body_kind='full_text'` rejects when `statute.copyright_status='third_party_restricted'`. This is the **structural copyright guard**.
3. Compute `body_hash` per row and `content_hash` per seed batch.
4. INSERT one `corpus_versions` row + N `clauses` rows in a single transaction.
5. Append `audit.corpus.seeded` into the chain via `emitAuthEvent` (or a domain-specific emitter that the audit-chain accepts — declared in shared-types).

Re-seeding the same `version` is rejected (PK conflict). Re-seeding with a new `version` and the same `(statute_id, citation, version_date)` is rejected by the unique constraint — operator must explicitly amend a clause by inserting with a new `version_date` and emitting `audit.corpus.amended`.

## Consequences

### Positive

- CLAUDE.md non-negotiable #5 ("legal citations must be accurate") closes: app cannot fabricate a citation because every render is `api.legal.clauses` → corpus → DB.
- Hash-anchored historical lookups satisfy CLAUDE.md "generated documents record the corpus entry hash in provenance metadata."
- Audit-chain-anchored seeding gives an evidentiary trail for the corpus itself — a regulator asking "what version of s.9(20) did this 2026-06-12 recommendation rely on?" gets the corpus_versions row + the audit_log entry + the clause row by hash.
- `<CitationRef />` shipped in `packages/ui` unblocks every later module that draft-edits legal text.

### Negative / accepted tradeoffs

- Two-table schema + ledger is more setup than a single JSON file. Pays back from 1.5 onward.
- Seed data quality is now an operator concern. The seed script verifies structure but cannot verify that "s.43" actually says what's in the body — `verified_by` is the operator's stamp on having checked. Runbook §6 (new) documents the verification process.
- FTS uses the English dictionary. Phase-2 bilingual EN/FR support is post-Release per ROADMAP "Phase 2 Items"; when it lands, the schema needs a `language` column on clauses and a per-language tsvector.

### Risks

- **Wrong clause text seeded.** Mitigation: every clause requires `verified_by` + `source_url`; runbook §6 mandates the operator re-verify against the regulator's URL at seed time. The audit-chain entry records who did it.
- **Re-seed accidentally overwriting historical text.** Mitigation: unique constraint on `(statute_id, citation, version_date)` plus migration-only mutation forces an INSERT path even for amendments. There's no UPDATE path in the API.
- **Copyright violation by seeding CSA full text.** Mitigation: the seeder's structural guard rejects `body_kind='full_text'` for `third_party_restricted` statutes. Test fixture asserts the guard fires.

## Compliance check

- [x] Aligns with `.context/constraints.md` — no cross-border transfer, no new subprocessor; Ontario residency unchanged.
- [ ] Threat model updated — **follow-up: threat-modeler appends SECURITY.md §2.4 "Corpus integrity" with T-LC1..T-LCn (wrong clause served, FTS index poison, hash-anchor mismatch on recommendation read).**
- [x] No new subprocessor (statute URLs link out; no scraping).
- [x] CLAUDE.md §"Legal Reference Module Rules" honored end-to-end.

## Follow-ups

- [ ] Threat-modeler: SECURITY.md §2.4 corpus-integrity threats + mitigations.
- [ ] Test-writer: structural-guard tests, FTS ranking tests, hash-anchored historical lookup test, `<CitationRef />` interaction tests (desktop hover + mobile long-press).
- [ ] Implementer slices:
  - S1: `packages/legal-corpus` (schema-only — Drizzle types + Zod fixture schema + seed-runner skeleton + structural copyright guard + tests).
  - S2: `statutes` + `clauses` + `corpus_versions` migration; seed OHSA core + O. Reg. 851 subset + CLC Part II core + COHSR subset; `audit.corpus.seeded` chain emission.
  - S3: `apps/api/src/routes/legal/` — clauses/statutes/search endpoints + audit emission for first-time cache populations.
  - S4: `<CitationRef />` in `packages/ui` + Legal Reference screen at `/legal` + route wiring in `apps/web`.
- [ ] Reviewers (security + privacy) after S4.
- [ ] Runbook: `docs/runbooks/legal-corpus.md` covering seed verification, amendment procedure, and chain-anchored audit of corpus changes.
- [ ] Update `.context/decisions.md` with the one-liner pointing here.
