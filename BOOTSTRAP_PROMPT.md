# BOOTSTRAP_PROMPT.md — How to Start

This document is how you start the project once you have a fresh repo and Claude Code installed.

---

## Step 1 — Create the Repo

```bash
mkdir jhsc-worker-hub
cd jhsc-worker-hub
git init
```

Copy these files into the repo:

**Root:**
- `CLAUDE.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `ROADMAP.md`
- `BOOTSTRAP_PROMPT.md`

**`design/prototypes/`:**
- `PROTOTYPES.md`
- `app-shell.tsx`
- `hazard-detail.tsx`
- `recommendation-drafting.tsx`
- `capture-to-record.tsx`
- `adversarial-lens.tsx`
- `meeting-minutes.tsx` (the new one — Minutes module / action item list)

Commit:

```bash
git add .
git commit -m "Initial spec and design prototypes"
```

Create a private GitHub repo and push.

---

## Step 2 — Prerequisites

You need:

- **Node.js 20+** or **Bun 1.1+**
- **pnpm 9+** (`npm install -g pnpm`)
- **Bun 1.1+** (`curl -fsSL https://bun.sh/install | bash`)
- **flyctl** (`curl -L https://fly.io/install.sh | sh`)
- **Docker Desktop** (for local Postgres in dev)
- **Claude Code** installed and authenticated
- **Fly.io account** (free tier)
- **Neon account** (free tier)
- **Tigris account** (via Fly)

---

## Step 3 — Run This Prompt in Claude Code

Open Claude Code at the repo root, then paste this prompt exactly:

---

> **Start of bootstrap prompt — paste into Claude Code**
>
> I'm starting a new project: **JHSC Worker Hub**. The full specification is in `CLAUDE.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `ROADMAP.md` in this repo. The design contracts are in `design/prototypes/` — six `.tsx` reference files plus `PROTOTYPES.md` explaining how to use them.
>
> Before you do anything else, read these in order:
>
> 1. `CLAUDE.md` (project rules, non-negotiables, tech stack, conventions)
> 2. `ROADMAP.md` (release plan and current milestone)
> 3. `ARCHITECTURE.md` (system design, data model, design system, Excel import architecture)
> 4. `SECURITY.md` (threat model, controls, Excel import security)
> 5. `design/prototypes/PROTOTYPES.md` (how to use the design contracts)
> 6. `design/prototypes/app-shell.tsx` (foundation visual language)
> 7. `design/prototypes/hazard-detail.tsx` (Citation Hover signature interaction)
> 8. `design/prototypes/recommendation-drafting.tsx`
> 9. `design/prototypes/capture-to-record.tsx`
> 10. `design/prototypes/adversarial-lens.tsx`
> 11. `design/prototypes/meeting-minutes.tsx` (action item list + Section Move signature interaction)
>
> Once you've read them all, your task is **Release 1, Milestone 1.1 — Foundation**.
>
> Scaffold the project per the locked tech stack:
>
> 1. Set up a **pnpm monorepo** with workspace structure matching `CLAUDE.md` § Repository Layout
> 2. Create `apps/web` — React 18 + Vite 7 + TypeScript (strict) + vite-plugin-pwa, Tailwind CSS + shadcn/ui pre-configured
> 3. Create `apps/api` — Hono on Bun, deployable to Fly.io
> 4. Create `apps/ai-proxy` — separate minimal Hono service, skeleton only, no Anthropic integration yet
> 5. Create empty package scaffolds: `packages/shared-types`, `packages/ui`, `packages/crypto`, `packages/audit`, `packages/legal-corpus`, `packages/calculators`, **`packages/excel-import`**
> 6. Set up **Drizzle ORM + Drizzle Kit** pointed at a local Postgres for dev (Docker Compose)
> 7. Set up **Vitest** for unit tests, **Playwright** for e2e
> 8. Set up **GitHub Actions CI**: lint, typecheck, test on PR
> 9. Create `fly.toml` for both deployable apps (region `yyz`)
> 10. Implement the **design tokens** from `ARCHITECTURE.md` §11 and the prototypes into `packages/ui` as Tailwind config + CSS variables
> 11. Scaffold the **app shell** in `apps/web` matching `design/prototypes/app-shell.tsx`:
>     - Bottom tab bar (mobile) / left sidebar (desktop)
>     - Theme: light/dark/follow system
>     - **5 primary tabs: Minutes · Hazards · Inspections · Recommendations · More** (Minutes is the new primary tab — replaces Dashboard on mobile per `ARCHITECTURE.md §3`)
>     - Restrained legal-grade aesthetic per the spec
>     - Mock data is fine at this stage
> 12. Add `config/workplace.ts` template loaded from env vars; `.env.example` documents required vars
> 13. Add `docs/excel-import-format.md` documenting the supported Excel schema (Meeting Minutes structure: section headers, column mapping, action item columns) — placeholder content for now, will be filled in during Milestone 1.11. Inspection file imports are not supported in Release 1.
>
> Do not implement business logic yet. Do not build forms, data models, or features. This milestone is foundation only.
>
> Constraints — re-read `CLAUDE.md` § Non-Negotiables before you start:
>
> - No specific workplace name, person name, or union local anywhere in code
> - No marketing aesthetics
> - No union iconography
> - TypeScript strict mode
> - Every package has tests scaffolded
> - Conventional Commits in git history
> - **Action items are first-class, not a sub-type of hazards** (non-negotiable #12)
> - **Excel parsing happens client-side only** (non-negotiable #11)
>
> Walk through your plan first — list the files you'll create, dependencies you'll install, configuration you'll set up. Wait for my approval before writing any code. After approval, proceed step by step, stopping after each major group (root setup → apps/web → apps/api → ai-proxy → packages → CI) to let me review.
>
> Begin by reading the documents.

---

> **End of bootstrap prompt**

---

## Step 4 — Workflow After Bootstrap

After Milestone 1.1:

1. Open Claude Code
2. Reference `ROADMAP.md` and tell Claude Code which milestone you're on
3. Ask it to read `CLAUDE.md` and the relevant section of `ARCHITECTURE.md`
4. Ask it to plan, then implement
5. Review and commit
6. Next milestone

### Helpful Prompts

For Milestone 1.6 (Action Items):

> "Working on Release 1, Milestone 1.6 — Action Items. Re-read `CLAUDE.md` § Action Item Conventions and `ARCHITECTURE.md` §4 (data model for action_items + action_item_moves) and §5 (Action Flag computation). Also reference `design/prototypes/meeting-minutes.tsx` for the visual treatment of the action item list, section tabs, and the swipe-to-move interaction. Walk through the plan first."

For Milestone 1.8 (Inspections):

> "Working on Release 1, Milestone 1.8 — Inspections. Re-read `CLAUDE.md` § Non-Negotiables 13-16 (template versioning, zone IDs stable, manual promotion, export auth) and `ARCHITECTURE.md` § Inspections Module Detailed and §6a Inspection Export. Seed the Zone Monthly template (14 sections, ABC status, Employee Interview closer) and the Rack Inspection template (4 sections, GAR status, three-signature workflow). Workplace zones declared in `config/workplace.ts` as zone_1 through zone_10 with renamable display_name. Mobile-first capture flow, photos per finding (encrypted client-side), manual one-tap promotion to action items (inspector chooses Risk at promotion time). PDF export with hash provenance footer. Walk through the plan first."

For Milestone 1.11 (Excel Import):

> "Working on Release 1, Milestone 1.11 — Excel Import. Re-read `CLAUDE.md` § Excel Import Rules, `ARCHITECTURE.md` §6 (Excel Import Architecture), and `SECURITY.md` §4 (Excel Import Security). Minutes files only — inspection file imports are out of scope for Release 1. The parser must run entirely client-side — never upload the raw file. Use SheetJS pinned to the latest stable version. Walk through the plan first."

For sensitive paths in general:

> "This touches encrypted data. Re-read `SECURITY.md` before writing. Include tests on sensitive paths and audit log emission. Step-up auth required for decryption."

For when Claude Code drifts:

> "Stop. Re-read `CLAUDE.md` § Non-Negotiables. The last response violated rule #N. Redo this."

---

## Step 5 — When to Update the Spec Files

Update spec files when:

- A milestone reveals a wrong assumption in `ARCHITECTURE.md`
- A new attack vector emerges → update `SECURITY.md`
- A milestone slips → update `ROADMAP.md` estimates
- A new convention emerges → update `CLAUDE.md`
- The Excel file format evolves (e.g., new section types) → update `docs/excel-import-format.md`

Treat updates as first-class commits.

---

## Step 6 — Production Deployment Checklist

Before pointing real workplace data at production:

- [ ] Run through `SECURITY.md` § Pre-Launch Security Checklist
- [ ] Set up domain and DNS to Fly
- [ ] Generate production master key, store in Fly Secrets
- [ ] Provision production Neon database in `ca-central-1`
- [ ] Provision production Tigris bucket
- [ ] Run all Drizzle migrations against production
- [ ] Seed `packages/legal-corpus`
- [ ] Configure `config/workplace.ts` env vars
- [ ] Enable HSTS preload submission
- [ ] Set up Fly health checks and monitoring
- [ ] Configure nightly audit log verification cron
- [ ] Configure nightly encrypted backup cron
- [ ] Document production runbook
- [ ] Create first co-chair account via first-run setup
- [ ] Enroll a passkey
- [ ] Test end-to-end auth, hazard intake, recommendation drafting, action item move, Excel import, export

---

## What Success Looks Like at 6 Months

- Release 1 deployed and used daily
- Existing Excel minutes file imported successfully — all action items, attendance, and history live in the app
- Release 2 deployed with native meeting workflows
- At least one full JHSC meeting cycle conducted in the app instead of Excel
- Release 3 in late development or shipped
- Audit log has months of verified entries
- At least one MLITSD or arbitration matter supported by records from the app
- You can demonstrate the Citation Hover, Adversarial Lens, Capture-to-Record, and Section Move interactions to another rep without explanation
- The app has not needed a major restructure
- You still want to keep building

---

## What to Do If This Stalls

In order of preference:

1. **Reduce scope.** Cut features from the current milestone, ship something useful, return later.
2. **Ask for help.** A second developer for a focused two-week block can unstick a lot.
3. **Switch hosting if it's a friction source.** Spec is portable.
4. **Pause and use what exists.** If Release 1 has even a working hazard log + citation engine + Excel import, that's already more than you had.
5. **Abandon if it's harming your real work.**

There is no shame in any of these. The app is a means.
