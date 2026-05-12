// Workplace identity — env-driven (non-negotiable #1, #14).
//
// NEVER hardcode a workplace name, union local, person, or facility-specific
// string in source. Values are read from `process.env` at runtime. Defaults
// are deliberately generic so a misconfigured deployment produces "Zone 1"
// rather than leaking an old workplace name.

export interface WorkplaceConfig {
  /** Display name shown in app chrome and document headers. Empty in dev. */
  readonly displayName: string;
  /** Jurisdiction governs which statutes apply. */
  readonly jurisdiction: Jurisdiction;
  /** Ordered zone list. IDs are stable (non-negotiable #14). */
  readonly zones: readonly Zone[];
}

export type Jurisdiction = 'ON' | 'CA-FED';

export interface Zone {
  /** Stable identifier — NEVER renamed. Historical inspections rely on this. */
  readonly id: ZoneId;
  /** Fallback used when displayName is empty. */
  readonly defaultName: string;
  /** Configurable per workplace via env var. May be empty. */
  readonly displayName: string;
}

export type ZoneId =
  | 'zone_1'
  | 'zone_2'
  | 'zone_3'
  | 'zone_4'
  | 'zone_5'
  | 'zone_6'
  | 'zone_7'
  | 'zone_8'
  | 'zone_9'
  | 'zone_10';

const ZONE_IDS: readonly ZoneId[] = [
  'zone_1',
  'zone_2',
  'zone_3',
  'zone_4',
  'zone_5',
  'zone_6',
  'zone_7',
  'zone_8',
  'zone_9',
  'zone_10',
];

function parseJurisdiction(raw: string | undefined): Jurisdiction {
  if (raw === 'CA-FED') return 'CA-FED';
  return 'ON';
}

function readZones(env: NodeJS.ProcessEnv): readonly Zone[] {
  return ZONE_IDS.map((id, idx) => {
    const envKey = `ZONE_${idx + 1}_NAME` as const;
    const fromEnv = env[envKey]?.trim() ?? '';
    return {
      id,
      defaultName: `Zone ${idx + 1}`,
      displayName: fromEnv,
    };
  });
}

export function loadWorkplaceConfig(env: NodeJS.ProcessEnv = process.env): WorkplaceConfig {
  return {
    displayName: env.WORKPLACE_DISPLAY_NAME?.trim() ?? '',
    jurisdiction: parseJurisdiction(env.WORKPLACE_JURISDICTION),
    zones: readZones(env),
  };
}

/** Resolves the visible label for a zone, falling back to the default. */
export function resolveZoneLabel(zone: Zone): string {
  return zone.displayName.length > 0 ? zone.displayName : zone.defaultName;
}

/** Eagerly loaded config for server processes. Re-call `loadWorkplaceConfig()` in tests. */
export const WORKPLACE: WorkplaceConfig = loadWorkplaceConfig();
