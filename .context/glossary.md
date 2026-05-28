# Glossary — JHSC Worker Hub

Domain terms and their precise meaning in this project. When a term is ambiguous in the world but specific here, the **here** meaning wins.

## Statutory bodies and frameworks

- **OHSA** — Ontario _Occupational Health and Safety Act_. Provincially regulated workplaces in Ontario.
- **CLC Part II** — _Canada Labour Code Part II_. Federally regulated workplaces (e.g. inter-provincial transport, banking, telecom).
- **MLITSD** — Ontario _Ministry of Labour, Immigration, Training and Skills Development_. The provincial regulator and inspectorate.
- **OLRB** — _Ontario Labour Relations Board_. Hears reprisal complaints under OHSA s.50.
- **Labour Program** — federal counterpart to MLITSD under CLC Part II.

## JHSC roles and entities

- **JHSC** — _Joint Health & Safety Committee_. Statutory committee co-chaired by a worker rep and an employer rep.
- **Worker co-chair** — the worker-side chair of the JHSC. The primary user of this app.
- **Rep team** — the worker reps on the JHSC who report to the worker co-chair. Secondary users.
- **Certified member** — JHSC member who has completed certification training; required for OHSA s.43 work-refusal investigations.
- **Single workplace** — this project serves exactly one workplace. No multi-tenancy.

## Statutory citations (used in copy and UI)

- **OHSA s.9(21)** — the 21-day clock for employer written response to JHSC recommendations.
- **OHSA s.43** — work refusal for unsafe work.
- **OHSA s.50** — reprisal protection.
- **CLC s.128** — federal work refusal.
- **CLC s.147** — federal reprisal protection.

## Core domain objects

- **Hazard** — an identified unsafe condition or practice. Can be linked to action items; is not itself an action item.
- **Recommendation** — a formal JHSC recommendation issued to the employer. Starts the s.9(21) clock.
- **Action item** — first-class entity with its own lifecycle (open, in-progress, blocked, closed, withdrawn). Tracked through Minutes. Not a sub-concept of hazards.
- **Minutes** — meeting record. Operational hub of the app. Contains sections where action items live, age, and move under the s.9(21) clock.
- **Inspection** — structured workplace walkthrough. Conducted under a specific template version, frozen at conduct time.
- **Finding** — an observation made during an inspection. Status codes include X (no issues) and G (green); these cannot be promoted to action items.
- **Template version** — the version of an inspection template in force when the inspection was conducted. Immutable on the inspection record.
- **Zone** — a physical area of the workplace. Identified by stable IDs `zone_1` … `zone_10`. Display names are configurable per workplace and can change without breaking historical inspections.
- **Promote** — manual action by the inspector turning a finding into a tracked action item, with a Risk level chosen at promotion.

## Security and audit vocabulary

- **Evidentially sensitive** — data that may end up as evidence before MLITSD, OLRB, the Labour Program, or an arbitrator. Treat with chain-of-custody and tamper-evident logging.
- **Audit chain** — append-only hash-chained log of sensitive actions. Each entry's hash includes the previous entry's hash. Verifiable by `scripts/audit-log-verify.ts`.
- **Step-up auth** — a fresh authentication challenge (passkey or TOTP) required immediately before a sensitive action such as an export.
- **Output document hash** — SHA-256 of an exported PDF, logged into the audit chain alongside who exported what, when, and why.
- **Envelope encryption** — application-layer field encryption (XChaCha20-Poly1305) where a per-record data key is itself encrypted by a workplace key the operator controls.
- **Pseudonymize at intake** — replace direct identifiers with opaque IDs at the moment of capture; the mapping is stored separately and encrypted.

## Operational vocabulary

- **Single-tenant** — one workplace, one database, one deployment. No tenant scoping.
- **Worker-controlled** — runs on infrastructure the worker side controls; never on employer infrastructure.
- **Mobile-primary** — every feature designed for a 390 px phone first; desktop is the expanded version.
- **Local-first** — Dexie/IndexedDB is the source of truth on the device; sync is reconciliation, not authority.
- **Opt-in AI** — AI features are off by default; each feature captures explicit per-feature consent before any data leaves the device.
