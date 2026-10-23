export type LeadStatusCategory = 'None' | 'Active' | 'MissedOpportunity' | 'DeadLead' | 'Sold' | 'ClosedLegacy';

export const LEAD_STATUS_CATEGORY_ORDER: LeadStatusCategory[] = [
  'None',
  'Active',
  'MissedOpportunity',
  'DeadLead',
  'Sold',
  'ClosedLegacy',
];

export const LEAD_STATUS_CATEGORIES: Record<LeadStatusCategory, string[]> = {
  None: ['New', 'Viewed'],
  Active: [
    'Contacted',
    'Pending',
    'Appointment Set',
    'In Process',
    'Attempted to Contact',
    'Contact in Future',
    'Declined',
    'Appointment Scheduled',
    'Rescheduled',
    'Came to Dealership',
    'No Longer Interested',
    'Appointment Confirmed',
    'Working',
    '2nd Attempt to Contact',
    '3rd Attempt to Contact',
    '4th Attempt to Contact',
    'Pending Recon',
    'Vehicle Not InStock',
  ],
  MissedOpportunity: ['Missed Opportunity'],
  DeadLead: ['Bought Elsewhere', 'Bad Lead', 'Do Not Contact'],
  Sold: ['Sold', 'In Finance', 'Online Financing'],
  ClosedLegacy: ['Closed'],
};

export const LEAD_STATUS_VALUES: string[] = LEAD_STATUS_CATEGORY_ORDER.flatMap(
  (category) => LEAD_STATUS_CATEGORIES[category],
);

export const LEAD_STATUS_CATEGORY_OF: Record<string, LeadStatusCategory> = LEAD_STATUS_CATEGORY_ORDER.reduce(
  (acc, category) => {
    for (const status of LEAD_STATUS_CATEGORIES[category]) acc[status] = category;
    return acc;
  },
  {} as Record<string, LeadStatusCategory>,
);

/** Leads still worth actively nurturing/re-engaging — everything in None + Active. */
export const NURTURE_ELIGIBLE_STATUSES: string[] = [
  ...LEAD_STATUS_CATEGORIES.None,
  ...LEAD_STATUS_CATEGORIES.Active,
];

/** Powers the "unanswered inquiry" staff reminder — unchanged value, now centralized. */
export const UNANSWERED_LEAD_STATUSES: string[] = ['New', 'Pending'];

/** Terminal outcomes — a lead here is no longer being pursued. */
export const TERMINAL_LEAD_STATUSES: string[] = [
  ...LEAD_STATUS_CATEGORIES.DeadLead,
  ...LEAD_STATUS_CATEGORIES.Sold,
  ...LEAD_STATUS_CATEGORIES.ClosedLegacy,
];

/** Moving a lead to one of these statuses prompts staff for a reason. */
export const REASON_REQUIRED_STATUSES: string[] = [
  ...LEAD_STATUS_CATEGORIES.DeadLead,
  ...LEAD_STATUS_CATEGORIES.ClosedLegacy,
];

export type LeadLifecycleState = 'active' | 'terminal' | 'unknown';

export const CONTACT_RESTRICTED_STATUSES: string[] = ['Do Not Contact'];

export const LIFECYCLE_TERMINAL_STATUSES: string[] = [
  'Closed',
  'Sold',
  'Bought Elsewhere',
  'Bad Lead',
  'Missed Opportunity',
  'Declined',
  'No Longer Interested',
  ...CONTACT_RESTRICTED_STATUSES,
];

export const LIFECYCLE_ACTIVE_STATUSES: string[] = LEAD_STATUS_VALUES.filter(
  (status) => !LIFECYCLE_TERMINAL_STATUSES.includes(status),
);

export function classifyLeadLifecycle(status: unknown): LeadLifecycleState {
  const value = typeof status === 'string' ? status.trim() : '';
  if (LIFECYCLE_TERMINAL_STATUSES.includes(value)) return 'terminal';
  if (LIFECYCLE_ACTIVE_STATUSES.includes(value)) return 'active';
  return 'unknown';
}

export function isContactRestrictedStatus(status: unknown): boolean {
  return typeof status === 'string' && CONTACT_RESTRICTED_STATUSES.includes(status.trim());
}
