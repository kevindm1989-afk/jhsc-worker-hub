#!/usr/bin/env bun
// Milestone 1.8 (ADR-0007 §3.4) seeder for the inspection templates.
//
// SLICE 2 STATUS: PAYLOAD LANDED.
//
// Two seeded templates ship at v1:
//   - zone_monthly   — 15 sections (14 walk-through + Employee Interview
//                      closer), ABC_X vocab, no three-sig requirement.
//                      Generic worker-safety language; no workplace
//                      identifiers; no union iconography.
//   - rack_inspection — 4 sections per the CSA A344 structural shape,
//                       GAR vocab, three-sig requirement.
//
// CSA COPYRIGHT CAUTION (CLAUDE.md §"Legal Reference Module Rules" §5,
// SECURITY.md T-I8 / T-I9 / T-I10, ADR-0007 §3.4):
//   - The rack_inspection template MUST store clause numbers + section
//     headings + our-own-words summaries ONLY.
//   - NEVER store verbatim CSA A344 text, exemplar diagrams, or
//     transcribed prescriptive tolerance values (e.g. do NOT write a
//     numeric plumb tolerance — write "per CSA A344.1 §X.Y").
//   - Every item that points at CSA carries an editorial-review marker
//     comment so a 2-person review can grep for "CSA-POINTER" and confirm
//     coverage before merge (same posture as legal-corpus priv-F3 from
//     1.4).
//   - The seeded chain anchor payload carries `structureSha256` and
//     `sectionCount` ONLY — never section text, item text, or criteria
//     (T-I10).
//
// Usage:
//   DATABASE_URL=... bun run apps/api/scripts/seed-inspection-templates.ts

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { append, canonicalJsonStringify, type DrizzlePg } from '@jhsc/audit';
import type { InspectionStatusVocabKind, InspectionTemplateCode } from '@jhsc/shared-types';
import { getDb } from '../src/db/client';

// All-zero UUID. The seeder is the only emitter of
// `audit.inspection_template.seeded` and runs without an authenticated
// actor (deploy-time seed, not a user action). The route layer rejects
// any external request whose `actorId` matches this constant — mirrors
// the legal-corpus seed posture (priv-F3 forward defense; see T-I9 /
// T-I33 in SECURITY.md §2.8 for the runbook cross-check).
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Authored shapes
// ---------------------------------------------------------------------------

/**
 * One item under a section. `key` is a stable slug snapshotted onto
 * findings at conduct time (ADR-0007 §3.6). `label` is plain-English
 * worker-safety prose (NEVER verbatim CSA). `helpText` is optional and,
 * for CSA-pointer rack items, carries the clause reference in OUR OWN
 * words.
 */
export interface SeedTemplateItem {
  readonly key: string;
  readonly label: string;
  readonly helpText?: string;
}

export interface SeedTemplateSection {
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<SeedTemplateItem>;
}

export interface SeedTemplateInput {
  readonly templateCode: InspectionTemplateCode;
  readonly versionNumber: number;
  readonly displayName: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly cadence: 'monthly' | 'quarterly' | 'annual' | 'ad_hoc';
  readonly requiresThreeSignatures: boolean;
  readonly sections: ReadonlyArray<SeedTemplateSection>;
}

// ---------------------------------------------------------------------------
// Zone Monthly v1 — 14 sections + Employee Interview closer, ABC_X vocab.
//
// Generic worker-safety language. No workplace identifiers. No union
// iconography. Each item ID is a stable snake_case slug; the label is
// plain English. helpText is optional; the seeder ships sparingly here
// because the Zone Monthly items are self-explanatory (the inspector
// knows what "panic hardware operates freely" means without a CSA
// reference).
// ---------------------------------------------------------------------------

const ZONE_MONTHLY_SECTIONS: ReadonlyArray<SeedTemplateSection> = [
  {
    key: 'emergency_exits',
    label: 'Emergency Exits',
    items: [
      { key: 'unobstructed', label: 'Exits unobstructed and clearly visible' },
      { key: 'signage_lit', label: 'Exit signs illuminated' },
      { key: 'panic_hardware', label: 'Panic hardware operates freely' },
      { key: 'egress_path_clear', label: 'Egress path clear of stored material' },
      { key: 'door_seals', label: 'Doors close and latch without binding' },
    ],
  },
  {
    key: 'racking',
    label: 'Racking',
    items: [
      { key: 'visible_damage', label: 'No visible damage to uprights or beams' },
      { key: 'load_signs_posted', label: 'Load-capacity signage posted and legible' },
      { key: 'safety_pins', label: 'Beam safety clips engaged' },
      { key: 'overhang', label: 'Loads sit within the beam footprint (no overhang)' },
    ],
  },
  {
    key: 'floors_aisles',
    label: 'Floors / Aisles',
    items: [
      { key: 'spill_free', label: 'Floor free of liquid or debris' },
      { key: 'aisle_marked', label: 'Aisle markings visible and unworn' },
      { key: 'aisle_width', label: 'Aisles maintained at posted width' },
      { key: 'surface_condition', label: 'Floor surface free of cracks or trip hazards' },
    ],
  },
  {
    key: 'stairs',
    label: 'Stairs',
    items: [
      { key: 'handrails_secure', label: 'Handrails firmly anchored' },
      { key: 'treads_intact', label: 'Treads and nosings intact, non-slip surface in place' },
      { key: 'lighting', label: 'Stairwell adequately lit' },
      { key: 'no_storage', label: 'Stairs and landings clear of stored items' },
    ],
  },
  {
    key: 'dock_safety',
    label: 'Dock Safety',
    items: [
      { key: 'dock_locks_function', label: 'Dock locks or wheel chocks in use during loading' },
      { key: 'edge_visibility', label: 'Dock edges painted or otherwise marked' },
      {
        key: 'levellers_condition',
        label: 'Dock levellers operate smoothly with no visible damage',
      },
      {
        key: 'communication',
        label: 'Communication signals between driver and dock operator agreed',
      },
      {
        key: 'pedestrian_separation',
        label: 'Pedestrian routes separated from dock vehicle paths',
      },
    ],
  },
  {
    key: 'ghs',
    label: 'GHS / WHMIS',
    items: [
      { key: 'labels_legible', label: 'Supplier and workplace labels intact and legible' },
      { key: 'sds_accessible', label: 'Safety Data Sheets accessible to workers in the area' },
      { key: 'storage_compatible', label: 'Incompatible chemicals stored separately' },
      { key: 'training_current', label: 'Workers in area appear current on WHMIS training' },
    ],
  },
  {
    key: 'ppe',
    label: 'PPE',
    items: [
      { key: 'available', label: 'Required PPE available at point of use' },
      { key: 'condition', label: 'PPE in serviceable condition (no tears, cracks, missing parts)' },
      { key: 'worn_correctly', label: 'PPE worn correctly by workers in the area' },
      { key: 'signage', label: 'PPE-required signage posted where applicable' },
    ],
  },
  {
    key: 'emergency_response_equipment',
    label: 'Emergency Response Equipment',
    items: [
      {
        key: 'extinguishers_charged',
        label: 'Fire extinguishers charged and inspection tags current',
      },
      {
        key: 'extinguishers_unobstructed',
        label: 'Extinguishers unobstructed and clearly visible',
      },
      { key: 'eyewash_accessible', label: 'Eyewash or safety shower accessible where required' },
      { key: 'first_aid_stocked', label: 'First-aid kits stocked and seal intact' },
      { key: 'alarms_unobstructed', label: 'Pull stations and alarms unobstructed' },
    ],
  },
  {
    key: 'machine_handling',
    label: 'Machine Handling',
    items: [
      { key: 'guards_in_place', label: 'Machine guards in place and undamaged' },
      { key: 'e_stops_function', label: 'E-stops accessible and functional' },
      { key: 'pinch_points_marked', label: 'Pinch points marked or guarded' },
      { key: 'lockout_points_labelled', label: 'Lockout/tagout energy isolation points labelled' },
    ],
  },
  {
    key: 'other_equipment',
    label: 'Other Equipment',
    items: [
      { key: 'cords_intact', label: 'Power cords intact, not pinched or run under traffic' },
      {
        key: 'inspection_tags_current',
        label: 'Inspection or service tags current where required',
      },
      { key: 'no_makeshift_repairs', label: 'No tape-and-zip-tie repairs in service' },
    ],
  },
  {
    key: 'compactor',
    label: 'Compactor',
    items: [
      {
        key: 'guards_secure',
        label: 'Compactor guards and interlocks engage and disengage cleanly',
      },
      { key: 'access_panels_closed', label: 'Access panels closed and secured' },
      { key: 'controls_labelled', label: 'Operating controls clearly labelled' },
      { key: 'area_clear', label: 'Surrounding area clear of debris and trip hazards' },
    ],
  },
  {
    key: 'electrical_panels',
    label: 'Electrical Panels',
    items: [
      { key: 'clearance', label: 'Working clearance in front of panels maintained' },
      { key: 'covers_secure', label: 'Panel covers in place and secured' },
      { key: 'breakers_labelled', label: 'Breakers individually labelled' },
      { key: 'no_storage_front', label: 'No storage in front of or on top of panels' },
    ],
  },
  {
    key: 'maintenance_area',
    label: 'Maintenance Area',
    items: [
      { key: 'housekeeping', label: 'Work area orderly; tools and parts in designated storage' },
      {
        key: 'hot_work_controls',
        label: 'Hot-work controls (welding curtains, ventilation) available',
      },
      {
        key: 'waste_containers',
        label: 'Oily-rag and chemical-waste containers in use and labelled',
      },
      { key: 'ventilation', label: 'Local exhaust ventilation operational where required' },
    ],
  },
  {
    key: 'outside_of_building',
    label: 'Outside of Building',
    items: [
      { key: 'walkway_condition', label: 'Walkways free of ice, debris, or surface damage' },
      { key: 'lighting', label: 'Exterior lighting functional at entrances and walkways' },
      { key: 'smoking_area', label: 'Designated smoking area maintained and signed' },
      { key: 'trash_secured', label: 'Outdoor bins secured against animals and weather' },
    ],
  },
  {
    key: 'employee_interview',
    label: 'Employee Interview',
    items: [
      {
        key: 'concerns_raised',
        label: 'Any health or safety concerns the worker wants on record',
        helpText:
          'Open-ended prompt. Capture worker concerns in their own words. Avoid identifying co-workers by name unless the worker explicitly asks for that detail to be recorded.',
      },
      {
        key: 'recent_incidents',
        label: 'Any near-miss or incident in the last period the worker observed',
      },
      {
        key: 'training_gaps',
        label: 'Training or procedure gaps the worker has noticed',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rack Inspection v1 — CSA A344 structural shape, GAR vocab, three-sig.
//
// CSA-POINTER MARKERS: every helpText that references a CSA clause uses
// the explicit format "(per CSA A344.X §Y.Z)" so a 2-person editorial
// review can grep `helpText.*CSA` to confirm coverage. The grep is part
// of the runbook's pre-merge gate. NO verbatim CSA text. NO transcribed
// numeric tolerances. Where a tolerance is essential, the helpText says
// "within manufacturer tolerance" or "per the load-capacity sign at the
// rack," NEVER a value cribbed from the standard.
// ---------------------------------------------------------------------------

const RACK_INSPECTION_SECTIONS: ReadonlyArray<SeedTemplateSection> = [
  {
    key: 'structural_integrity',
    label: 'Structural Integrity',
    items: [
      {
        key: 'verticality',
        label: 'Upright frames vertical and undamaged',
        helpText:
          'Sight along each upright for deflection or impact damage. Verticality tolerance is per CSA A344.1 §6.3; do not infer a number from spec memory. CSA-POINTER.',
      },
      {
        key: 'anchor_bolts',
        label: 'Anchor bolts present, tensioned, and free of corrosion',
        helpText:
          'Verify anchor count and condition matches the rack drawings or manufacturer specification (per CSA A344.1 §6.4). CSA-POINTER.',
      },
      {
        key: 'column_protection',
        label: 'Column protectors and aisle-end guards in place where required',
        helpText:
          'Required locations and minimum heights are described in CSA A344.1 §6.5. Confirm protection devices are present and undamaged — note any missing, cracked, or displaced guards. CSA-POINTER.',
      },
      {
        key: 'floor_condition',
        label: 'Floor under uprights free of cracks, spalling, or settlement',
        helpText:
          'Examine the slab under and around each baseplate. Concrete defects affecting baseplate seating are an in-scope finding per CSA A344.1 §6.4. CSA-POINTER.',
      },
      {
        key: 'frame_damage',
        label: 'No visible deformation, denting, or twist in upright frame members',
        helpText:
          "Inspect each upright and horizontal/diagonal bracing for impact damage. Acceptance vs. unload-and-replace is per CSA A344.2 §5; do not transcribe the standard's thresholds — write what you observe. CSA-POINTER.",
      },
    ],
  },
  {
    key: 'beam_and_hardware',
    label: 'Beam & Hardware',
    items: [
      {
        key: 'beam_deflection',
        label: 'Beams show no visible bowing or permanent set under load',
        helpText:
          'Sight along each loaded beam. Manufacturer or CSA A344.1 §7 governs the acceptable deflection — record observed condition only, not a measured tolerance. CSA-POINTER.',
      },
      {
        key: 'beam_clips_engaged',
        label: 'Beam safety clips or locking devices engaged on every beam end',
        helpText:
          'Each beam end carries a positive locking device per CSA A344.1 §7. Confirm presence and engagement at both ends; flag any missing or partially seated clip. CSA-POINTER.',
      },
      {
        key: 'connector_condition',
        label: 'Beam-to-upright connectors free of cracks or elongated holes',
        helpText:
          'Inspect the welded or stamped connector at each beam end. Elongation, cracking, or weld failure is an immediate-action finding per CSA A344.2 §5. CSA-POINTER.',
      },
      {
        key: 'load_signage',
        label: 'Load-capacity signage posted at each rack run and legible from the aisle',
        helpText:
          'Signage content and posting requirements are per CSA A344.1 §10. The actual capacity numbers come from the rack engineer — verify the sign matches the configuration, do not derive numbers from the standard. CSA-POINTER.',
      },
      {
        key: 'wire_decking',
        label: 'Wire decks, pallet supports, or shelving panels seated correctly',
        helpText:
          'Decks should engage all beam-rail flanges and lie flat with no missing waterfall edges. Reference CSA A344.1 §7 for support requirements. CSA-POINTER.',
      },
    ],
  },
  {
    key: 'specialty_racking',
    label: 'Specialty Racking',
    items: [
      {
        key: 'cantilever_arms',
        label: 'Cantilever arms level, undamaged, and within posted capacity',
        helpText:
          'Cantilever-specific structural requirements live in CSA A344.1 §8. Confirm arm-to-column connections engaged and unloaded arms remain horizontal. CSA-POINTER.',
      },
      {
        key: 'drive_in_rails',
        label: 'Drive-in / drive-through rails secure with no visible damage from forklift contact',
        helpText:
          'Drive-in systems carry repeated forklift impact; inspect rails, ladders, and back stops per CSA A344.1 §9. CSA-POINTER.',
      },
      {
        key: 'push_back_carts',
        label: 'Push-back or flow-rail carts and rollers operate freely',
        helpText:
          'Verify carts return to position, rollers turn without binding, and no debris obstructs the flow channel. Reference CSA A344.1 §9. CSA-POINTER.',
      },
      {
        key: 'mezzanine_handrails',
        label: 'Mezzanine handrails, kick plates, and access gates intact where applicable',
        helpText:
          'Rack-supported mezzanines fall under CSA A344.1 §11 and applicable building-code guarding requirements. Record condition; do not derive guarding heights from the standard. CSA-POINTER.',
      },
    ],
  },
  {
    key: 'safety_documentation',
    label: 'Safety Documentation',
    items: [
      {
        key: 'load_application_drawings',
        label: 'Current load-application drawings or configuration sheets on file',
        helpText:
          'CSA A344.1 §10 requires that load-capacity documentation match the in-use configuration. Confirm the drawings on file reflect the current bay layout. CSA-POINTER.',
      },
      {
        key: 'damage_reporting_procedure',
        label: 'Workplace damage-reporting procedure posted or otherwise communicated',
        helpText:
          'CSA A344.2 §6 expects a documented damage-reporting path so impact damage flows back to the responsible party. Confirm the procedure exists and is accessible. CSA-POINTER.',
      },
      {
        key: 'prior_inspection_findings',
        label: 'Prior inspection corrective actions verified closed or carried forward',
        helpText:
          'Review the previous inspection record. Open items should appear in the action-items log; verify visible items on the floor are resolved or in-progress.',
      },
      {
        key: 'forklift_operator_awareness',
        label: 'Forklift operators in the area aware of damage-reporting expectations',
        helpText:
          'Brief check — ask one operator to describe how they would report rack damage. CSA A344.2 §6 expects awareness at the point of impact.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

/**
 * Idempotent: SELECT first on (template_code, version_number); INSERT +
 * audit anchor only when missing. Payload (PI-clean per T-I10) carries
 * `templateVersionId + templateCode + version + statusVocab +
 * sectionCount + structureSha256`. NEVER section text.
 *
 * Returns `{ inserted, skipped }`. Called from the first-run confirm
 * handler (same pattern as ensureWorkplaceKey) and from the
 * `pnpm seed:inspection-templates` dev script.
 */
export async function seedInspectionTemplates(
  db: DrizzlePg,
): Promise<{ inserted: number; skipped: number }> {
  const inputs = collectSeedInputs();
  let inserted = 0;
  let skipped = 0;
  for (const input of inputs) {
    const written = await db.transaction(async (tx) => {
      const existing = (await tx.execute(sql`
        SELECT id FROM inspection_templates
        WHERE template_code = ${input.templateCode}
          AND version_number = ${input.versionNumber}
        LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      if (existing[0]) return null;

      const sectionsJson = JSON.stringify(input.sections);
      const row = (await tx.execute(sql`
        INSERT INTO inspection_templates (
          template_code, version_number, status_vocab, display_name,
          cadence, sections, requires_three_signatures, created_by_user_id
        )
        VALUES (
          ${input.templateCode}, ${input.versionNumber}, ${input.statusVocab},
          ${input.displayName}, ${input.cadence},
          ${sectionsJson}::jsonb,
          ${input.requiresThreeSignatures}, NULL
        )
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      const templateVersionId = row[0]!.id;

      const structureSha256 = sha256HexOfCanonical(input.sections);
      await append(tx, {
        actorId: SYSTEM_ACTOR_ID,
        payload: {
          kind: 'audit.inspection_template.seeded',
          templateCode: input.templateCode,
          templateVersionId,
          version: input.versionNumber,
          statusVocab: input.statusVocab,
          sectionCount: input.sections.length,
          structureSha256,
        },
        resourceType: 'inspection_templates',
        resourceId: templateVersionId,
      });
      return templateVersionId;
    });
    if (written) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}

function sha256HexOfCanonical(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function collectSeedInputs(): ReadonlyArray<SeedTemplateInput> {
  const zoneMonthly: SeedTemplateInput = {
    templateCode: 'zone_monthly',
    versionNumber: 1,
    displayName: 'Zone Monthly Inspection',
    statusVocab: 'ABC_X',
    cadence: 'monthly',
    requiresThreeSignatures: false,
    sections: ZONE_MONTHLY_SECTIONS,
  };

  const rackInspection: SeedTemplateInput = {
    templateCode: 'rack_inspection',
    versionNumber: 1,
    displayName: 'Rack Inspection',
    statusVocab: 'GAR',
    cadence: 'annual',
    requiresThreeSignatures: true,
    sections: RACK_INSPECTION_SECTIONS,
  };

  return [zoneMonthly, rackInspection];
}

async function main(): Promise<void> {
  const db = getDb() as unknown as DrizzlePg;
  const { inserted, skipped } = await seedInspectionTemplates(db);
  process.stdout.write(`seed-inspection-templates: inserted=${inserted} skipped=${skipped}\n`);
}

// Only run when invoked directly, not when imported by tests / routes.
if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `seed-inspection-templates failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
