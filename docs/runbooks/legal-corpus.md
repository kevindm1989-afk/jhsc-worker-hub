# Legal Corpus Operations

Operator runbook for `packages/legal-corpus` and the `apps/api/scripts/seed-legal-corpus.ts` seeder. Pairs with ADR-0003 and SECURITY.md §2.4.

## 1. Seed for the first time

Prerequisites: `DATABASE_URL` is set; migrations 0001 + 0002 + 0003 have run; the audit_log chain genesis is present.

```sh
DATABASE_URL=... bun run apps/api/scripts/seed-legal-corpus.ts \
  --version v$(date -u +%Y-%m-%d) \
  --note "initial corpus load"
```

Expected output ends with `seeded corpus v…: 4 statutes, 19 clauses, fixture_sha256=…`. The seeder emits one `audit.corpus.seeded` chain event whose payload contains `{version, statutes[], clauseCount, fixtureSha256}`. Verify the chain:

```sh
bun run apps/api/scripts/audit-log-verify.ts
```

Should print `chain OK: N events, last idx=N-1`.

## 2. Two-person fixture verification — mandatory before Milestone 1.9 ships

ADR-0003 §Risks declares "Wrong clause text seeded" as a residual handled by 2-person review. The 1.4 seed loaded fixtures _without_ that review; the structural guards (Zod schema, copyright trigger, FTS index) protect against malformed input but cannot detect "right citation labelled with the wrong text."

Before any recommendation-drafting flow ships (Milestone 1.9), two reviewers must independently re-verify the OHSA `s.9.*` block — specifically `s.9(18)`, `s.9(20)`, `s.9(21)`, `s.9(31)` — against `https://www.ontario.ca/laws/statute/90o01`. The Milestone 1.4 close-out privacy review flagged a possible mislabelling between `s.9(18)` (functions / powers) and `s.9(20)` (recommendations); the reviewers could not independently fetch e-Laws to verify, so the operator must.

Procedure:

1. Open the e-Laws page in two browsers, one per reviewer.
2. For each citation in `packages/legal-corpus/seed/ohsa.toml`, paste the body and confirm it matches the consolidated text on e-Laws verbatim. Note the consolidation date — if it has shifted since `version_date=2020-07-01`, ship an amendment (see §4).
3. Sign off in the PR opening Milestone 1.9 by linking this runbook section and naming both reviewers in the PR description.
4. If any citation needs correction, follow §4 to publish an amendment row — do NOT edit the existing row in place.

Repeat the same procedure for:

- `o-reg-851.toml` against `https://www.ontario.ca/laws/regulation/900851`
- `clc-part-ii.toml` against `https://laws-lois.justice.gc.ca/eng/acts/L-2/`
- `cohsr.toml` against `https://laws-lois.justice.gc.ca/eng/regulations/sor-86-304/`

## 3. Operator identity hygiene

`verified_by` in the TOML fixtures is the role label `"corpus-operator"` — not the operator's real name or initials. The operator's identity is recorded out-of-band: append a line to this file each time you seed, of the form:

```
- 2026-05-29 v2026-05-29 — corpus-operator: <real name>; reviewer: <name>; checksum: <fixture_sha256>
```

The `corpus_versions.note` field is also a good place to record the seed context (e.g. `"initial load, OHSA + O.Reg.851 + CLC II + COHSR"`), but should not carry the operator's name — `note` is a DB row and may surface in future operator-tooling.

### Seed log

(append here)

## 4. Publish an amendment to an existing citation

Amendments use the same seeder. The new TOML fixture row keeps the same `citation` but bumps `version_date`:

```toml
[[clauses]]
citation = "s.9(20)"
hierarchy_path = ["Part II", "Joint Health and Safety Committees", "s.9", "(20)"]
heading = "Recommendations"
body = "<new verbatim text>"
body_kind = "full_text"
version_date = "2026-05-29"   # bumped
verified_by = "corpus-operator"
source_url = "https://www.ontario.ca/laws/statute/90o01#BK14"
```

Run the seeder with a new `--version` tag. The seeder will:

1. INSERT the new clauses row (no UPDATE; the existing row stays).
2. Set the prior row's `superseded_by` pointer.
3. Emit one `audit.corpus.amended` chain event with `{statuteCode, citation, priorVersionDate, newVersionDate}`.

Read routes filter on `superseded_by IS NULL`, so the new row becomes the current resolution for `<CitationRef />` and `/api/legal/clauses?...`. Old recommendations that hold a `body_hash` against the prior row continue to resolve to the original text by id, with a `supersededBy` pointer in the response so the reader sees both.

## 5. Re-seed without dropping a statute

The seeder refuses to drop a previously-loaded statute unless the operator explicitly passes `--allow-statute-removal`. This catches the common "operator forgot to copy a fixture file" mistake (sec-F5).

If you actually intend to retire a statute (e.g. it was loaded under the wrong jurisdiction):

```sh
bun run apps/api/scripts/seed-legal-corpus.ts \
  --version v$(date -u +%Y-%m-%d) \
  --note "intentional removal of <statute>" \
  --allow-statute-removal
```

Read routes still serve the dropped statute's existing clauses (because `superseded_by IS NULL` keeps them alive). To actually retire them, follow the amendment flow in §4 with a tombstone marker — the schema does not currently support "deactivate without amendment," and adding it requires a new ADR.

## 6. Tamper response — chain mismatch involving corpus events

If `audit-log-verify` reports a divergence at an `audit.corpus.seeded` or `audit.corpus.amended` row, follow `docs/runbooks/auth.md` §7 (chain tamper response) — the procedure is identical. Additional steps for corpus-specific tampering:

1. Cross-check the divergent payload's `fixtureSha256` against `corpus_versions.fixture_sha256` for the same `version`. A mismatch means either the chain row was tampered or the `corpus_versions` row was tampered; the prior chain event's `prev_hash` linkage tells you which.
2. Run a one-shot verifier `audit-log-verify --check-corpus` (1.12 hardening line item) once it lands; until then, the cross-check above is manual.

## 7. Decommission a corpus version

To mark a version as retired without dropping its clauses (e.g. when superseded by a complete re-load):

```sql
UPDATE corpus_versions SET retired_at = now() WHERE version = '<old-version>';
```

`activeVersion()` (the helper in `apps/api/src/routes/legal/index.ts`) returns the most-recent non-retired version. Read filters still operate on `superseded_by IS NULL`, so existing recommendations resolve unchanged; only the `activeVersion` response field shifts.
