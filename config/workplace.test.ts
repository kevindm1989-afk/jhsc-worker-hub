import { describe, it, expect } from 'vitest';
import { assertSignerRolesConfigured, loadWorkplaceConfig, resolveZoneLabel } from './workplace';

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

  describe('minutesSignerRoles (2.1, ADR-0012)', () => {
    it('produces the four generic role ids in fixed order', () => {
      const cfg = loadWorkplaceConfig({});
      expect(cfg.minutesSignerRoles.map((r) => r.id)).toEqual([
        'worker_co_chair',
        'mgmt_co_chair',
        'mgmt_external_1',
        'mgmt_external_2',
      ]);
      expect(cfg.minutesSignerRoles.map((r) => r.order)).toEqual([0, 1, 2, 3]);
    });

    it('reads display labels from env vars per non-negotiable #1', () => {
      const cfg = loadWorkplaceConfig({
        MINUTES_SIGNER_WORKER_CO_CHAIR_LABEL: 'Worker Rep',
        MINUTES_SIGNER_MGMT_CO_CHAIR_LABEL: 'Management Rep',
        MINUTES_SIGNER_MGMT_EXTERNAL_1_LABEL: 'Plant Manager',
        MINUTES_SIGNER_MGMT_EXTERNAL_2_LABEL: 'Site Director',
      });
      expect(cfg.minutesSignerRoles.map((r) => r.displayLabel)).toEqual([
        'Worker Rep',
        'Management Rep',
        'Plant Manager',
        'Site Director',
      ]);
    });

    it('returns empty displayLabel when env vars are missing (non-API boot path)', () => {
      const cfg = loadWorkplaceConfig({});
      for (const role of cfg.minutesSignerRoles) {
        expect(role.displayLabel).toBe('');
      }
    });

    it('assertSignerRolesConfigured throws when env vars are missing', () => {
      expect(() => assertSignerRolesConfigured({})).toThrow(/MINUTES_SIGNER_WORKER_CO_CHAIR_LABEL/);
    });

    it('assertSignerRolesConfigured succeeds when all env vars are set', () => {
      expect(() =>
        assertSignerRolesConfigured({
          MINUTES_SIGNER_WORKER_CO_CHAIR_LABEL: 'WCC',
          MINUTES_SIGNER_MGMT_CO_CHAIR_LABEL: 'MCC',
          MINUTES_SIGNER_MGMT_EXTERNAL_1_LABEL: 'ME1',
          MINUTES_SIGNER_MGMT_EXTERNAL_2_LABEL: 'ME2',
        }),
      ).not.toThrow();
    });
  });

  describe('documentPageSize (2.3, ADR-0014 §3.2.4)', () => {
    it('defaults to letter (Ontario default per ADR + S0 Q1)', () => {
      expect(loadWorkplaceConfig({}).documentPageSize).toBe('letter');
    });

    it('honors a4 override (CA-FED-primary workplaces)', () => {
      expect(loadWorkplaceConfig({ WORKPLACE_DOCUMENT_PAGE_SIZE: 'a4' }).documentPageSize).toBe(
        'a4',
      );
      // Case-insensitive (a rep typing 'A4' should not silently fall back)
      expect(loadWorkplaceConfig({ WORKPLACE_DOCUMENT_PAGE_SIZE: 'A4' }).documentPageSize).toBe(
        'a4',
      );
    });

    it('falls back to letter on a misconfigured value (fail-soft, no throw)', () => {
      expect(loadWorkplaceConfig({ WORKPLACE_DOCUMENT_PAGE_SIZE: 'legal' }).documentPageSize).toBe(
        'letter',
      );
      expect(loadWorkplaceConfig({ WORKPLACE_DOCUMENT_PAGE_SIZE: '' }).documentPageSize).toBe(
        'letter',
      );
    });
  });

  describe('minutesRecipientWorkplaceRoleNLabel (2.3, ADR-0014 §3.3 — S0 Q4)', () => {
    it('returns null when env vars are unset (slot hidden in UI)', () => {
      const cfg = loadWorkplaceConfig({});
      expect(cfg.minutesRecipientWorkplaceRole1Label).toBeNull();
      expect(cfg.minutesRecipientWorkplaceRole2Label).toBeNull();
    });

    it('returns null for an empty / whitespace-only env var', () => {
      const cfg = loadWorkplaceConfig({
        MINUTES_RECIPIENT_ROLE_WORKPLACE_1_LABEL: '   ',
        MINUTES_RECIPIENT_ROLE_WORKPLACE_2_LABEL: '',
      });
      expect(cfg.minutesRecipientWorkplaceRole1Label).toBeNull();
      expect(cfg.minutesRecipientWorkplaceRole2Label).toBeNull();
    });

    it('reads the labels from env vars per non-negotiable #1 (env-driven only)', () => {
      const cfg = loadWorkplaceConfig({
        MINUTES_RECIPIENT_ROLE_WORKPLACE_1_LABEL: 'Plant Manager',
        MINUTES_RECIPIENT_ROLE_WORKPLACE_2_LABEL: 'Warehouse Manager',
      });
      expect(cfg.minutesRecipientWorkplaceRole1Label).toBe('Plant Manager');
      expect(cfg.minutesRecipientWorkplaceRole2Label).toBe('Warehouse Manager');
    });

    it('allows only one of the two slots to be configured (independent)', () => {
      const cfg = loadWorkplaceConfig({
        MINUTES_RECIPIENT_ROLE_WORKPLACE_1_LABEL: 'Site Director',
      });
      expect(cfg.minutesRecipientWorkplaceRole1Label).toBe('Site Director');
      expect(cfg.minutesRecipientWorkplaceRole2Label).toBeNull();
    });
  });
});
