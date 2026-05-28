import { describe, expect, it } from 'vitest';
import { actionItemSection, type ActionItemSection } from './index';
import {
  ACTION_ITEM_ALLOWED_TRANSITIONS,
  ACTION_ITEM_STEP_UP_TRANSITIONS,
  actionItemTransitionRequiresStepUp,
  isAllowedActionItemTransition,
} from './action-item-transitions';

const ALL_PAIRS: Array<{ from: ActionItemSection; to: ActionItemSection; allowed: boolean }> = [];
for (const from of actionItemSection) {
  for (const to of actionItemSection) {
    if (from === to) continue;
    ALL_PAIRS.push({ from, to, allowed: ACTION_ITEM_ALLOWED_TRANSITIONS[from].includes(to) });
  }
}

describe('action-item section transition graph', () => {
  it('every section appears in the allow-table (exhaustive)', () => {
    for (const s of actionItemSection) {
      expect(Object.prototype.hasOwnProperty.call(ACTION_ITEM_ALLOWED_TRANSITIONS, s)).toBe(true);
    }
  });

  it('isAllowedActionItemTransition matches the static table', () => {
    for (const { from, to, allowed } of ALL_PAIRS) {
      expect(isAllowedActionItemTransition(from, to)).toBe(allowed);
    }
  });

  it('new_business -> old_business is allowed (the standard ageing path)', () => {
    expect(isAllowedActionItemTransition('new_business', 'old_business')).toBe(true);
  });

  it('new_business -> recommendation is allowed (formal escalation)', () => {
    expect(isAllowedActionItemTransition('new_business', 'recommendation')).toBe(true);
  });

  it('new_business -> archived is allowed (operator cleanup)', () => {
    expect(isAllowedActionItemTransition('new_business', 'archived')).toBe(true);
  });

  it('there is no edge back to new_business (write-once entry point)', () => {
    for (const from of actionItemSection) {
      if (from === 'new_business') continue;
      expect(isAllowedActionItemTransition(from, 'new_business')).toBe(false);
    }
  });

  it('archived -> old_business is allowed (revive)', () => {
    expect(isAllowedActionItemTransition('archived', 'old_business')).toBe(true);
  });

  it('archived -> completed_this_period is NOT allowed', () => {
    expect(isAllowedActionItemTransition('archived', 'completed_this_period')).toBe(false);
  });

  it('completed_this_period -> old_business is allowed (premature-close undo)', () => {
    expect(isAllowedActionItemTransition('completed_this_period', 'old_business')).toBe(true);
  });

  it('recommendation -> old_business is NOT allowed (one-way escalation)', () => {
    expect(isAllowedActionItemTransition('recommendation', 'old_business')).toBe(false);
  });

  it('graph is connected — every section is reachable from new_business', () => {
    const reachable = new Set<ActionItemSection>(['new_business']);
    for (let i = 0; i < 5; i++) {
      for (const { from, to, allowed } of ALL_PAIRS) {
        if (allowed && reachable.has(from)) reachable.add(to);
      }
    }
    for (const s of actionItemSection) {
      expect(reachable.has(s)).toBe(true);
    }
  });
});

describe('actionItemTransitionRequiresStepUp', () => {
  it('every move TO archived requires step-up (destructive cleanup)', () => {
    expect(actionItemTransitionRequiresStepUp('new_business', 'archived')).toBe(true);
    expect(actionItemTransitionRequiresStepUp('old_business', 'archived')).toBe(true);
    expect(actionItemTransitionRequiresStepUp('recommendation', 'archived')).toBe(true);
    expect(actionItemTransitionRequiresStepUp('completed_this_period', 'archived')).toBe(true);
  });

  it('archived -> old_business requires step-up (revive)', () => {
    expect(actionItemTransitionRequiresStepUp('archived', 'old_business')).toBe(true);
  });

  it('completed_this_period -> old_business requires step-up (premature-close undo)', () => {
    expect(actionItemTransitionRequiresStepUp('completed_this_period', 'old_business')).toBe(true);
  });

  it('normal forward moves do NOT require step-up', () => {
    expect(actionItemTransitionRequiresStepUp('new_business', 'old_business')).toBe(false);
    expect(actionItemTransitionRequiresStepUp('new_business', 'recommendation')).toBe(false);
    expect(actionItemTransitionRequiresStepUp('old_business', 'completed_this_period')).toBe(false);
    expect(actionItemTransitionRequiresStepUp('recommendation', 'completed_this_period')).toBe(
      false,
    );
  });

  it('STEP_UP_TRANSITIONS is a subset of ALLOWED_TRANSITIONS', () => {
    for (const [from, to] of ACTION_ITEM_STEP_UP_TRANSITIONS) {
      expect(isAllowedActionItemTransition(from, to)).toBe(true);
    }
  });
});
