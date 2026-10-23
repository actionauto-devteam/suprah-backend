import {
  CONTACT_RESTRICTED_STATUSES,
  LEAD_STATUS_VALUES,
  LIFECYCLE_ACTIVE_STATUSES,
  LIFECYCLE_TERMINAL_STATUSES,
  NURTURE_ELIGIBLE_STATUSES,
  TERMINAL_LEAD_STATUSES,
  classifyLeadLifecycle,
  isContactRestrictedStatus,
} from '../../src/constants/leadStatus';

describe('lead lifecycle status classification', () => {
  it.each(['Closed', 'Sold', 'Bought Elsewhere', 'Bad Lead', 'Missed Opportunity', 'Declined', 'No Longer Interested'])(
    'treats %p as a finished lead',
    (status) => {
      expect(classifyLeadLifecycle(status)).toBe('terminal');
    },
  );

  it.each(['New', 'Viewed', 'Contacted', 'Pending', 'Appointment Set', 'Working', 'Pending Recon', 'In Finance', 'Online Financing'])(
    'treats %p as an active lead',
    (status) => {
      expect(classifyLeadLifecycle(status)).toBe('active');
    },
  );

  it('keeps In Finance and Online Financing active', () => {
    expect(LIFECYCLE_ACTIVE_STATUSES).toEqual(expect.arrayContaining(['In Finance', 'Online Financing']));
    expect(LIFECYCLE_TERMINAL_STATUSES).not.toContain('In Finance');
    expect(LIFECYCLE_TERMINAL_STATUSES).not.toContain('Online Financing');
  });

  it('treats Do Not Contact as finished for matching and as a contact restriction', () => {
    expect(classifyLeadLifecycle('Do Not Contact')).toBe('terminal');
    expect(isContactRestrictedStatus('Do Not Contact')).toBe(true);
    expect(isContactRestrictedStatus('Closed')).toBe(false);
    expect(CONTACT_RESTRICTED_STATUSES).toEqual(['Do Not Contact']);
  });

  it('classifies every known status exactly once', () => {
    for (const status of LEAD_STATUS_VALUES) {
      expect(['active', 'terminal']).toContain(classifyLeadLifecycle(status));
    }
    const overlap = LIFECYCLE_ACTIVE_STATUSES.filter((status) => LIFECYCLE_TERMINAL_STATUSES.includes(status));
    expect(overlap).toEqual([]);
    expect(LIFECYCLE_ACTIVE_STATUSES.length + LIFECYCLE_TERMINAL_STATUSES.length).toBe(LEAD_STATUS_VALUES.length);
  });

  it.each([undefined, null, '', 'Archived', 42])('returns unknown for %p', (status) => {
    expect(classifyLeadLifecycle(status)).toBe('unknown');
  });

  it('leaves the existing status lists used elsewhere unchanged', () => {
    expect(TERMINAL_LEAD_STATUSES).toEqual([
      'Bought Elsewhere',
      'Bad Lead',
      'Do Not Contact',
      'Sold',
      'In Finance',
      'Online Financing',
      'Closed',
    ]);
    expect(NURTURE_ELIGIBLE_STATUSES).toContain('Declined');
    expect(NURTURE_ELIGIBLE_STATUSES).toContain('No Longer Interested');
  });
});
