// Minutes Distribution recipient-role enum + Zod schema
// (2.3, ADR-0014 §3.3 — S0 Q4 split source-vs-env rule).
//
// 9 visible options total per the user decision, split per non-
// negotiable #1:
//
//   7 GENERIC ids hardcoded in source (workplace-agnostic):
//     - mgmt_co_chair      Management co-chair (universal JHSC role)
//     - worker_rep         Worker rep (universal JHSC role)
//     - mgmt_rep           Management rep (universal JHSC role)
//     - union_local        Union local (universal labour structure)
//     - mlitsd_inspector   MLITSD inspector (ON statutory)
//     - legal_counsel      Legal counsel (universal)
//     - other              Free-form escape hatch
//
//   2 WORKPLACE-SPECIFIC slots (display labels env-driven):
//     - workplace_role_1   Label from MINUTES_RECIPIENT_ROLE_WORKPLACE_1_LABEL
//     - workplace_role_2   Label from MINUTES_RECIPIENT_ROLE_WORKPLACE_2_LABEL
//
// The 2 workplace slots are NULLABLE in config/workplace.ts — a
// workplace without workplace-specific recipients hides the slots
// in the UI. The source carries zero workplace-specific job titles
// (mirrors the M2.1 minutesSignerRoles env-driven pattern).

import { z } from 'zod';

export const minutesDocumentRecipientRole = [
  // Generic ids (universal JHSC / labour-relations structure):
  'mgmt_co_chair',
  'worker_rep',
  'mgmt_rep',
  'union_local',
  'mlitsd_inspector',
  'legal_counsel',
  'other',
  // Workplace-specific slots (display label from env, NOT source):
  'workplace_role_1',
  'workplace_role_2',
] as const;
export type MinutesDocumentRecipientRole = (typeof minutesDocumentRecipientRole)[number];
export const minutesDocumentRecipientRoleSchema = z.enum(minutesDocumentRecipientRole);

/**
 * Pure helper: returns true for the 2 workplace-specific slots whose
 * display labels must come from env vars. The UI hides slots whose
 * env-driven label is null/empty.
 */
export function isWorkplaceRecipientRole(role: MinutesDocumentRecipientRole): boolean {
  return role === 'workplace_role_1' || role === 'workplace_role_2';
}
