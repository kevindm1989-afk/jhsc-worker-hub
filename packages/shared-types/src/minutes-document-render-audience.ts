// Minutes Document render-audience enum + Zod schema
// (2.3, ADR-0014 TM-fold-2 — T-MD7..T-MD10).
//
// The rep picks audience at generation time:
//   - 'jhsc_internal'         — full closure reasons + signer narratives
//   - 'external_distribution' — redacted to hashes + role IDs
//
// The chain payload carries the audience so a verifier can confirm the
// rendered bytes match the declared audience.

import { z } from 'zod';

export const minutesDocumentRenderAudience = ['jhsc_internal', 'external_distribution'] as const;
export type MinutesDocumentRenderAudience = (typeof minutesDocumentRenderAudience)[number];
export const minutesDocumentRenderAudienceSchema = z.enum(minutesDocumentRenderAudience);
