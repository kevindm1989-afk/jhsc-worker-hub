// Minutes Document regeneration-reason enum + Zod schema
// (2.3, ADR-0014 §3.5).
//
// A rep regenerating a finalized meeting's PDF tags the reason for
// the audit chain. Triggers per ADR §3.5:
//   - layout_fix       — re-render to fix a visual issue (no data change)
//   - corpus_update    — retention citation refreshed via corpus re-seed
//   - signature_added  — additional signature obtained off-app post-finalize
//   - typo_fix         — correction to a decrypted display name / spelling
//   - other            — free-form escape hatch (PI-clean: enum only)
//
// The reason is NOT envelope-encrypted (the enum value is PI-clean by
// construction); the chain payload carries the enum value directly.

import { z } from 'zod';

export const minutesDocumentRegenerationReason = [
  'layout_fix',
  'corpus_update',
  'signature_added',
  'typo_fix',
  'other',
] as const;
export type MinutesDocumentRegenerationReason = (typeof minutesDocumentRegenerationReason)[number];
export const minutesDocumentRegenerationReasonSchema = z.enum(minutesDocumentRegenerationReason);
