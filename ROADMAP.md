# ROADMAP.md — JHSC Worker Hub

Phased build plan. Three releases. Each release is shippable and useful on its own.

---

## Guiding Principles

1. **Ship usable software at each release.**
2. **Use the app for real JHSC work between releases.**
3. **Polish before scope.**
4. **Never compromise security for speed.**
5. **Mobile parity is not optional.**
6. **The Minutes module is the operational hub** — every release should make it more useful as the central place where JHSC work happens.

---

## Release 1 — Statutory Core + Inspections + Minutes Import (9–12 weeks)

Goal: a working JHSC tool for inspections (templates, multi-type, manual promotion, PDF export), hazards, recommendations, evidence, legal reference, and Excel import of historical meeting minutes — deployed and used daily.

### Milestone 1.1 — Foundation (Week 1)

- pnpm monorepo set up
- Vite + React + TypeScript scaffold (`apps/web`)
- Hono + Bun scaffold (`apps/api`)
- Drizzle + Neon Postgres connected
- Fly.io project provisioned (YYZ region)
- GitHub Actions CI configured
- Tigris bucket provisioned
- Design tokens implemented in `packages/ui`
- App shell scaffolded (bottom tab bar mobile, sidebar desktop)
- Basic theme: light + dark + follow-system

### Milestone 1.2 — Auth (Week 2)

- Lucia Auth integrated
- Passkey/WebAuthn primary flow
- Password + TOTP fallback flow
- Biometric prompt on mobile
- Session management (JWT + refresh)
- Step-up auth helper
- First-run setup flow (creates co-chair account)

### Milestone 1.3 — Encryption + Audit (Week 3)

- `packages/crypto` — libsodium wrapper, XChaCha20-Poly1305 helpers
- Field-level encryption integrated into Drizzle layer
- Master key loaded from Fly Secrets
- `packages/audit` — hash-chain audit logger
- Audit log table + verification script
- All sensitive write paths emit audit events

### Milestone 1.4 — Legal Corpus (Week 3-4)

- `packages/legal-corpus` schema
- Seed: OHSA core sections, O. Reg. 851 relevant sections, CLC Part II core, COHSR subset
- `<CitationRef />` component
- Citation Hover signature interaction (desktop + mobile)
- Legal Reference screen with FTS search
- Versioning system for corpus updates

### Milestone 1.5 — Hazards (Week 4-5)

- Hazard data model + Drizzle schema
- Hazard list (card view mobile, table optional desktop)
- Hazard detail view (full-screen mobile, slide-over desktop)
- Hazard intake form (mobile-first, single column, sticky bottom action)
- Hazard status workflow
- Filters, sort, search

### Milestone 1.6 — Action Items (Week 5)

**New milestone. The action item entity is added before evidence/recommendations because they all reference it.**

- `action_items` table + Drizzle schema
- `action_item_moves` table + audit chain anchor
- Action item list view (card-list canonical)
- Action item detail view
- Section lifecycle: new_business / old_business / recommendation / completed / archived
- Type taxonomy (INSP, INSIGHT, FLI, INC, REC, TRAIN, PROC, OTHER)
- Status workflow
- Risk levels
- Action Flag computation (the aging logic)
- Move-section interaction (swipe mobile, drag desktop)
- All moves audit-logged

### Milestone 1.7 — Evidence + Capture-to-Record (Week 5-6)

- Evidence file model with hash + EXIF + GPS metadata
- Client-side file encryption before Tigris upload
- Photo capture flow on mobile
- Voice-to-text on description fields
- Floating action button (FAB) on mobile
- Capture-to-Record signature interaction

### Milestone 1.8 — Inspections (Week 6-8)

**Expanded milestone covering templates, multiple inspection types, manual promotion to action items, and PDF export.**

- `inspection_templates` table with template versioning
- `inspections` table preserving template version at start
- `inspection_findings` table with status (ABC or GAR per template)
- **Workplace zones declared in `config/workplace.ts`** — 10 generic zones by default, renamable per workplace, zone IDs stay stable
- **Zone Monthly inspection template** seeded with the standard 14-section structure (Emergency Exits, Racking, Floors/Aisles, Stairs, Dock Safety, GHS, PPE, Emergency Response Equipment, Machine Handling, Other Equipment, Compactor, Electrical Panels, Maintenance Area, Outside of Building, plus Employee Interview closer)
- **Rack Inspection template** seeded with CSA A344.1/A344.2 structure (Structural Integrity, Beam & Hardware, Specialty Racking, Safety Documentation, traffic-light GAR status)
- **Custom template** support for workplace-defined inspections
- Inspection list + detail (template-driven rendering)
- Inspection scheduling
- Mobile-first inspection capture flow with offline-first
- Photo capture per finding (encrypted, GPS-stamped, linked to evidence_files)
- **Manual promotion to action items** — one-tap "promote to action item" per finding, inspector chooses Risk level at promotion time; the action item lands in `section=new_business` of the next active meeting; bidirectional link between finding and action item; status X/G findings cannot be promoted
- Three-signature workflow for rack inspections (Inspector + Supervisor + JHSC Worker Co-Chair)
- **PDF export — single inspection** with Source Serif 4 evidence-grade layout, embedded photos, hash provenance footer
- **PDF export — date-range batch** (up to 100 inspections per export)
- Step-up auth required for export
- Export emits audit chain entry with output document hash
- All exports recorded in `export_records` table

### Milestone 1.9 — Recommendations (Week 7)

- Recommendation data model with deadline tracking
- s.9(20) recommendation drafting workflow
- 21-day clock under s.9(21)
- Citation insertion via `<CitationRef />`
- Status workflow (draft → submitted → response → resolved)
- Response capture from management
- PDF export with provenance hash + cryptographic signature
- Recommendations link to action items in section "recommendation"

### Milestone 1.10 — Offline-First Sync (Week 7-8)

- Dexie.js IndexedDB layer
- Sync queue with retry + exponential backoff
- Optimistic UI for all writes
- Conflict resolution UI
- Sync status indicator
- Service worker with offline shell
- PWA install prompt on all platforms

### Milestone 1.11 — Excel Import (Week 9-10)

**Import workflow for historical meeting minutes. Inspection file imports are out of scope for Release 1 — new inspections are conducted in-app.**

- `packages/excel-import` scaffolded
- SheetJS integration (client-side only)
- Schema detector for the Meeting Minutes workbook structure
- Parser for:
  - Meeting metadata (date, quorum, attendance)
  - Action items per section (NEW BUSINESS, OLD BUSINESS, NOTICE OF RECOMMENDATION, COMPLETED)
  - Workplace inspection review (read-only — not converted to native inspection records)
  - Closed items full history
- PII heuristic for browser-side encryption pre-flight
- Reconciliation engine (content_hash matching)
- Import preview UI with field-level diff for conflicts
- `excel_imports` and `excel_import_items` tables
- Step-up auth on commit
- 30-day reversal window
- `docs/excel-import-format.md` documentation (minutes format only for now)
- Malicious file defenses: zip bomb cap, formula stripping, type coercion
- Audit events for every import lifecycle stage

### Milestone 1.12 — Release 1 Hardening (Week 10-12)

- WCAG 2.2 AA audit + fixes
- Print stylesheets verified
- Security pre-launch checklist completed
- Penetration test (OWASP ZAP at minimum)
- Excel parser fuzzing
- Backup + restore drill
- Audit log verification on full dataset
- Mobile flow verified on iOS Safari + Android Chrome
- Deploy to production

**Release 1 ships. Import your existing minutes. Use the action item view daily. Capture hazards. Draft recommendations. 4–6 weeks of real-world use before starting Release 2.**

---

## Release 2 — Native Minutes Module + Worker Protection (5–6 weeks)

Goal: replace the Excel file with native meeting workflows. Add reprisal, accommodation, refusal, critical injury, calendar.

### Milestone 2.1 — Meeting Lifecycle (Week 10-11)

**The Minutes module's core. This is what makes the Excel file optional.**

- `meetings` table + Drizzle schema
- `meeting_sections` table (typed sections)
- `meeting_attendance` table
- `meeting_inspection_review` table
- Meeting creation flow
- Agenda template (10 standing items, time allocations)
- Live meeting view (mobile-primary)
- Attendance capture (Union / Management / Guest, present / regrets)
- Section-by-section workflow
- Adjournment with auto-generated key metrics
- Minutes finalization (counter-signed by 4 signers: Worker Co-Chair, Mgmt Co-Chair, Warehouse Mgr, Plant Mgr)

### Milestone 2.2 — In-Meeting Action Item Management (Week 11)

- Add action items during a live meeting
- Move items between sections in real time
- Status updates during the meeting
- Verify item closure with JHSC counter-sign
- Key metrics dashboard live-updates

### Milestone 2.3 — Minutes Document Generation (Week 11-12)

- PDF export matching the Excel file's print layout
- Source Serif 4, evidence-grade formatting
- All sections rendered
- Signatures embedded
- Document hash + audit chain anchor at foot
- Distribution tracking (who got the minutes)
- Retention statement (2 years per OHSA)

### Milestone 2.4 — Excel Re-Import (Update Mode) (Week 12)

**Now that we have native meetings, the import flow supports updating an in-progress meeting from an Excel file too — for reps who prefer to draft in Excel and finalize in-app.**

- Re-import workflow for ongoing meetings
- Conflict resolution where in-app state and Excel state diverge
- "Sync from Excel" as a one-time bridge for transitional reps

### Milestone 2.5 — Work Refusals (Week 12-13)

- Work refusal data model (s.43 / CLC s.128)
- Stage 1 and Stage 2 refusal workflows
- Witness statement intake during refusal
- Investigation log
- MOL/Labour Program contact quick-dial
- Certified member dispatch tracking
- Rights-protective copy

### Milestone 2.6 — Critical Injuries (Week 13)

- Critical injury data model (s.51 / CLC s.125)
- Scene preservation checklist
- Evidence chain protocol
- s.51 notification timeline tracker
- "Panic" entry point on mobile

### Milestone 2.7 — Reprisal (s.50 / s.147) (Week 13-14)

- Reprisal data model
- Reprisal complaint drafting workflow
- Timeline builder
- Witness statements (encrypted bodies)
- MLITSD complaint package generator
- Step-up auth on all reprisal data access

### Milestone 2.8 — Duty to Accommodate (Narrow Scope) (Week 14)

- Accommodation record model
- Medical info field with encryption
- OHRC duty-to-accommodate framework
- Accommodation plan builder
- Return-to-work tracking
- Documentation request templates

### Milestone 2.9 — Calendar + Tasks (Week 14-15)

- JHSC meetings calendar
- Inspection schedule
- Recommendation deadline tracker
- Action items from minutes
- Push notifications for deadlines
- Live Activities on iOS for active countdowns

### Milestone 2.10 — Sector Inspection Templates (Week 15)

**Workplace-specific zone templates and rack inspection are already shipped in Release 1 Milestone 1.8. This milestone adds *generic sector-starter templates* that other workplaces could adopt and customize.**

- General warehousing & distribution starter template
- Food & beverage processing starter template
- Cold storage / freezer ops starter template
- Manufacturing (light/heavy) starter template
- Healthcare starter template
- Office/clerical starter template
- Template customization UI (extending the custom template support already shipped)
- Template library (browse + clone)

**Release 2 ships. The Excel file becomes optional. Use the app for at least one full meeting cycle before starting Release 3.**

---

## Release 3 — Communications & Intelligence (5–6 weeks)

Goal: power-asymmetry tools, knowledge continuity, and rep messaging.

### Milestone 3.1 — Encrypted Messaging (Week 16-18)

- libsignal-protocol-typescript integration
- E2EE message threads between reps
- Disappearing messages option
- No server-side message retention
- Push notifications for new messages

### Milestone 3.2 — Adversarial Lens (Week 18-19)

- Pattern-based prediction engine
- AI-augmented predictions (via ai-proxy, opt-in)
- Side-by-side recommendation vs. predicted response UI
- Outcome tagging (predictions improve over time)
- Step-up auth + consent capture

### Milestone 3.3 — MLITSD Order Intelligence (Week 19-20)

- Regulator order dataset model
- Import pipeline for public MLITSD orders
- Federal Labour Program directions
- Search by sector, regulation, citation pattern

### Milestone 3.4 — Case Law Engine (Week 20)

- Curated OLRB reprisal decisions
- Key arbitration awards
- Tribunal decisions
- Tagged by topic with worker-side talking points

### Milestone 3.5 — Ergonomic / Exposure Calculators (Week 20-21)

- ISO 2631-1 / 2631-5 WBV calculator
- ACGIH TLV references
- NIOSH lifting equation
- REBA / RULA scoring
- Noise dose calculator
- Heat stress (WBGT/TLV)
- Save calculator runs to action items

### Milestone 3.6 — Knowledge & Continuity Layer (Week 21-22)

- Onboarding curriculum
- Scenario library / decision trees
- Predecessor brief generator
- Practice journal (rep-private, separately encrypted)
- Annual self-audit workflow
- Election & terms tracker
- COI register

### Milestone 3.7 — Analytics (Week 22)

- Action item trend dashboard
- Recommendation outcome tracker
- Inspection coverage heatmap
- Time-to-resolution metrics
- Section velocity (how fast items move from new → old → closed)

### Milestone 3.8 — Release 3 Hardening (Week 22-23)

- Full WCAG 2.2 AA re-audit
- Security re-audit
- Performance audit
- Documentation pass
- Deploy

---

## Post-Release: Phase 2 Items (Future)

- Bilingual EN/FR UI
- Advanced WCAG 2.2 AAA accessibility
- Time-zone awareness
- Plain-language mode
- Transparency report
- Open-source release
- DR drill automation
- Real-user monitoring
- CSV / TSV import alongside Excel
- Drawn signatures on touchscreen
- Cross-rep coalition hooks (if opening to multi-tenant)

---

## Honest Estimates

| Release | Optimistic | Realistic | Pessimistic |
|---|---|---|---|
| Release 1 | 9 weeks | 12 weeks | 16 weeks |
| Release 2 | 5 weeks | 6 weeks | 9 weeks |
| Release 3 | 5 weeks | 6 weeks | 10 weeks |
| **Total** | **19 weeks** | **24 weeks** | **35 weeks** |

Calendar time for a working rep with JHSC duties and 4 hours daily: **6–8 months realistic** to all three releases. Don't trust optimistic estimates.

The Excel import added ~2 weeks to Release 1. The Inspections module overhaul (templates per zone, multi-type with Rack Inspection, manual promotion, PDF export) added ~2 weeks. The native Minutes module added ~2 weeks to Release 2. All worth the time — they're what make the app useful for actual JHSC work as it's done today.

---

## When to Pause Building

If at any point one of these is true, slow down or stop:

- Active grievance, refusal, or MLITSD matter that needs full attention — pause the build
- The app is unstable in production and you're firefighting — fix, don't build new
- You're spending more time on the app than on actual JHSC work for >2 weeks — re-evaluate
- You haven't used the last release for at least 30 days — use it first

The app serves the work, not the other way around.
