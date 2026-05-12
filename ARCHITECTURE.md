# ARCHITECTURE.md — JHSC Worker Hub

System design, data model, encryption model, design system, and key interactions.

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                Fly.io YYZ (Toronto)                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│   Browser/PWA  ──>  Fly Machine: api (Bun + Hono)                │
│        │                  │                                       │
│        │                  ├──> Neon Postgres (ca-central-1)       │
│        │                  │    [main DB, FTS, sessions, audit]    │
│        │                  │                                       │
│        │                  ├──> Tigris (S3-compatible, Fly-native) │
│        │                  │    [encrypted evidence files]         │
│        │                  │                                       │
│        │                  └──> Fly Machine: ai-proxy              │
│        │                       [Anthropic API, opt-in only]       │
│        v                                                           │
│   Service Worker (offline-first, IndexedDB via Dexie)             │
│        │                                                            │
│        └──> SheetJS (xlsx) — Excel import runs ENTIRELY in browser │
│             Raw file never leaves the device                       │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Components

- **`apps/web`** — React PWA. Mobile-primary, installable on iOS/Android/desktop. Offline-first via service worker + IndexedDB. **Hosts SheetJS for Excel parsing entirely client-side.**
- **`apps/api`** — Hono on Bun, deployed to Fly Machine. All JHSC business logic and DB access.
- **`apps/ai-proxy`** — Separate Fly Machine holding the Anthropic API key. Called from `api` with a signed token. Isolated so the main app's process never sees the AI key.

### Data Stores

- **Neon Postgres** — main DB. All records, FTS indexes, sessions, audit chain. Region: `ca-central-1`. Application-layer encryption for sensitive fields.
- **Tigris** — object storage for evidence files. Files are encrypted client-side before upload. Tigris sees ciphertext only.
- **IndexedDB (Dexie)** — local-first cache on each device. Sensitive fields encrypted at rest using a key derived from the user's session.

---

## 2. The Minutes-Centric Model

This is the most important architectural decision in the system, and it's a change from the original spec.

### What "Minutes-Centric" Means

The Minutes module is not a side feature for recording meetings. It is the **operational hub** of the entire app. Here's why:

- JHSC work runs on **meeting cycles**. Items get raised, tracked, and closed across meetings.
- Every open hazard, recommendation, and observation eventually becomes an **action item** that lives in the minutes.
- The **21-day s.9(21) clock** is the legal heartbeat of worker-side JHSC work, and it runs through the minutes.
- The **section lifecycle** (New Business → Old Business → Recommendation → Completed → Archived) is the canonical workflow.
- The **move history** between sections is the chain of custody for everything the committee tracks.

The Excel file that originally inspired this design did this correctly. The app's job is to do it better — with encryption, audit, mobile access, and integration with hazards/recommendations/reprisal/inspection workflows.

### Entity Relationships

```
hazards ─────┐
             │
recommendations ─┤
                 ├──> action_items ─┬──> action_item_moves (audit chain)
                 │                  │
inspection_findings ─┤              ├──> assigned_to (user)
                     │              │
incidents ───────────┘              └──> linked_meeting_id
                                              │
                                              v
                                         meetings ─────> minutes_documents
```

Hazards, recommendations, inspection findings, and incidents can each spawn or link to action items. Action items live in meetings. Meetings produce minutes documents (the exportable PDF). The relationship is many-to-many in some cases (one action item can be linked to multiple hazards if needed).

---

## 3. Mobile-Primary Architecture

### Offline-First Data Layer

Every record type follows local-first principles:

- **Read:** IndexedDB first (instant), fetch fresh from API in background, reconcile.
- **Write:** IndexedDB first (instant feedback), enqueue sync to API.
- **Sync:** Background sync queue with retry, exponential backoff, conflict resolution.
- **Conflict resolution:** Last-write-wins on simple fields; three-way merge on drafts; hard conflict UI on irreconcilable diffs.

Sync state is always visible — discreet indicator in the app shell shows "Synced," "3 items syncing," or "Offline — 5 changes queued."

### PWA Capabilities

- **Install prompt** on all platforms (iOS 17+, Android, desktop)
- **Push notifications** via Web Push (VAPID)
- **App badging** for open action item count (iOS 16.4+, Android)
- **iOS share extension / Android share target** — share any photo, doc, or URL into JHSC Worker Hub from other apps
- **iOS App Shortcuts / Android Quick Actions** — long-press the icon for "New Hazard," "Start Meeting," "Run Inspection," "Capture Evidence"
- **Live Activities (iOS)** for active deadlines — countdown on lock screen
- **Camera, GPS, microphone** via standard web APIs
- **Biometric auth** via WebAuthn platform authenticator
- **Background sync** where supported

### Navigation

| Surface | Mobile (< 768px) | Desktop (≥ 768px) |
|---|---|---|
| Primary nav | Bottom tab bar (5 tabs) | Left sidebar (always visible) |
| Primary tabs | Minutes · Hazards · Inspections · Recommendations · More | Same + more in sidebar |
| Command palette | Bottom sheet, top search icon | ⌘K opens centered modal |
| Detail view | Full-screen with swipe-back | Right slide-over |
| Form submit | Sticky bottom button | Inline button at form end |

**Note: Minutes replaces Dashboard as the primary mobile tab.** The dashboard is still accessible (in More or as the desktop home view), but the canonical "open the app" experience on mobile lands on the active meeting view — the place where the work is actually happening.

---

## 4. Data Model (Core Tables)

All tables include `id` (UUID v7), `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` (soft delete).

### Users & Auth

- `users`
- `user_credentials`
- `user_sessions`
- `user_roles`

### Action Items (Top-Level Entity)

**This is the central operational table.**

```
action_items
├── id (uuid v7)
├── sequence_number      (per-section sequence, like the Excel "#" column)
├── type                 (INSP | INSIGHT | FLI | INC | REC | TRAIN | PROC | OTHER)
├── type_subtype         (free text when type=OTHER)
├── description          (encrypted if contains PII)
├── recommended_action   (encrypted if contains PII)
├── raised_by            (user_id, encrypted display name for non-members)
├── follow_up_owner      (user_id or external name, encrypted if external)
├── department
├── status               (Not Started | In Progress | Blocked | Pending Review | Closed | Cancelled)
├── risk                 (Low | Medium | High | Critical)
├── action_flag          (computed: see §5)
├── start_date           (when item was raised)
├── target_date          (optional)
├── closed_date          (when verified by JHSC)
├── verified_by_jhsc_id  (which user verified closure)
├── section              (new_business | old_business | recommendation | completed_this_period | archived)
├── meeting_id           (current meeting context)
├── source_type          (manual | hazard | recommendation | inspection | incident | excel_import)
├── source_id            (FK into the source table, nullable)
├── source_excel_hash    (for items imported from Excel, the source row hash)
├── tags                 (array)
└── audit_chain_anchor   (hash linking to audit log)
```

### Action Item Move History

Mirrors the Excel `_MoveHistory` sheet, but cryptographically tamper-evident:

```
action_item_moves
├── id
├── action_item_id
├── moved_by_user_id
├── moved_at
├── from_section
├── to_section
├── reason                (optional free text)
├── meeting_id            (which meeting the move happened in)
├── prior_hash            (hash chain link)
├── current_hash          (this entry's hash)
└── undone                (boolean — supports the Excel "Undone?" pattern)
```

### Meetings

```
meetings
├── id
├── meeting_date
├── start_time
├── end_time
├── location
├── quorum_met
├── worker_co_chair_id
├── management_co_chair_id
├── agenda_template_id    (link to agenda configuration)
├── status                (planned | in_progress | adjourned | minutes_finalized)
└── minutes_document_id   (link to generated PDF)
```

### Meeting Attendance

```
meeting_attendance
├── meeting_id
├── user_id_or_name       (external attendees by name, encrypted)
├── representation        (Union | Management | Guest | External)
├── role                  (free text — Co-Chair, Member, H&S Coordinator, etc.)
├── present               (boolean)
├── regrets               (boolean)
└── signature_collected   (boolean, with signature_image_ref)
```

### Meeting Sections

For ordered sections per meeting (Key Metrics, Attendance, Inspection Review, New Business, etc.). Custom sections can be added as needed.

```
meeting_sections
├── id
├── meeting_id
├── section_key           (key_metrics | attendance | inspection_review | new_business | old_business | recommendations | completed | custom)
├── title
├── order_position
├── body_markdown         (free-form content for narrative/custom sections, encrypted if PII)
└── data_payload_json     (structured data for typed sections like key_metrics, attendance, inspection_review)
```

**Note:** Executive Summary and WSIB Excellence Program are intentionally not in the default section set. If needed at a specific workplace, they can be added per meeting as `section_key=custom` with a chosen title.

### Workplace Inspection Review (in-meeting summary)

```
meeting_inspection_review
├── meeting_id
├── zone_label
├── inspector_user_id
├── status                (Complete | In Progress | Not Done)
└── findings_count
```

### Inspections Module (Detailed)

Inspections are first-class records with template versioning and multi-type support. Findings are manually promoted to action items by the inspector.

```
inspection_templates
├── id
├── template_key             (zone_monthly | rack_inspection | custom)
├── name                     (e.g. "Zone Monthly Inspection", "CSA A344.1 Rack Inspection")
├── version                  (integer, incremented on schema changes)
├── is_active                (boolean — only one active version per template_key)
├── zone_scope               (zone_id if zone-specific, null if applies to any zone)
├── status_system            ("ABC" | "GAR" | "custom")
├── status_meanings          (JSON map of status code → semantic meaning)
├── sections_json            (the section + item structure, see below)
└── created_at, updated_at

inspections
├── id
├── template_id              (FK, immutable once started)
├── template_version_at_start (preserved at conduct time)
├── zone_id                  (which zone — from workplace config)
├── type                     (zone_monthly | rack | custom)
├── scheduled_for_date       (when it should be done)
├── conducted_at             (when it was actually done)
├── conducted_by_user_id     (primary inspector)
├── secondary_inspectors     (array of user_ids or external names)
├── status                   (scheduled | in_progress | completed | exported)
├── overall_summary          (free text, encrypted if PII)
├── signature_worker_co_chair (signature ref)
├── signature_management     (signature ref, optional)
├── signature_supervisor     (signature ref, for rack inspections)
└── audit_chain_anchor

inspection_findings
├── id
├── inspection_id
├── section_number           (1, 2, 3, etc. — top-level section like "Emergency Exits")
├── item_number              (1.1, 1.2, etc. — specific check)
├── item_text                (the question/check, captured from template at conduct time)
├── checklist_criteria       (the "expected condition" text from template)
├── status                   (A | B | C | X — or G | A | R — based on template status_system)
├── corrective_action        (free text from inspector, encrypted if PII)
├── responsible_party        (user_id or external name, encrypted if external)
├── photo_refs               (array of evidence_file IDs)
├── promoted_action_item_id  (FK if manually promoted to action item, nullable)
└── created_at
```

### Inspection Template Structure (`sections_json`)

```json
{
  "sections": [
    {
      "number": 1,
      "title": "Emergency Exits",
      "items": [
        {
          "number": "1.1",
          "text": "Exits are not blocked",
          "criteria": "Must have a 3 foot path to the door"
        },
        {
          "number": "1.2",
          "text": "Clear and free of debris",
          "criteria": "Nothing on the floor that may cause a slip trip or fall"
        }
      ]
    }
  ],
  "closing_section": {
    "title": "Employee Interview",
    "items": [
      { "number": "EI.1", "text": "Is there a situation that doesn't make sense to you?" },
      { "number": "EI.2", "text": "Is there a risky task or hazard (DANGEROUS)?" },
      { "number": "EI.3", "text": "Is there an unusual or difficult task (DIFFICULT)?" },
      { "number": "EI.4", "text": "Is there a changed situation, activity or task?" }
    ]
  }
}
```

### Manual Promotion to Action Items

Inspection findings can be manually promoted to action items by the inspector or co-chair at any point — during the inspection (one tap per finding) or afterward from the inspection detail view. There is no automatic auto-promotion. The inspector decides which findings warrant tracking as action items in the next meeting.

When a finding is promoted manually:

- A new action item is created with Type=INSP
- The finding's text becomes the action item's description
- The inspector chooses Risk level at promotion time (default suggestions: A→Critical, B→High, C→Medium, R→Critical, but these are suggestions only, not enforced)
- The action item lands in `section=new_business` of the next active meeting
- The link is bidirectional: the inspection finding shows "promoted to action item #N" and the action item shows "from Inspection #M, Section X, Item Y"

Status `X` (No Issues) and `G` (Green/Good) findings cannot be promoted — there's nothing to track.

Why manual not automatic: keeps the inspector in control of what becomes a tracked commitment versus what's just an observation. Auto-promote would generate noise (every C-rated minor finding becomes a task to chase). Manual promotion produces a clean action item list reflecting the inspector's judgment.

### Default Workplace Zones (workplace.ts)

The workplace config declares its zones. Default template ships with 10 generic zones the workplace renames:

```typescript
export const WORKPLACE_ZONES = [
  { id: "zone_1", default_name: "Zone 1", display_name: "" },
  { id: "zone_2", default_name: "Zone 2", display_name: "" },
  // ... through zone_10
];
```

Workplace customizes `display_name` to match their actual zones ("Process Rooms", "Cold Warehouse", etc.). Zone IDs stay stable so historical inspections always link correctly even if names change.

### Hazards (Unchanged)

```
hazards
├── id
├── title
├── description (encrypted)
├── severity, status, location
├── reporter_identity (encrypted)
├── created_at, updated_at
└── linked_action_item_id (optional — when promoted to a tracked action)
```

### Other Tables (Unchanged from prior spec)

- `hazard_evidence`, `hazard_witnesses`
- `recommendations`, `recommendation_responses`
- `work_refusals`, `critical_injuries`
- `witness_statements`, `evidence_files`
- `reprisal_records`, `accommodation_records`, `incidents`
- `practice_journal_entries`, `predecessor_briefs`, `training_records`
- `coi_register`, `elections`, `self_audits`
- `legal_corpus_entries`, `legal_citations_used`
- `regulator_orders`, `case_law_entries`
- `calculator_runs`, `adversarial_analyses`, `counterargument_predictions`
- `messages`, `message_threads`, `notifications` (Release 3)
- `audit_log`, `consent_records`, `export_records`

### Excel Import Tables

```
excel_imports
├── id
├── filename                 (original, for reference)
├── file_hash                (SHA-256 of the source file — never the file itself)
├── imported_by_user_id
├── imported_at
├── meeting_id               (if the import was a meeting load)
├── items_created            (count)
├── items_updated            (count)
├── items_skipped            (count)
├── items_conflicted         (count, awaiting rep decision)
├── reversal_window_ends_at  (30 days from import)
└── status                   (preview | committed | reverted | expired)

excel_import_items
├── id
├── import_id
├── source_row_number        (in the Excel file)
├── source_sheet_name
├── content_hash             (for reconciliation)
├── proposed_action          (create | update | skip | conflict)
├── target_action_item_id    (if update, the matched existing record)
├── parsed_payload           (JSON of the proposed action item content)
├── conflict_reason          (if status=conflict)
└── committed_action_item_id (after commit, the created/updated action item ID)
```

---

## 5. Action Flag Computation

The Action Flag is computed from item state on every read. Pure function, no stored state — derived from `start_date`, `status`, `closed_date`, `section`.

```
function computeActionFlag(item, today):
    age_days = days(today - item.start_date)

    if item.section == "new_business":
        if item.status == "Closed":
            return "✓ Recently Closed"
        if age_days <= 21:
            return "🟠 <21 days"
        return "🟠 >21 days — move to Old Business"

    if item.section == "old_business":
        if item.status == "Closed":
            return "✓ Recently Closed"
        return null  // No flag needed, it's already in old business

    if item.section == "recommendation":
        days_since = days(today - item.start_date)
        if item.has_management_response:
            return "✓ Response received"
        if days_since > 21:
            return "🔴 s.9(21) response overdue"
        return f"🟡 {21 - days_since} days to s.9(21) response"

    if item.section == "completed_this_period":
        days_closed = days(today - item.closed_date)
        if days_closed > 21:
            return "⬇ Archive to Closed sheet"
        return "✓ Recently Closed"

    return null
```

This is rendered in the UI consistently with the established Excel vocabulary so reps already read it fluently.

---

## 6. Excel Import Architecture

### Why Client-Side Only

The raw Excel file contains real names, real workplace data. Uploading the file to Fly or Neon would put plaintext sensitive data on US-incorporated infrastructure. Even with at-rest encryption, the file would briefly exist in plaintext on the server. We don't accept that.

**SheetJS runs entirely in the browser.** The file's bytes never leave the device until they've been parsed into structured records and the sensitive fields have been encrypted.

### Import Pipeline

```
1. User selects .xlsx/.xlsm file via file picker
   │
2. SheetJS parses workbook in browser (no upload)
   │
3. Schema detector recognizes file structure
   │   - Checks for known sheets: Agenda, Meeting Minutes, _MoveHistory, Closed Items, Inspection Findings
   │   - Identifies section headers (NEW BUSINESS, OLD BUSINESS, etc.)
   │   - Extracts column mapping from header rows
   │
4. Parser extracts records into typed JS objects
   │   - Meeting metadata (date, attendees, quorum)
   │   - Action items per section
   │   - Workplace inspection review
   │   - Closed items
   │
5. Reconciliation engine matches against existing records
   │   - content_hash = sha256(description + start_date)
   │   - Find existing action_items with matching content_hash
   │   - For each row: propose create | update | skip | conflict
   │
6. Preview UI shows what will happen
   │   - Counts: N to create, N to update, N skipped, N conflicted
   │   - Conflicted items shown with field-level diff
   │
7. User reviews and commits (or cancels)
   │
8. On commit:
   │   - Sensitive fields encrypted client-side
   │   - Encrypted payloads sent to API
   │   - API performs creates/updates inside a transaction
   │   - Each row creates an audit_log entry referencing the source file hash
   │   - Import is reversible for 30 days
```

### Schema Recognition

The parser recognizes the **minutes file family** only. (Inspection file imports are out of scope for Release 1; inspections are conducted natively in-app rather than imported from Excel.)

**Minutes file family** — recognized by:
- Sheets named "Meeting Minutes", "Closed Items", "Agenda", or "_MoveHistory"
- A "Meeting Date" cell in the header area
- Section header rows where col A is a number and col B is an uppercase title (NEW BUSINESS, OLD BUSINESS, etc.)
- A column header row with `#`, `Type`, `Issue Description`, `Recommended Action`, `Start Date`, `Raised By`, `Follow Up`, `Dept`, `Status`, `Risk`, `Action Flag`, `Age (Days)`

If the file doesn't match, we show a clear "we don't recognize this file" error with documentation link. No partial imports.

### Reconciliation Rules — Minutes

- **Same `content_hash` (description + start_date)**: update existing record. Status, risk, section, follow-up owner can change.
- **Same description but different `start_date`**: treated as new item.
- **Action items in the source file's "Closed Items" sheet** that don't exist locally: create with `status=Closed`, `section=archived`, `closed_date` from the file.
- **Action items in the local DB** with `source_excel_hash` matching this file's hash but not present in the new import: ignored.
- **Action items where `status` differs between local and source**: flagged as conflict, user decides.

### What Doesn't Import

- VBA macros (we don't execute foreign code)
- Drawings, embedded images (no provenance)
- Formulas outside the recognized schema (treated as values)
- **Inspection files** — not supported in Release 1. Workplaces conducting inspections in Excel today will conduct new inspections in-app going forward. Historical Excel inspection records remain in their source files.
- **Executive Summary section content** (skipped by design — not in the default meeting structure; can be re-added later as a custom section if needed)
- **WSIB Excellence Program section content** (skipped by design — same rationale)

---

## 6a. Inspection Export

Inspections can be exported as PDF documents — single inspection or date-range batch.

### Export Pipeline

```
1. Rep selects "Export" on a completed inspection (or date-range batch)
   │
2. Step-up auth required (passkey or TOTP)
   │
3. Server gathers the inspection record(s) + findings + evidence + signatures
   │
4. Server decrypts sensitive fields in memory only (never logged)
   │
5. PDF generation:
   - Source Serif 4, 11pt evidence-grade typography
   - Cover page: inspection ID, zone, date, inspector(s), document hash
   - Findings table per section with status indicators (text + symbol, never color-only)
   - Embedded photos at reduced size, with original hashes printed below each
   - Action items manually promoted from this inspection (linked by ID)
   - Inspector signatures (if collected)
   - Footer on every page: export timestamp, exporter identity, audit chain anchor, sha256 of the document
   │
6. PDF returned to client; cleartext fields zeroed in memory
   │
7. export_records entry created with:
   - exported_by_user_id
   - exported_at
   - inspection_ids exported
   - export_format ("pdf")
   - output_hash (sha256 of generated PDF)
   - audit_chain_anchor
```

### Export Scope

- **Single inspection** — most common case
- **Date-range batch** — "all Zone 5 inspections between Jan 1 and Dec 31, 2026"
  - Batch exports produce a single multi-section PDF, with a table of contents at front
  - Each constituent inspection retains its own document hash for individual verification
  - Maximum batch size: 100 inspections per export (rate limit + memory safety)

### Audit Trail on Exports

Every export creates an immutable audit entry. The audit entry records what was exported, by whom, when, and the hash of the output document. If an exported PDF is later disputed, the audit chain proves what was generated and when.

PDF footer includes a verification line:
```
Exported by [user] on [ISO date] · Doc hash: sha256 [hash] · Audit anchor: [hash]
```

If someone modifies the PDF after export, the hash check fails. The audit chain entry remains canonical.

### Why Not Excel / CSV / JSON Right Now

PDF only for Release 1 to keep scope tight. Excel and JSON exports are tracked for Phase 2 as deferred features — the value is moderate and the build cost (preserving formatting, handling photos, round-tripping schema) is non-trivial. If a workplace genuinely needs Excel output, that's the trigger to add it.

---

## 7. Authentication & Authorization

(Unchanged from prior spec. Passkey-primary, password + TOTP fallback, step-up auth for sensitive operations.)

### Step-Up Operations (Updated)

Added to the list:

- **Commit an Excel import** (irreversible after the 30-day window)
- **Revert an Excel import**
- **Move an action item to "archived"** (out of normal view)

---

## 8. Encryption Model

(Unchanged primitives. XChaCha20-Poly1305 via libsodium, Argon2id, EdDSA.)

### Encrypted Fields (Updated for Action Items)

Added to encrypted columns:

- `action_items.description` (when contains PII — detected by a server-side privacy classifier that runs locally, never sends content out)
- `action_items.recommended_action` (same)
- `action_items.raised_by_external_name` (for non-members named in minutes)
- `meeting_attendance.user_id_or_name` (for external attendees)
- `meeting_sections.body_markdown` (when section contains identifying detail)
- `excel_import_items.parsed_payload` (always encrypted; contains raw extracted content)

### Excel Import Encryption Flow

```
Browser (after SheetJS parse):
  1. Detect PII in fields using lightweight client-side heuristics (regex for names, patterns)
  2. For each action item:
     - Encrypt sensitive fields with the App Field Key
     - Build the encrypted payload {nonce, ciphertext, ad}
  3. Send the import batch to /api/excel-imports/preview
  4. Server stores excel_import_items with encrypted payloads
  5. On commit: server creates/updates action_items using the encrypted payloads
```

The master key never leaves the Fly Secrets, but the field key is derived deterministically server-side and delivered to the client at session start over TLS. The client-side encryption uses this key for the import flow.

---

## 9. Audit Log

(Unchanged structure. Hash chain with HMAC seed.)

### New Action Item Audit Events

- `action_item.create` (with source_type)
- `action_item.update` (with diff)
- `action_item.move` (from_section, to_section, reason)
- `action_item.verify` (closed by JHSC)
- `action_item.import` (source file hash)
- `excel_import.preview`
- `excel_import.commit`
- `excel_import.revert`
- `meeting.create`
- `meeting.adjourn`
- `meeting.finalize_minutes`
- `attendance.record`

---

## 10. Legal Corpus

(Unchanged from prior spec.)

---

## 11. Design System

(Color tokens, typography, spacing, motion — unchanged from prior spec.)

### New Component Patterns for Minutes Module

These extend the existing prototype vocabulary:

**`<ActionItemRow />`** — primary list item. Shows:
- Sequence number (mono)
- Type badge (colored chip)
- Description (truncated to 2 lines)
- Status pill
- Risk indicator
- Action Flag emoji + label
- Age in days
- Quick-action menu (move, edit, close, link)

**`<SectionTabs />`** — tabs for switching between section views. On mobile, horizontally scrollable. On desktop, full-width with counts.

| Tab | Default Filter |
|---|---|
| New Business | section=new_business AND status!=Closed |
| Old Business | section=old_business AND status!=Closed |
| Recommendations | section=recommendation |
| Completed | section=completed_this_period |
| Archived | section=archived (collapsed by default) |
| All Open | status!=Closed across all sections |
| Past 21 Days | action_flag matches "🟠 >21 days" or "🔴" |

**`<MoveItemSheet />`** — mobile bottom sheet for moving an action item. Shows target sections with item counts, an optional reason field, and a confirm button. Move is audit-logged.

**`<MeetingHeader />`** — sticky header in the Meeting Minutes view. Shows meeting date, status (in-progress/adjourned/finalized), quorum status, attendee count, time remaining (if active).

**`<KeyMetricsDashboard />`** — the per-meeting metrics card. Shows the 5 KPIs from the Excel: new business count, old business count, recommendations count, closed-this-period count, oldest item age.

**`<ExcelImportPreview />`** — large modal/page showing the import preview. Tabs for Create/Update/Skip/Conflict. Each row expandable to show field-level detail.

### Print Stylesheet for Minutes Document

The generated minutes PDF follows this structure:

- Header: facility name (from config), meeting date, quorum
- Key Metrics Dashboard
- Attendance table (with signatures area at bottom)
- Workplace Inspection Review
- New Business table
- Old Business table
- Notice of Recommendation
- Completed / Closed Items
- Any custom sections in `order_position` order
- Signatures block (Worker Co-Chair, Mgmt Co-Chair, Warehouse Mgr, Plant Mgr)
- Distribution list
- Retention statement
- Document hash + audit chain anchor at the foot

Source Serif 4, 11pt, 1.5 line height. Tables hairline borders, no fill. Status indicators text-only (B&W must be unambiguous).

---

## 12. Deployment

(Fly.io YYZ + Neon ca-central-1 + Tigris. Unchanged from prior spec.)

---

## 13. Open Questions for Build Time

These are intentionally deferred:

- Whether the PII heuristic for encryption should be machine-learned or rule-based (start rule-based)
- Whether Excel imports should support `.csv` and `.tsv` as alternate formats (probably yes, Phase 2)
- Whether the meeting agenda template should be customizable per meeting or fixed (start fixed, allow override)
- Whether Section moves should require a reason (default no, but configurable)
- Whether the signature collection should support drawn signatures on touchscreen (probably yes, Release 2)
