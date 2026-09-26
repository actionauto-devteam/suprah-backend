import {
  REASSIGNABLE_LOAD_STATUSES,
  canStaffDeleteLoad,
  checkDeliveryConfirmation,
  checkProofOfDeliverySubmission,
  isReassignableLoad,
  proofOfDeliveryBelongsTo,
  staffDeletableLoadFilter,
} from '../../src/services/loadLifecyclePolicy';
import { DRIVER_ACTIVE_LOAD_STATUSES } from '../../src/services/driverReviewAccess.service';
import Load from '../../src/models/Load.model';

const ALL_STATUSES = ['Draft', 'Posted', 'Assigned', 'Accepted', 'Picked Up', 'In-Transit', 'Delivered', 'Cancelled'];
const DRIVER = 'driver-a';
const OTHER_DRIVER = 'driver-b';

// Minimal evaluator for the filter shapes produced by the policy module.
function matches(filter: any, doc: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, condition]: [string, any]) => {
    if (key === '$or') return condition.some((branch: any) => matches(branch, doc));
    const value = doc[key];
    if (condition === null) return value === null || value === undefined;
    if (condition && typeof condition === 'object' && '$in' in condition) return condition.$in.includes(value);
    return value === condition;
  });
}

describe('staff load deletion (DT-04)', () => {
  it('allows unassigned Draft/Posted and closed loads, blocks active work', () => {
    const expected: Record<string, boolean> = {
      Draft: true, Posted: true, Cancelled: true, Delivered: true,
      Assigned: false, Accepted: false, 'Picked Up': false, 'In-Transit': false,
    };
    for (const status of ALL_STATUSES) {
      expect(canStaffDeleteLoad({ status, assignedDriverId: null })).toBe(expected[status]);
    }
  });

  it('blocks Draft/Posted loads that still have a driver attached', () => {
    expect(canStaffDeleteLoad({ status: 'Posted', assignedDriverId: DRIVER })).toBe(false);
    expect(canStaffDeleteLoad({ status: 'Draft', assignedDriverId: DRIVER })).toBe(false);
    expect(canStaffDeleteLoad({ status: 'Delivered', assignedDriverId: DRIVER })).toBe(true);
  });

  it('uses the same rule in the conditional delete filter', () => {
    const filter = staffDeletableLoadFilter();
    for (const status of ALL_STATUSES) {
      for (const assignedDriverId of [null, DRIVER]) {
        expect(matches(filter, { status, assignedDriverId })).toBe(
          canStaffDeleteLoad({ status, assignedDriverId }),
        );
      }
    }
  });
});

describe('reassign eligibility (DT-13)', () => {
  it('matches the shared active status list', () => {
    expect([...REASSIGNABLE_LOAD_STATUSES]).toEqual([...DRIVER_ACTIVE_LOAD_STATUSES]);
  });

  it('requires an assigned driver on an active load', () => {
    expect(isReassignableLoad({ status: 'Posted', assignedDriverId: null })).toBe(false);
    expect(isReassignableLoad({ status: 'Draft', assignedDriverId: null })).toBe(false);
    expect(isReassignableLoad({ status: 'Assigned', assignedDriverId: null })).toBe(false);
    for (const status of DRIVER_ACTIVE_LOAD_STATUSES) {
      expect(isReassignableLoad({ status, assignedDriverId: DRIVER })).toBe(true);
    }
  });
});

describe('proof of delivery ownership (DT-05)', () => {
  it("rejects another driver's proof and accepts legacy proof", () => {
    expect(proofOfDeliveryBelongsTo({ proofOfDelivery: { imageUrl: 'k', submittedBy: DRIVER } }, DRIVER)).toBe(true);
    expect(proofOfDeliveryBelongsTo({ proofOfDelivery: { imageUrl: 'k', submittedBy: OTHER_DRIVER } }, DRIVER)).toBe(false);
    expect(proofOfDeliveryBelongsTo({ proofOfDelivery: { imageUrl: 'k' } }, DRIVER)).toBe(true);
  });

  it('allows submission only by the assigned driver while In-Transit and unconfirmed', () => {
    for (const status of ALL_STATUSES) {
      const result = checkProofOfDeliverySubmission({ status, assignedDriverId: DRIVER }, DRIVER);
      expect(result.ok).toBe(status === 'In-Transit');
    }
    expect(checkProofOfDeliverySubmission({ status: 'In-Transit', assignedDriverId: OTHER_DRIVER }, DRIVER))
      .toMatchObject({ ok: false, statusCode: 403 });
    expect(
      checkProofOfDeliverySubmission(
        { status: 'In-Transit', assignedDriverId: DRIVER, proofOfDelivery: { imageUrl: 'k', confirmedAt: new Date() } },
        DRIVER,
      ),
    ).toMatchObject({ ok: false, statusCode: 409 });
  });
});

describe('staff delivery confirmation (DT-04 / DT-05)', () => {
  const pod = { imageUrl: 'k', submittedBy: DRIVER };

  it('requires the driver to have completed delivery', () => {
    for (const status of ALL_STATUSES.filter((s) => s !== 'Delivered')) {
      expect(checkDeliveryConfirmation({ status, assignedDriverId: DRIVER, proofOfDelivery: pod }))
        .toMatchObject({ ok: false, statusCode: 409 });
    }
    expect(checkDeliveryConfirmation({ status: 'Delivered', assignedDriverId: DRIVER, proofOfDelivery: pod }))
      .toEqual({ ok: true, alreadyConfirmed: false });
  });

  it('needs proof from the assigned driver and is idempotent once confirmed', () => {
    expect(checkDeliveryConfirmation({ status: 'Delivered', assignedDriverId: DRIVER }))
      .toMatchObject({ ok: false, statusCode: 400 });
    expect(checkDeliveryConfirmation({
      status: 'Delivered', assignedDriverId: DRIVER, proofOfDelivery: { imageUrl: 'k', submittedBy: OTHER_DRIVER },
    })).toMatchObject({ ok: false, statusCode: 409 });
    expect(checkDeliveryConfirmation({
      status: 'Delivered', assignedDriverId: DRIVER, proofOfDelivery: { ...pod, confirmedAt: new Date() },
    })).toEqual({ ok: true, alreadyConfirmed: true });
  });
});

describe('Load schema (DT-05 / DT-14)', () => {
  it('records who submitted proof of delivery', () => {
    expect(Load.schema.path('proofOfDelivery.submittedBy')).toBeDefined();
  });

  it("keeps each requester's signature image out of normal queries", () => {
    const requestSchema = (Load.schema.path('driverRequests') as any).schema;
    expect(requestSchema.path('signature.signatureDataUrl').options.select).toBe(false);
  });
});
