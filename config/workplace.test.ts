import { describe, it, expect } from 'vitest';
import { loadWorkplaceConfig, resolveZoneLabel } from './workplace';

describe('loadWorkplaceConfig', () => {
  it('produces 10 stable zone IDs regardless of env', () => {
    const cfg = loadWorkplaceConfig({});
    expect(cfg.zones).toHaveLength(10);
    expect(cfg.zones.map((z) => z.id)).toEqual([
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
    ]);
  });

  it('defaults jurisdiction to ON when unset or invalid', () => {
    expect(loadWorkplaceConfig({}).jurisdiction).toBe('ON');
    expect(loadWorkplaceConfig({ WORKPLACE_JURISDICTION: 'bogus' }).jurisdiction).toBe('ON');
    expect(loadWorkplaceConfig({ WORKPLACE_JURISDICTION: 'CA-FED' }).jurisdiction).toBe('CA-FED');
  });

  it('returns empty workplace display name when not configured (no fallback to hardcoded name)', () => {
    expect(loadWorkplaceConfig({}).displayName).toBe('');
  });

  it('respects zone display name overrides', () => {
    const cfg = loadWorkplaceConfig({ ZONE_3_NAME: 'Cold Warehouse' });
    const zone3 = cfg.zones[2];
    expect(zone3?.id).toBe('zone_3');
    expect(zone3?.displayName).toBe('Cold Warehouse');
    expect(zone3 ? resolveZoneLabel(zone3) : null).toBe('Cold Warehouse');
  });

  it('falls back to generic "Zone N" when displayName is empty', () => {
    const cfg = loadWorkplaceConfig({});
    const zone1 = cfg.zones[0];
    expect(zone1).toBeDefined();
    expect(zone1 ? resolveZoneLabel(zone1) : null).toBe('Zone 1');
  });
});
