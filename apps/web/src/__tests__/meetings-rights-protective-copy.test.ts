// Snapshot guard for the rights-protective copy strings used across the
// meeting-lifecycle UI (Milestone 2.1 S3, ADR-0012 §3.9, T-ML20 / T-ML26
// / T-ML27 mitigations).
//
// This test exists to discourage drift. Any edit to the strings below
// must update the snapshot deliberately, with a comment in the PR
// referencing the rights-protective rationale. The reviewer is
// expected to verify the new wording remains:
//
//   - non-shaming on missing management signatures (T-ML27);
//   - decoupling of action-item operational work from finalization
//     (T-ML20 / T-ML26);
//   - informational (not prescriptive) on the s.50 / s.147 reprisal
//     pathway hint.
//
// The file under test is `apps/web/src/meetings/rights-protective-copy.ts`.

import { describe, expect, it } from 'vitest';
import {
  MEETING_RIGHTS_COPY,
  shouldSurfaceStaleManagementHint,
} from '@/meetings/rights-protective-copy';

describe('MEETING_RIGHTS_COPY — rights-protective string snapshot (T-ML20 guard)', () => {
  it('matches the canonical snapshot — edits require an explicit security-review sign-off', () => {
    expect(MEETING_RIGHTS_COPY).toMatchInlineSnapshot(`
      {
        "adjournmentBanner": "Meeting adjourned. The action items raised, closed, and moved during this meeting are now live in the operational record. Minutes finalization (the four counter-signatures) is the formal sign-off that produces the canonical PDF; the action items themselves do not wait on finalization.",
        "closureOfflineHint": "Closure verification requires a network connection. The action item will stay open until you are back online.",
        "closureReasonPlaceholder": "What was done to verify closure?",
        "closureSelfAttestationBanner": "You are both the closer and the counter-signer because no other in-app worker co-chair is available. This is recorded in the chain so a future reviewer can see the single-rep constraint.",
        "closureSubmitCta": "Record closure verification",
        "closureSuccessHeading": "Closure verified",
        "closureVerificationBanner": "Closure verification is your evidence that this item was addressed. The chain anchor makes it tamper-evident for a future MLITSD review.",
        "emailAttestationCta": "Record email attestation",
        "finalizationHeader": "Action items from this meeting are LIVE — you can act on them now. The signatures below are the formal sign-off, not a gate on your operational work.",
        "finalizationSubheading": "Record signatures to finalize minutes. The Worker Co-Chair signs in-app via passkey step-up; the other signers sign off-app (paper or email) and you record the evidence here.",
        "finalizeCta": "Finalize meeting",
        "finalizeWaitingHint": "The finalize button activates once all four signatures are recorded. Until then, the action items keep running on their own clock.",
        "inAppSignatureCta": "Sign with passkey",
        "inProgressBanner": "Meeting in progress. Tap a section to expand it; section notes and attendance are saved as you work.",
        "liveMetricsLegend": "Live aggregates from this meeting. Counts only — no per-rep attribution.",
        "paperAttestationCta": "Record paper attestation",
        "paperAttestationDescription": "Record what you received: a scanned paper signature, an email reply, or a signed PDF. Attach the file as evidence and add a chain-of-custody note describing how it was obtained.",
        "pendingSignatureLabel": "Pending",
        "reopenDialogDescription": "Reopening is a normal operational move. The previous closure verification stays in the chain as historical evidence.",
        "reopenDialogTitle": "Reopen action item",
        "reopenSubmitCta": "Reopen",
        "reopenSuccessMessage": "Reopened. The previous closure verification is preserved in the chain.",
        "scheduledBanner": "Meeting scheduled. Start the meeting when the co-chair calls it to order.",
        "staleManagementSignatureHint": "Management signatures pending. If you believe management is delaying sign-off in response to a refusal, complaint, or recommendation you raised, consider whether s.50 (OHSA) or s.147 (CLC Part II) reprisal protections apply. The decision is yours; this is informational only.",
      }
    `);
  });

  it('uses the worker-side framing (LIVE / not a gate / informational) on the finalization view', () => {
    // Property-level guards in addition to the snapshot so the lint
    // surfaces specific rights-protective contracts.
    expect(MEETING_RIGHTS_COPY.finalizationHeader).toMatch(/LIVE/);
    expect(MEETING_RIGHTS_COPY.finalizationHeader).toMatch(/not a gate/i);
    expect(MEETING_RIGHTS_COPY.staleManagementSignatureHint).toMatch(/informational only/);
    expect(MEETING_RIGHTS_COPY.adjournmentBanner).toMatch(/do not wait on finalization/);
  });

  it('never contains shame-framing language', () => {
    const all = Object.values(MEETING_RIGHTS_COPY).join(' ').toLowerCase();
    expect(all).not.toMatch(/refused to sign/);
    expect(all).not.toMatch(/refuses to/);
    expect(all).not.toMatch(/wait for management/);
    expect(all).not.toMatch(/your changes will be lost/);
    // M2.2 T-IM26 / T-IM25 mitigations — closure surface must never
    // adopt adversarial or shame framing.
    expect(all).not.toMatch(/justify the closure/);
    expect(all).not.toMatch(/are you sure/);
    expect(all).not.toMatch(/approve closure/);
  });

  it('M2.2 closure surface uses evidence framing — not gatekeeping', () => {
    // T-IM25 — counter-sign is verification, never a gate on operational
    // work. The banner foregrounds the chain-anchor + evidentiary value.
    expect(MEETING_RIGHTS_COPY.closureVerificationBanner).toMatch(/evidence/i);
    expect(MEETING_RIGHTS_COPY.closureVerificationBanner).toMatch(/tamper-evident/i);
    expect(MEETING_RIGHTS_COPY.closureVerificationBanner).not.toMatch(/approve/i);
    expect(MEETING_RIGHTS_COPY.closureVerificationBanner).not.toMatch(/sign off/i);
    // T-IM26 — closure reason placeholder is descriptive, not adversarial.
    expect(MEETING_RIGHTS_COPY.closureReasonPlaceholder).toMatch(/what was done/i);
    expect(MEETING_RIGHTS_COPY.closureReasonPlaceholder).not.toMatch(/justify/i);
    // T-IM23 — offline hint surfaces the recovery affordance neutrally.
    expect(MEETING_RIGHTS_COPY.closureOfflineHint).toMatch(/network connection/i);
    expect(MEETING_RIGHTS_COPY.closureOfflineHint).not.toMatch(/lost/i);
    // S0 Q2 — selfAttestation banner records the constraint honestly,
    // no judgment.
    expect(MEETING_RIGHTS_COPY.closureSelfAttestationBanner).toMatch(/single-rep constraint/i);
    expect(MEETING_RIGHTS_COPY.closureSelfAttestationBanner).not.toMatch(/violation/i);
    // Reopen copy is operationally neutral, not destructive framing.
    expect(MEETING_RIGHTS_COPY.reopenDialogDescription).toMatch(/normal operational/i);
    expect(MEETING_RIGHTS_COPY.reopenDialogDescription).toMatch(/preserved|stays/i);
    // T-IM27 — metrics legend foregrounds aggregate-only posture.
    expect(MEETING_RIGHTS_COPY.liveMetricsLegend).toMatch(/aggregate|counts only/i);
    expect(MEETING_RIGHTS_COPY.liveMetricsLegend).toMatch(/no per-rep/i);
  });
});

describe('shouldSurfaceStaleManagementHint', () => {
  it('returns false when adjournedAt is null', () => {
    expect(
      shouldSurfaceStaleManagementHint({ adjournedAt: null, missingRoles: ['mgmt_co_chair'] }),
    ).toBe(false);
  });

  it('returns false when no roles are missing', () => {
    expect(
      shouldSurfaceStaleManagementHint({
        adjournedAt: '2026-01-01T00:00:00Z',
        missingRoles: [],
      }),
    ).toBe(false);
  });

  it('returns false when adjourned less than 30 days ago', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    expect(
      shouldSurfaceStaleManagementHint({
        adjournedAt: '2026-01-01T00:00:00Z',
        missingRoles: ['mgmt_co_chair'],
        now,
      }),
    ).toBe(false);
  });

  it('returns true when adjourned ≥30 days ago AND a management role is missing', () => {
    const now = new Date('2026-02-15T00:00:00Z');
    expect(
      shouldSurfaceStaleManagementHint({
        adjournedAt: '2026-01-01T00:00:00Z',
        missingRoles: ['mgmt_co_chair'],
        now,
      }),
    ).toBe(true);
  });

  it('returns false when only the worker_co_chair signature is missing (not "management" framing)', () => {
    const now = new Date('2026-02-15T00:00:00Z');
    expect(
      shouldSurfaceStaleManagementHint({
        adjournedAt: '2026-01-01T00:00:00Z',
        missingRoles: ['worker_co_chair'],
        now,
      }),
    ).toBe(false);
  });

  it('returns true for any of the three management-side roles', () => {
    const now = new Date('2026-02-15T00:00:00Z');
    for (const r of ['mgmt_co_chair', 'mgmt_external_1', 'mgmt_external_2'] as const) {
      expect(
        shouldSurfaceStaleManagementHint({
          adjournedAt: '2026-01-01T00:00:00Z',
          missingRoles: [r],
          now,
        }),
      ).toBe(true);
    }
  });

  it('returns false for a malformed timestamp', () => {
    expect(
      shouldSurfaceStaleManagementHint({
        adjournedAt: 'not-a-date',
        missingRoles: ['mgmt_co_chair'],
      }),
    ).toBe(false);
  });
});
