import {
  ACTIVE_LOAD_STATUSES,
  GPS_TRACKING_LOAD_STATUSES,
  LOAD_STATUSES,
  LOAD_STATUS_TRANSITIONS,
  VEHICLES_ON_BOARD_STATUSES,
  isAllowedLoadTransition,
} from '../../src/constants/loadStatus';
import { REASSIGNABLE_LOAD_STATUSES } from '../../src/services/loadLifecyclePolicy';

describe('load status table (DT-40)', () => {
  it('allows the normal driver steps', () => {
    expect(isAllowedLoadTransition('Posted', 'Assigned')).toBe(true);
    expect(isAllowedLoadTransition('Assigned', 'Accepted')).toBe(true);
    expect(isAllowedLoadTransition('Accepted', 'Picked Up')).toBe(true);
    expect(isAllowedLoadTransition('Picked Up', 'In-Transit')).toBe(true);
    expect(isAllowedLoadTransition('In-Transit', 'Delivered')).toBe(true);
  });

  it('allows reassigning any active load and returning it to the board only before pickup', () => {
    for (const status of ACTIVE_LOAD_STATUSES) {
      expect(isAllowedLoadTransition(status, 'Assigned')).toBe(true);
    }
    expect(isAllowedLoadTransition('Assigned', 'Posted')).toBe(true);
    expect(isAllowedLoadTransition('Accepted', 'Posted')).toBe(true);
    expect(isAllowedLoadTransition('Picked Up', 'Posted')).toBe(false);
    expect(isAllowedLoadTransition('In-Transit', 'Posted')).toBe(false);
  });

  it('refuses skipped steps, going backwards and leaving a finished load', () => {
    expect(isAllowedLoadTransition('Assigned', 'Picked Up')).toBe(false);
    expect(isAllowedLoadTransition('Accepted', 'Delivered')).toBe(false);
    expect(isAllowedLoadTransition('In-Transit', 'Picked Up')).toBe(false);
    for (const status of LOAD_STATUSES) {
      expect(isAllowedLoadTransition('Delivered', status)).toBe(false);
      expect(isAllowedLoadTransition('Cancelled', status)).toBe(false);
    }
    expect(isAllowedLoadTransition('Unknown', 'Assigned')).toBe(false);
  });

  it('keeps every list inside the known statuses', () => {
    const known = new Set<string>(LOAD_STATUSES);
    for (const [from, targets] of Object.entries(LOAD_STATUS_TRANSITIONS)) {
      expect(known.has(from)).toBe(true);
      for (const to of targets) expect(known.has(to)).toBe(true);
    }
    for (const status of [...GPS_TRACKING_LOAD_STATUSES, ...VEHICLES_ON_BOARD_STATUSES]) {
      expect((ACTIVE_LOAD_STATUSES as readonly string[]).includes(status)).toBe(true);
    }
    expect([...REASSIGNABLE_LOAD_STATUSES]).toEqual([...ACTIVE_LOAD_STATUSES]);
  });
});
