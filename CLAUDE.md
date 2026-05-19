# CLAUDE.md — JHSC Worker Hub

This file is read by Claude Code at the start of every session. It defines purpose, stack, conventions, and non-negotiable rules. **Read it fully before generating any code.**

---

## Project Purpose

A single-workplace, worker-side JHSC tool for one Joint Health & Safety Committee worker co-chair and their rep team. Supports statutory functions under the **Ontario Occupational Health and Safety Act (OHSA)** and the **Canada Labour Code Part II (federal jurisdiction)**.

- **Single-tenant.** One workplace, one co-chair, one rep team.
- **Worker-controlled.** Not employer infrastructure.
- **Mobile-primary.** Designed for the floor, freezer, meeting room, commute. Desktop is the expanded version.
- **Non-commercial.** Personal mission-critical tool.
- **Jurisdiction-aware.** Ontario OHSA + federal CLC Part II.
- **Minutes-centric.** The Minutes module is the operational hub — it's where action items live, age, and move between sections under the 21-day s.9(21) clock.

---

## Non-Negotiables

1. **No specific names in source.** No workplace name, union local, real people. Workplace identity lives in `config/workplace.ts` loaded from env at runtime.
2. **Worker data is evidentially sensitive.** Treat all of it as potential evidence in MLITSD complaints, OLRB reprisal hearings, or arbitration. Chain-of-custody and tamper-evident logging on every sensitive data path.
3. **No third-party data flows without explicit opt-in.** AI features off by default; per-feature consent capture; no analytics SDKs that phone home.
4. **Privacy-by-default.** Pseudonymize at intake. Encrypt sensitive fields at the application layer with keys you control. Minimize collection. Short log retention.
5. **Legal citations must be accurate.** Generated citations come only from `packages/legal-corpus`. Never invent statutory references.
6. **No employer infrastructure dependencies.** No SSO with employer IdP, no integration with employer email/files/HR.
7. **Rights-protective UI.** Copy must never discourage exercise of OHSA s.43 (refusal), s.50 (reprisal), or CLC s.128/s.147.
8. **No automated submission to regulators.** The app drafts complaints. A human submits.
9. **Mobile primary.** Every feature designed for 390px phone first. No desktop-only feature without justification.
10. **Restrained, legal-grade aesthetic.** No union iconography (fists, shields, banners). Visual language of audit firms and legal tooling.
11. **Excel imports are sanitized.** Imported files are parsed in the browser, sensitive fields encrypted client-side before server sync. Imported data never bypasses the audit chain.
12. **Action items have first-class status.** They are not a sub-concept of hazards. Hazards, recommendations, and meeting outputs can all become or link to action items, but action items are their own entity with their own lifecycle.
13. **Inspections preserve their template version at conduct time.** An inspection conducted under template v1 stays under v1 forever, even if the template is updated to v2. Historical inspections are immutable.
14. **Zone IDs are stable; zone display names are configurable.** `zone_1` through `zone_10` never change. The workplace renames them for display. This keeps historical inspections linked correctly even if a workplace renames a zone.
15. **Inspection findings are manually promoted to action items, not auto-promoted.** The inspector taps "promote to action item" on findings that warrant tracking. The inspector chooses the Risk level at promotion. Status X (no issues) and G (green) findings cannot be promoted.
16. **Exports require step-up auth and are audit-logged with output document hash.** Every PDF generated leaves a tamper-evident audit trail.

---

## Tech Stack (Locked)

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite 7 + TypeScript (strict) + vite-plugin-pwa |
| UI | shadcn/ui (Radix primitives) + Tailwind CSS |
| Design tokens | Custom system (see `ARCHITECTURE.md §8`) |
| Local-first | Dexie.js (IndexedDB) + custom sync engine |
| Backend runtime | Bun |
| Backend framework | Hono |
| Hosting | Fly.io (YYZ Toronto primary) |
| Database | Neon Postgres (ca-central-1) |
| ORM | Drizzle ORM + Drizzle Kit migrations |
| File storage | Tigris (S3-compatible, Fly-native) |
| Cache / sessions | `pg-boss` (Postgres-native) |
| Auth | Lucia Auth; passkey/WebAuthn primary; password + TOTP fallback; biometric on mobile |
| Encryption | libsodium-wrappers; XChaCha20-Poly1305 field-level; Argon2id passwords |
| E2EE messaging | libsignal-protocol-typescript (Release 3) |
| Search | Postgres FTS (`tsvector`) |
| AI proxy | Separate Fly Machine holding Anthropic API key; opt-in per feature |
| Background jobs | `pg-boss` |
| Push notifications | Web Push (VAPID) — iOS 17+ supported |
| Motion | Framer Motion |
| Charts | Recharts |
| Forms | React Hook Form + Zod |
| **Excel parsing** | **SheetJS (xlsx) — runs client-side in browser, no server upload of raw file** |
| Testing | Vitest (unit), Playwright (e2e) |
| Package manager | pnpm monorepo workspaces |
| CI | GitHub Actions → `fly deploy` |

---

## Repository Layout

```
jhsc-worker-hub/
├── CLAUDE.md
├── ARCHITECTURE.md
├── SECURITY.md
├── ROADMAP.md
├── BOOTSTRAP_PROMPT.md
├── apps/
│   ├── web/                   # React PWA
│   ├── api/                   # Hono + Bun (Fly Machine)
│   └── ai-proxy/              # Anthropic proxy (separate Fly Machine)
├── packages/
│   ├── shared-types/          # (planned — milestone 1.3+)
│   ├── legal-corpus/          # OHSA + CLC Part II + regs (versioned) (planned — milestone 1.4)
│   ├── crypto/                # Envelope encryption helpers (planned — milestone 1.3)
│   ├── audit/                 # Tamper-evident hash-chain logger (planned — milestone 1.3)
│   ├── ui/                    # Shared components + design tokens
│   ├── calculators/           # Ergonomic/exposure math (planned — milestone 3.5)
│   └── excel-import/          # Excel file parser + reconciliation engine (planned — milestone 1.11)
├── migrations/                # Drizzle migrations
├── config/
│   └── workplace.ts           # Workplace identity (env-driven)
├── scripts/
│   ├── seed-legal-corpus.ts
│   └── audit-log-verify.ts
└── docs/
    ├── threat-model.md
    ├── deployment.md
    ├── incident-response.md
    └── excel-import-format.md  # Documents the supported Excel schema
```

---

## Coding Conventions

### General

- TypeScript strict. No `any` without justification.
- Functional first. Pure functions where possible.
- No magic strings — enums and constants in `shared-types`.
- Explicit errors. Use `Result<T, E>` pattern.
- Every PR has tests, including security tests for sensitive paths.

### Naming

- Tables: `snake_case` plural (`action_items`, `meeting_minutes`, `hazards`)
- Columns: `snake_case`
- Endpoints: REST-ish (`POST /api/action-items`)
- Components: PascalCase (`ActionItemRow`, `MeetingMinutesEditor`)
- Files: kebab-case (`action-item-row.tsx`)

### Action Item Conventions

Action items use a defined Type taxonomy stored in `shared-types/src/action-item-type.ts`:

| Type | Meaning |
|---|---|
| `INSP` | Inspection-derived item (from workplace inspection findings) |
| `INSIGHT` | Observation or insight raised during meeting (not a discrete hazard) |
| `FLI` | Floor/Lighting/Infrastructure |
| `INC` | Incident-derived |
| `REC` | Recommendation (Notice of Recommendation under s.9(20)) |
| `TRAIN` | Training-related |
| `PROC` | Procedure / SOP issue |
| `OTHER` | Other (must include subtype in metadata) |

Status taxonomy:

| Status | Meaning |
|---|---|
| `Not Started` | Just raised, no work begun |
| `In Progress` | Being worked on |
| `Blocked` | Waiting on someone/something |
| `Pending Review` | Work done, awaiting JHSC verification |
| `Closed` | Verified by JHSC |
| `Cancelled` | Won't be pursued (with reason) |

Section lifecycle (where the item lives in the minutes):

| Section | Meaning |
|---|---|
| `new_business` | First raised this period |
| `old_business` | Carried over from prior period, still open |
| `recommendation` | Formal Notice of Recommendation (s.9(20)) |
| `completed_this_period` | Closed during this meeting cycle |
| `archived` | Closed and moved to historical archive |

### Encryption Rules

- **Sensitive fields encrypted at application layer** before write to Postgres. Sensitive = member identities, medical info, witness statement bodies, accommodation details, reprisal narratives, practice journal entries, **action item descriptions that contain personally identifiable information**.
- **Master key in Fly Secrets**, never logged, never returned by API.
- **Postgres (Neon) sees ciphertext** for sensitive columns.
- **No "decrypt for analytics."** Analytics run on non-sensitive metadata only.
- **Excel imports decrypt client-side, re-encrypt before upload.** The raw Excel file is parsed in the browser. Sensitive fields are encrypted there before any sync to the server.

### Audit Logging

Every write to sensitive tables emits an audit event:

```typescript
await audit.log({
  action: "action_item.move",
  resource_id: item.id,
  actor_id: ctx.user.id,
  metadata: { from_section: "new_business", to_section: "old_business" },
});
```

The audit log is a hash chain — each entry includes SHA-256 of the previous. Exports include the chain so tamper is detectable.

**Action item section moves are always audited** — the move history is the operational equivalent of the spreadsheet's `_MoveHistory` sheet, but cryptographically tamper-evident.

---

## UI / Design Conventions

See `ARCHITECTURE.md §8` for the full design system. Quick rules:

- **No marketing aesthetics.** Tool, not landing page. No hero sections, gradients, testimonials, decorative imagery.
- **Reference bar:** Linear, Stripe Dashboard, Things 3, Notion mobile, GitHub mobile.
- **Typography:** Inter (UI), JetBrains Mono (data/IDs), Source Serif 4 (generated long-form documents).
- **Color:** Neutral slate/zinc + single accent (deep blue `#1e3a8a`). Red/amber/green/blue for status semantics only.
- **Spacing:** 8pt grid.
- **Icons:** Lucide only. No emoji in chrome.
- **Action Flag indicators in minutes use emoji intentionally** — they match the established Excel workflow vocabulary (🟠 <21 days, 🟠 >21 days, ✓ Recently Closed, ⬇ Archive). This is the exception to the "no emoji" rule, because reps already read this vocabulary fluently.
- **Motion:** Framer Motion. Purposeful only. 150ms state, 250ms layout. Respect `prefers-reduced-motion`.
- **Density first.** Cards/tables before paragraphs.
- **Status semantics:** red = open/overdue/danger · amber = pending/attention · green = resolved/verified · blue = informational/draft · zinc = neutral/archived. Always pair color with icon or label — never color alone.
- **Empty states do work.** Never "No data." Show what to do next.
- **Loading = skeleton screens.** No full-page spinners.
- **Destructive actions confirm** with explicit consequence text.
- **Print stylesheet** for every printable view — evidence-grade output.

### Mobile-Primary Patterns

- **Bottom tab bar** primary nav on mobile → left sidebar on desktop.
- **Card-list canonical**, tables optional on desktop.
- **Full-screen detail** on mobile, slide-over on desktop.
- **Sticky bottom primary action** on mobile forms.
- **Camera, voice-to-text, GPS, biometric auth** = first-class inputs.
- **Touch targets ≥ 44pt.**
- **Pull-to-refresh** with haptic feedback.
- **Optimistic UI** with background sync.

### Signature Interactions (Identity-Defining)

- **Citation Hover.** Hover (desktop) or tap-and-hold (mobile) any OHSA/regulation reference anywhere in the app → citation card with full clause text, version date, source link, "insert into current draft" if applicable.
- **Adversarial Lens.** Single button on every recommendation draft → "How will management respond?" generates likely counter-arguments side-by-side with rebuttal points.
- **Capture-to-Record.** Mobile floating action button → photo capture → GPS-stamped, hash-fingerprinted hazard draft created in one motion. Camera roll never touched.
- **Section Move.** In the Minutes module, swipe an action item left/right (mobile) or drag (desktop) to move between sections. Move is audit-logged with timestamp, actor, and reason. This is the operational primitive of the Minutes module.

### Accessibility (WCAG 2.2 AA Baseline — Phase 1)

- Keyboard nav for every interactive element
- Visible focus indicators (2px ring, accent color)
- Semantic HTML before ARIA
- Color contrast ≥ 4.5:1 text, ≥ 3:1 UI
- No information by color alone
- Form errors announced to screen readers
- Skip-to-content in app shell
- `prefers-reduced-motion` respected

---

## Legal Reference Module Rules

`packages/legal-corpus` is the single source of truth for legal references. Rules:

1. Every entry has `source_url`, `version_date`, `verified_by` fields.
2. App never generates a citation outside the corpus.
3. Generated documents record the corpus entry hash in provenance metadata.
4. Corpus updates = versioned migrations, never edited in place.
5. **Copyright caution:** CSA, ISO, ACGIH are copyrighted. Store summaries, citations, clause numbers — never full text.

---

## Excel Import Rules

The Excel import feature (Release 1 milestone 1.11) lets reps upload their existing minutes spreadsheets. Strict rules:

1. **Parsing happens client-side only.** SheetJS runs in the browser. The raw .xlsx/.xlsm file is never uploaded to the server.
2. **Sensitive fields are encrypted in the browser** before any API call.
3. **Imports are previewed before commit.** The rep sees exactly what will be created/updated/skipped.
4. **Imports are reversible** for 30 days via the audit log.
5. **Reconciliation by content hash.** Same Description + Start Date = same item across imports. Updates merge; conflicts surface to the rep.
6. **The supported schema is documented in `docs/excel-import-format.md`.** Files that don't match the schema produce a clear "we don't recognize this format" error, not a partial import.
7. **All imports emit audit events** — every action item created or updated from an import has its provenance traceable to the source file.

---

## Working with Claude Code

### Session Start Checklist

1. Read `CLAUDE.md`.
2. Read `ROADMAP.md` for the current release/milestone.
3. Read `ARCHITECTURE.md` for the relevant module.
4. Read `SECURITY.md` if touching auth, encryption, audit, or **import**.
5. Check git status. Confirm branch matches milestone.

### Refuse These Prompts

- Skip encryption "for debugging" → refuse, suggest the dev-only debug helper
- Disable audit logging → refuse
- Hardcode workplace name or real person → refuse, point to `config/workplace.ts`
- Generate fictional legal citations → refuse, point to corpus
- Add union iconography (fists, shields, banners) → refuse, point to design system
- Add marketing-style flourishes (hero sections, gradients, testimonials) → refuse, point to design system
- Add third-party analytics SDK → refuse, point to no-telemetry rule
- Add SSO with employer IdP → refuse, point to non-negotiable #6
- **Upload Excel file content to server before encryption** → refuse, point to Excel Import Rules above
- **Treat action items as a sub-type of hazards** → refuse, point to non-negotiable #12

---

## Quality Bar (Pre-Merge Checklist)

- [ ] Tests pass, including security tests on sensitive paths
- [ ] Type check passes with strict mode
- [ ] No `console.log` in committed code
- [ ] Audit events emitted for sensitive writes
- [ ] Sensitive fields encrypted before DB write
- [ ] No hardcoded workplace/person identifiers
- [ ] No legal citations outside corpus
- [ ] Migrations are append-only
- [ ] WCAG 2.2 AA checks pass on new UI
- [ ] Print stylesheet covers new printable views
- [ ] Mobile flow verified on iOS Safari + Android Chrome
- [ ] Offline-first behaviors tested
- [ ] **Action item section moves emit audit events with from/to state**
- [ ] **Excel import test fixture validates schema-recognition logic**

---

## When in Doubt

Default to **worker safety, worker privacy, evidentiary defensibility**, in that order. If a design tradeoff arises, pick the answer that protects the worker rep in front of a hostile arbitrator or MLITSD inspector six months from now.
