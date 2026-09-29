import {
  LEAD_STATUS_CATEGORIES,
  LEAD_STATUS_CATEGORY_ORDER,
  LEAD_STATUS_VALUES,
  LEAD_STATUS_CATEGORY_OF,
  NURTURE_ELIGIBLE_STATUSES,
  TERMINAL_LEAD_STATUSES,
  REASON_REQUIRED_STATUSES,
} from '../../src/constants/leadStatus';

describe('leadStatus constants', () => {
  it('every category in the order list has a definition and vice versa', () => {
    const definedCategories = Object.keys(LEAD_STATUS_CATEGORIES).sort();
    const orderedCategories = [...LEAD_STATUS_CATEGORY_ORDER].sort();
    expect(definedCategories).toEqual(orderedCategories);
  });

  it('LEAD_STATUS_VALUES has no duplicate statuses across categories', () => {
    const seen = new Set<string>();
    for (const status of LEAD_STATUS_VALUES) {
      expect(seen.has(status)).toBe(false);
      seen.add(status);
    }
  });

  it('every status is assigned to exactly one category', () => {
    for (const status of LEAD_STATUS_VALUES) {
      expect(LEAD_STATUS_CATEGORY_OF[status]).toBeDefined();
    }
    expect(Object.keys(LEAD_STATUS_CATEGORY_OF).length).toBe(LEAD_STATUS_VALUES.length);
  });

  it('the 5 legacy statuses remain valid values (additive migration, nothing removed)', () => {
    for (const legacy of ['New', 'Contacted', 'Pending', 'Appointment Set', 'Closed']) {
      expect(LEAD_STATUS_VALUES).toContain(legacy);
    }
  });

  it('nurture-eligible statuses are exactly None + Active', () => {
    const expected = [...LEAD_STATUS_CATEGORIES.None, ...LEAD_STATUS_CATEGORIES.Active];
    expect(NURTURE_ELIGIBLE_STATUSES).toEqual(expected);
  });

  it('terminal statuses exclude every nurture-eligible status', () => {
    for (const status of NURTURE_ELIGIBLE_STATUSES) {
      expect(TERMINAL_LEAD_STATUSES).not.toContain(status);
    }
  });

  it('reason-required statuses are a subset of terminal statuses', () => {
    for (const status of REASON_REQUIRED_STATUSES) {
      expect(TERMINAL_LEAD_STATUSES).toContain(status);
    }
  });
});
