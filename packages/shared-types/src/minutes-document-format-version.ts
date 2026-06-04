// Minutes Document format-version enum + Zod schema (2.3, ADR-0014 §3.12).
//
// `format_version` is pinned per minutes_documents row. M2.3 ships v1
// only; a future v2 (layout overhaul / additional retention clause)
// lives in a separate render pipeline and the route's body accepts
// an optional `formatVersion: 'v1' | 'v2'` parameter that defaults to
// 'v1' for backward compatibility (parallel to non-negotiable #13:
// inspections preserve template version at conduct time).

import { z } from 'zod';

export const minutesDocumentFormatVersion = ['v1'] as const;
export type MinutesDocumentFormatVersion = (typeof minutesDocumentFormatVersion)[number];
export const minutesDocumentFormatVersionSchema = z.enum(minutesDocumentFormatVersion);
