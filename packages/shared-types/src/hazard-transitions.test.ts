import { describe, expect, it } from 'vitest';
import { hazardStatus, type HazardStatus } from './index';
import {
  ALLOWED_TRANSITIONS,
  STEP_UP_TRANSITIONS,
  isAllowedTransition,
  isTerminal,
  requiresStepUp,
} from './hazard-transitions';

// Materialize every (from, to) pair against the allow list so a future
// reader sees the full truth table.
const ALL_PAIRS: Array<{ from: HazardStatus; to: HazardStatus; allowed: boolean }> = [];
for (const from of hazardStatus) {
  for (const to of hazardStatus) {
    if (from === to) continue; // self-transition is meaningless
    ALL_PAIRS.push({
      from,
      to,
      allowed: ALLOWED_TRANSITIONS[from].includes(to),
    });
  }
}

describe('hazard status transition graph', () => {
  it('every status appears in the table (exhaustive)', () => {
    for (const s of hazardStatus) {
      expect(Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, s)).toBe(true);
    }
  });

  it('isAllowedTransition matches the static table', () => {
    for (const { from, to, allowed } of ALL_PAIRS) {
      expect(isAllowedTransition(from, to)).toBe(allowed);
    }
  });

  it('open -> assessing is allowed', () => {
    expect(isAllowedTransition('open', 'assessing')).toBe(true);
  });

  it('open -> archived is NOT allowed (T-H2: cannot skip workflow)', () => {
    expect(isAllowedTransition('open', 'archived')).toBe(false);
  });

  it('open -> resolved is NOT allowed (T-H2: cannot skip assessment)', () => {
    expect(isAllowedTransition('open', 'resolved')).toBe(false);
  });

  it('open -> assigned is NOT allowed (must assess first)', () => {
    expect(isAllowedTransition('open', 'assigned')).toBe(false);
  });

  it('open -> withdrawn is allowed (escape valve)', () => {
    expect(isAllowedTransition('open', 'withdrawn')).toBe(true);
  });

  it('resolved -> assessing is allowed (re-open path)', () => {
    expect(isAllowedTransition('resolved', 'assessing')).toBe(true);
  });

  it('archived -> assessing is allowed (re-open path)', () => {
    expect(isAllowedTransition('archived', 'assessing')).toBe(true);
  });

  it('archived -> resolved is NOT allowed (must re-assess)', () => {
    expect(isAllowedTransition('archived', 'resolved')).toBe(false);
  });

  it('archived -> withdrawn is NOT allowed (already terminal-ish)', () => {
    expect(isAllowedTransition('archived', 'withdrawn')).toBe(false);
  });

  it('withdrawn is terminal — no outgoing edges', () => {
    expect(isTerminal('withdrawn')).toBe(true);
    expect(ALLOWED_TRANSITIONS.withdrawn).toEqual([]);
  });

  it('no other status is terminal', () => {
    for (const s of hazardStatus) {
      if (s === 'withdrawn') continue;
      expect(isTerminal(s)).toBe(false);
    }
  });

  it('graph is connected — every reachable status appears as a target somewhere', () => {
    const reachable = new Set<HazardStatus>(['open']);
    for (const { from, to, allowed } of ALL_PAIRS) {
      if (allowed && reachable.has(from)) reachable.add(to);
    }
    // Iterate a few more passes since BFS-by-iteration isn't transitive in one go.
    for (let i = 0; i < 5; i++) {
      for (const { from, to, allowed } of ALL_PAIRS) {
        if (allowed && reachable.has(from)) reachable.add(to);
      }
    }
    for (const s of hazardStatus) {
      expect(reachable.has(s)).toBe(true);
    }
  });
});

describe('requiresStepUp', () => {
  it('→withdrawn from every non-terminal status requires step-up', () => {
    expect(requiresStepUp('open', 'withdrawn')).toBe(true);
    expect(requiresStepUp('assessing', 'withdrawn')).toBe(true);
    expect(requiresStepUp('assigned', 'withdrawn')).toBe(true);
  });

  it('resolved→assessing requires step-up (re-open)', () => {
    expect(requiresStepUp('resolved', 'assessing')).toBe(true);
  });

  it('archived→assessing requires step-up (re-open)', () => {
    expect(requiresStepUp('archived', 'assessing')).toBe(true);
  });

  it('normal forward transitions do NOT require step-up', () => {
    expect(requiresStepUp('open', 'assessing')).toBe(false);
    expect(requiresStepUp('assessing', 'assigned')).toBe(false);
    expect(requiresStepUp('assigned', 'resolved')).toBe(false);
    expect(requiresStepUp('resolved', 'archived')).toBe(false);
  });

  it('STEP_UP_TRANSITIONS is a subset of ALLOWED_TRANSITIONS', () => {
    for (const [from, to] of STEP_UP_TRANSITIONS) {
      expect(isAllowedTransition(from, to)).toBe(true);
    }
  });
});
