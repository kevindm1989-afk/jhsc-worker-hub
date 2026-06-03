// Meeting Lifecycle enums + Zod schemas (Milestone 2.1, ADR-0012).
//
// All enums are CLOSED (per ADR S0 user-decision on section taxonomy +
// the S1 brief's signer-role + visibility + snapshot-kind closures).
// The signer roles are GENERIC per non-negotiable #1 — the display
// labels for "Warehouse Manager" / "Plant Manager" come from
// config/workplace.ts at runtime; this module has zero workplace-
// specific identifiers.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Status — lifecycle of a meeting row
// ---------------------------------------------------------------------------

export const meetingStatus = [
  'scheduled',
  'in_progress',
  'adjourned',
  'pending_finalization',
  'finalized',
  'archived',
] as const;
export type MeetingStatus = (typeof meetingStatus)[number];
export const meetingStatusSchema = z.enum(meetingStatus);

// ---------------------------------------------------------------------------
// Section type — closed 12-value enum (per ADR §3.1 reconciliation +
// S0 user-decision: stable for all of Release 2; no custom sections.)
// ---------------------------------------------------------------------------

export const meetingSectionType = [
  'call_to_order',
  'roll_call_quorum',
  'minutes_review',
  'old_business',
  'new_business',
  'inspections_review',
  'incident_review',
  'complaints_review',
  'recommendations',
  'other_business',
  'next_meeting',
  'adjournment',
] as const;
export type MeetingSectionType = (typeof meetingSectionType)[number];
export const meetingSectionTypeSchema = z.enum(meetingSectionType);

// ---------------------------------------------------------------------------
// Visibility — TM-fold-2 forward seam (T-ML9 / T-ML11 / T-ML25)
// ---------------------------------------------------------------------------

export const meetingSectionVisibility = ['standard', 'co_chair_only'] as const;
export type MeetingSectionVisibility = (typeof meetingSectionVisibility)[number];
export const meetingSectionVisibilitySchema = z.enum(meetingSectionVisibility);

// ---------------------------------------------------------------------------
// Signer roles — GENERIC per non-negotiable #1. The display labels for
// "Warehouse Manager" / "Plant Manager" come from config/workplace.ts.
// ---------------------------------------------------------------------------

export const meetingSignerRole = [
  'worker_co_chair',
  'mgmt_co_chair',
  'mgmt_external_1',
  'mgmt_external_2',
] as const;
export type MeetingSignerRole = (typeof meetingSignerRole)[number];
export const meetingSignerRoleSchema = z.enum(meetingSignerRole);

// ---------------------------------------------------------------------------
// Signed method — how a signature was obtained
// ---------------------------------------------------------------------------

export const meetingSignedMethod = [
  'in_app_passkey',
  'paper_attestation',
  'email_attestation',
] as const;
export type MeetingSignedMethod = (typeof meetingSignedMethod)[number];
export const meetingSignedMethodSchema = z.enum(meetingSignedMethod);

// ---------------------------------------------------------------------------
// Attendance enums (role / party / present_status)
// ---------------------------------------------------------------------------

export const meetingAttendanceRole = [
  'worker_co_chair',
  'mgmt_co_chair',
  'worker_rep',
  'mgmt_rep',
  'guest',
] as const;
export type MeetingAttendanceRole = (typeof meetingAttendanceRole)[number];
export const meetingAttendanceRoleSchema = z.enum(meetingAttendanceRole);

export const meetingAttendanceParty = ['union', 'management', 'guest'] as const;
export type MeetingAttendanceParty = (typeof meetingAttendanceParty)[number];
export const meetingAttendancePartySchema = z.enum(meetingAttendanceParty);

export const meetingPresentStatus = [
  'present',
  'regrets',
  'absent_unexcused',
  'late_arrival',
  'early_departure',
] as const;
export type MeetingPresentStatus = (typeof meetingPresentStatus)[number];
export const meetingPresentStatusSchema = z.enum(meetingPresentStatus);

// ---------------------------------------------------------------------------
// Inspection review outcome
// ---------------------------------------------------------------------------

export const meetingReviewOutcome = [
  'accepted_as_complete',
  'findings_promoted',
  'deferred',
] as const;
export type MeetingReviewOutcome = (typeof meetingReviewOutcome)[number];
export const meetingReviewOutcomeSchema = z.enum(meetingReviewOutcome);

// ---------------------------------------------------------------------------
// Action item snapshot kind
// ---------------------------------------------------------------------------

export const meetingSnapshotKind = ['live', 'finalized'] as const;
export type MeetingSnapshotKind = (typeof meetingSnapshotKind)[number];
export const meetingSnapshotKindSchema = z.enum(meetingSnapshotKind);

// ---------------------------------------------------------------------------
// Meeting template sections_json shape (validated at seed time)
// ---------------------------------------------------------------------------

/**
 * One entry in the meeting_templates.sections_json array. The S4 seed
 * supplies the v1 template; this Zod schema is the gate for any future
 * template insert (route-layer / script).
 *
 * `default_time_alloc_minutes` is 0 to represent "open" (no fixed
 * duration) per ADR §3.3.
 */
export const meetingTemplateSectionSchema = z.object({
  section_type: meetingSectionTypeSchema,
  default_time_alloc_minutes: z.number().int().min(0).max(240),
  default_visibility: meetingSectionVisibilitySchema,
  order_idx: z.number().int().min(0).max(31),
});
export type MeetingTemplateSection = z.infer<typeof meetingTemplateSectionSchema>;

export const meetingTemplateSectionsSchema = z.array(meetingTemplateSectionSchema).min(1).max(32);
