// Minutes Document hold-state enum + Zod schema
// (2.3, ADR-0014 TM-fold-6 — T-MD27).
//
// A document under hold cannot be deleted at the 2-year retention
// boundary. The future GC sweep consults this column; the route
// surface (POST /api/minutes-documents/:id/hold + /hold-release)
// transitions between 'none' and the three hold variants. Hold reason
// is envelope-encrypted on the row (never plaintext in chain payload).

import { z } from 'zod';

export const minutesDocumentHoldState = [
  'none',
  'subpoena_hold',
  'mlitsd_hold',
  'litigation_hold',
] as const;
export type MinutesDocumentHoldState = (typeof minutesDocumentHoldState)[number];
export const minutesDocumentHoldStateSchema = z.enum(minutesDocumentHoldState);
