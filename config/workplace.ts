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
  /**
   * Ordered minutes-signer roles (Milestone 2.1, ADR-0012 §3.9). The
   * structural role IDs are GENERIC per non-negotiable #1 (e.g.
   * `mgmt_external_1` — never `warehouse_mgr` or a workplace-specific
   * label). The per-workplace DISPLAY LABELS for those generic roles
   * come from env vars at runtime: `MINUTES_SIGNER_ROLE_1_LABEL`,
   * `MINUTES_SIGNER_ROLE_2_LABEL`, etc. A workplace whose external
   * signers are "Warehouse Manager" and "Plant Manager" sets those
   * two env vars; the source code carries no names.
   */
  readonly minutesSignerRoles: readonly SignerRoleDef[];
}

export type Jurisdiction = 'ON' | 'CA-FED';

/**
 * Generic, workplace-agnostic minutes-signer role identifier (#1).
 *
 * The first two roles are the JHSC co-chairs (the worker co-chair is
 * the in-app actor; the management co-chair signs off-app). The two
 * `mgmt_external_*` roles are slots for additional management-side
 * signers whose display label is workplace-configurable (e.g.
 * "Warehouse Manager", "Plant Manager", "Site Director" — but those
 * labels live in env vars, never in source).
 */
export type SignerRoleId =
  | 'worker_co_chair'
  | 'mgmt_co_chair'
  | 'mgmt_external_1'
  | 'mgmt_external_2';

export interface SignerRoleDef {
  /** Stable id — never workplace-specific. */
  readonly id: SignerRoleId;
  /** Per-workplace display label (env-driven). Empty when no env var set. */
  readonly displayLabel: string;
  /** Ordering for the finalization-surface render. */
  readonly order: number;
}

/**
 * Canonical ordering of signer roles. The id sequence is fixed; the
 * display labels are read per-id from env vars.
 */
const SIGNER_ROLE_IDS: readonly SignerRoleId[] = [
  'worker_co_chair',
  'mgmt_co_chair',
  'mgmt_external_1',
  'mgmt_external_2',
];

/** Env var name producing the display label for a signer role. */
function signerLabelEnvKey(id: SignerRoleId): string {
  switch (id) {
    case 'worker_co_chair':
      return 'MINUTES_SIGNER_WORKER_CO_CHAIR_LABEL';
    case 'mgmt_co_chair':
      return 'MINUTES_SIGNER_MGMT_CO_CHAIR_LABEL';
    case 'mgmt_external_1':
      return 'MINUTES_SIGNER_MGMT_EXTERNAL_1_LABEL';
    case 'mgmt_external_2':
      return 'MINUTES_SIGNER_MGMT_EXTERNAL_2_LABEL';
  }
}

/**
 * Read signer-role display labels from env. Per non-negotiable #1 the
 * SOURCE carries no hardcoded labels — every label MUST come from env.
 *
 * Behavior:
 *   - If `allowEmpty` is true (dev / test / non-API processes), empty
 *     labels are returned as empty strings; the caller decides how to
 *     surface that.
 *   - If `allowEmpty` is false (the API boot path via
 *     `assertSignerRolesConfigured`), any missing env var is a
 *     fail-closed error — the API refuses to boot with unlabeled
 *     signers.
 */
function readSignerRoles(
  env: NodeJS.ProcessEnv,
  options: { readonly allowEmpty: boolean } = { allowEmpty: true },
): readonly SignerRoleDef[] {
  const roles = SIGNER_ROLE_IDS.map((id, idx) => {
    const fromEnv = env[signerLabelEnvKey(id)]?.trim() ?? '';
    return {
      id,
      displayLabel: fromEnv,
      order: idx,
    } satisfies SignerRoleDef;
  });
  if (!options.allowEmpty) {
    const missing = roles.filter((r) => r.displayLabel.length === 0);
    if (missing.length > 0) {
      const envKeys = missing.map((r) => signerLabelEnvKey(r.id)).join(', ');
      throw new Error(
        `Workplace config: minutes-signer label env vars missing: ${envKeys}. ` +
          'Set each label to the workplace-specific role title for that signer; ' +
          'the source carries no hardcoded labels per non-negotiable #1.',
      );
    }
  }
  return roles;
}

/**
 * Fail-closed validator for the API boot path. Call this from the API
 * `index.ts` so a misconfigured deployment refuses to start rather
 * than silently rendering empty signer-role labels in the UI.
 */
export function assertSignerRolesConfigured(env: NodeJS.ProcessEnv = process.env): void {
  readSignerRoles(env, { allowEmpty: false });
}

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
    minutesSignerRoles: readSignerRoles(env),
  };
}

/** Resolves the visible label for a signer role. Never empty thanks to
 * the default-label fallback. */
export function resolveSignerLabel(role: SignerRoleDef): string {
  return role.displayLabel;
}

/** Resolves the visible label for a zone, falling back to the default. */
export function resolveZoneLabel(zone: Zone): string {
  return zone.displayName.length > 0 ? zone.displayName : zone.defaultName;
}

/** Eagerly loaded config for server processes. Re-call `loadWorkplaceConfig()` in tests. */
export const WORKPLACE: WorkplaceConfig = loadWorkplaceConfig();
