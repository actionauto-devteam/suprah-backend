/**
 * Deal Desk — shared constants.
 *
 * One stage machine for every deal, whatever its source (Supra New Deal
 * channel, website widget, CRM). Every stage change is timestamped in
 * deal.stageHistory, which is what the Deal Queue metrics are built on.
 */

export const DEAL_STAGES = [
  'draft',
  'submitted',
  'picked_up',
  'processing',
  'needs_info',
  'structured',
  'ready_for_fi',
  'offered',
  'in_fi',
  'signed',
  'funded',
  'cancelled',
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_SOURCES = ['supra', 'web', 'crm'] as const;
export type DealSource = (typeof DEAL_SOURCES)[number];

export const STAGE_LABELS: Record<DealStage, string> = {
  draft: 'Draft',
  submitted: 'Waiting pickup',
  picked_up: 'In review',
  processing: 'AI processing',
  needs_info: 'Needs info',
  structured: 'Structured',
  ready_for_fi: 'Ready for F&I',
  offered: 'Offered to FM',
  in_fi: 'In F&I',
  signed: 'Signed',
  funded: 'Funded',
  cancelled: 'Cancelled',
};

/** Allowed transitions. Anything not listed here is rejected. */
export const STAGE_TRANSITIONS: Record<DealStage, DealStage[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['picked_up', 'needs_info', 'cancelled'],
  picked_up: ['processing', 'structured', 'needs_info', 'submitted', 'cancelled'],
  processing: ['structured', 'needs_info', 'picked_up'],
  needs_info: ['submitted', 'cancelled'],
  structured: ['processing', 'ready_for_fi', 'needs_info', 'cancelled'],
  ready_for_fi: ['offered', 'structured', 'cancelled'],
  offered: ['in_fi', 'ready_for_fi', 'cancelled'],
  in_fi: ['signed', 'ready_for_fi', 'cancelled'],
  signed: ['funded', 'in_fi'],
  funded: [],
  cancelled: [],
};

/** Stages that count as "open" in the live queue. */
export const OPEN_STAGES: DealStage[] = [
  'submitted',
  'picked_up',
  'processing',
  'needs_info',
  'structured',
  'ready_for_fi',
  'offered',
  'in_fi',
];

export const CLOSED_STAGES: DealStage[] = ['signed', 'funded', 'cancelled'];

/** Default target minutes per stage (green until target, amber to 2×, red after). */
export const DEFAULT_SLA_MINUTES: Partial<Record<DealStage, number>> = {
  submitted: 10,
  picked_up: 30,
  processing: 5,
  needs_info: 120,
  structured: 15,
  ready_for_fi: 5,
  offered: 5,
  in_fi: 90,
};

export const DOCUMENT_KINDS = [
  'four_square',
  'credit_app',
  'drivers_license',
  'proof_income',
  'proof_residence',
  'insurance',
  'trade_title',
  'other',
] as const;
export type DealDocumentKind = (typeof DOCUMENT_KINDS)[number];

/** What the New Deal checklist requires before a salesperson can submit. */
export const REQUIRED_DOCUMENTS: DealDocumentKind[] = ['four_square', 'credit_app', 'drivers_license'];

export const DEFAULT_ACCEPT_WINDOW_SECONDS = 300;

export const CONSENT_TEXT =
  'I authorize the dealership and its lending partners to obtain my credit report and verify the information in this application for the purpose of evaluating my request for vehicle financing.';

export const RULES_VERSION = '2026.11.1';
