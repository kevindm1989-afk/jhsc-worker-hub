// Rights-protective copy strings for the meeting-lifecycle UI
// (Milestone 2.1 S3, ADR-0012 §3.9 + SECURITY.md §2.13 T-ML20 / T-ML21
// / T-ML26 / T-ML27).
//
// These strings appear on the adjournment summary, finalization view,
// and signature rows. They are extracted to a single module so the
// snapshot test (apps/web/src/__tests__/meetings-rights-protective-
// copy.test.ts) can guard against future regressions — any edit that
// softens the worker-side framing toward employer-deference will
// trip the snapshot diff and require an explicit security-review
// sign-off (T-ML20 mitigation: "rights-protective copy regression").
//
// Non-negotiable #7 ("Rights-protective UI") is the load-bearing rule
// these strings honour. Specifically:
//
//   - Action items raised in a meeting are LIVE the moment the rep
//     adjourns. They do NOT wait on the four counter-signatures
//     (T-ML26 mitigation).
//   - Missing management signatures are described factually (not as
//     a "refusal" or "delay") so the rep is never coached into
//     adopting employer framing (T-ML27 mitigation).
//   - The 30-day stale-signature hint surfaces the s.50 reprisal
//     PATHWAY without prescribing action (the rep decides).
//   - Finalization is the formal sign-off; it does NOT gate the
//     operational work of the rep (T-ML20 mitigation).

export const MEETING_RIGHTS_COPY = {
  adjournmentBanner:
    'Meeting adjourned. The action items raised, closed, and moved during this meeting are now live in the operational record. Minutes finalization (the four counter-signatures) is the formal sign-off that produces the canonical PDF; the action items themselves do not wait on finalization.',

  finalizationHeader:
    'Action items from this meeting are LIVE — you can act on them now. The signatures below are the formal sign-off, not a gate on your operational work.',

  finalizationSubheading:
    'Record signatures to finalize minutes. The Worker Co-Chair signs in-app via passkey step-up; the other signers sign off-app (paper or email) and you record the evidence here.',

  inAppSignatureCta: 'Sign with passkey',

  paperAttestationCta: 'Record paper attestation',
  emailAttestationCta: 'Record email attestation',

  paperAttestationDescription:
    'Record what you received: a scanned paper signature, an email reply, or a signed PDF. Attach the file as evidence and add a chain-of-custody note describing how it was obtained.',

  pendingSignatureLabel: 'Pending',

  /** Returned by getStaleManagementSignatureHint() when the
   * management-side signatures have been pending for 30 days or
   * more. Surfaces the s.50 / s.147 reprisal pathway WITHOUT
   * prescribing action.
   *
   * NOTE (M2.1 S5 F-P2): the verbatim string is preserved as the
   * snapshot-guard contract. The view renders this hint via
   * `StaleManagementSignatureHint` (see meeting-finalization-view)
   * which splits the prose around the statute references so each
   * cite is a tap-and-hold-able <CitationRef />. The lint guards in
   * `meetings-rights-protective-copy.test.ts` continue to operate on
   * this canonical string. */
  staleManagementSignatureHint:
    'Management signatures pending. If you believe management is delaying sign-off in response to a refusal, complaint, or recommendation you raised, consider whether s.50 (OHSA) or s.147 (CLC Part II) reprisal protections apply. The decision is yours; this is informational only.',

  finalizeCta: 'Finalize meeting',

  finalizeWaitingHint:
    'The finalize button activates once all four signatures are recorded. Until then, the action items keep running on their own clock.',

  inProgressBanner:
    'Meeting in progress. Tap a section to expand it; section notes and attendance are saved as you work.',

  scheduledBanner: 'Meeting scheduled. Start the meeting when the co-chair calls it to order.',
} as const;

/**
 * Decide whether to surface the s.50 / s.147 reprisal-pathway hint
 * on the finalization view. Returns true when the meeting was
 * adjourned 30 or more days ago AND at least one management-side
 * signature is still missing.
 */
export function shouldSurfaceStaleManagementHint(args: {
  readonly adjournedAt: string | null;
  readonly now?: Date;
  readonly missingRoles: ReadonlyArray<string>;
}): boolean {
  if (!args.adjournedAt) return false;
  if (args.missingRoles.length === 0) return false;
  const adjourned = new Date(args.adjournedAt);
  if (Number.isNaN(adjourned.getTime())) return false;
  const now = args.now ?? new Date();
  const ageMs = now.getTime() - adjourned.getTime();
  const days = ageMs / (1000 * 60 * 60 * 24);
  if (days < 30) return false;
  // Only management-side roles count toward the "stale management
  // signatures" framing. The worker_co_chair is the rep themselves;
  // a missing worker_co_chair is operationally separate.
  const mgmtRoles = new Set(['mgmt_co_chair', 'mgmt_external_1', 'mgmt_external_2']);
  return args.missingRoles.some((r) => mgmtRoles.has(r));
}
