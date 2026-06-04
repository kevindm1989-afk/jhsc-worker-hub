// Minutes Distribution sent-method enum + Zod schema
// (2.3, ADR-0014 §3.3.2).
//
// 4 out-of-band delivery methods the rep records when noting a
// distribution event. The app does NOT send the PDF (non-negotiable
// #6 — no employer infrastructure dependencies); the rep distributes
// out-of-band and records WHAT method was used so the chain anchors
// the evidentiary trail.

import { z } from 'zod';

export const minutesDocumentSentMethod = [
  'email',
  'printed_handoff',
  'portal_upload',
  'in_person',
] as const;
export type MinutesDocumentSentMethod = (typeof minutesDocumentSentMethod)[number];
export const minutesDocumentSentMethodSchema = z.enum(minutesDocumentSentMethod);
