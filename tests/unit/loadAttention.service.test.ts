import {
  buildLoadAttention,
  scheduleDayKey,
  type AttentionLoad,
} from '../../src/services/loadAttention.service';

const DAY = 86_400_000;
const now = Date.parse('2026-10-13T18:00:00Z');
const todayKey = '2026-10-13';

const load = (overrides: Partial<AttentionLoad> & { _id: string }): AttentionLoad => ({
  loadNumber: `LD-${overrides._id}`,
  status: 'Accepted',
  organizationId: 'org-1',
  assignedDriverId: 'driver-1',
  dispatchOwnerId: 'dispatcher-1',
  dates: {},
  ...overrides,
});

const build = (input: Partial<Parameters<typeof buildLoadAttention>[0]>) =>
  buildLoadAttention({
    activeLoads: [],
    proofLoads: [],
    locations: [],
    profiles: [],
    driverNames: new Map([['driver-1', 'Sam Driver']]),
    canSeeGps: () => true,
    todayKey,
    nowMs: now,
    ...input,
  });

describe('scheduleDayKey', () => {
  it('reads the calendar day stored on a schedule date', () => {
    expect(scheduleDayKey(new Date('2026-10-12T00:00:00Z'))).toBe('2026-10-12');
    expect(scheduleDayKey('2026-10-12')).toBe('2026-10-12');
    expect(scheduleDayKey(null)).toBeNull();
    expect(scheduleDayKey('not a date')).toBeNull();
  });
});

describe('buildLoadAttention', () => {
  it('lists unconfirmed delivery proofs, oldest first, with the driver name', () => {
    const result = build({
      proofLoads: [
        load({ _id: 'b', status: 'Delivered', proofOfDelivery: { submittedAt: new Date('2026-10-12T10:00:00Z') } }),
        load({ _id: 'a', status: 'Delivered', proofOfDelivery: { submittedAt: new Date('2026-10-11T10:00:00Z') } }),
      ],
    });
    expect(result.counts.proof_waiting).toBe(2);
    expect(result.items.map((item) => item.loadId)).toEqual(['a', 'b']);
    expect(result.items[0]).toMatchObject({ kind: 'proof_waiting', driverName: 'Sam Driver' });
  });

  it('flags a pickup only once its deadline day is over, and only before pickup', () => {
    const result = build({
      activeLoads: [
        load({ _id: 'late', status: 'Assigned', dates: { pickupDeadline: new Date('2026-10-12T00:00:00Z') } }),
        load({ _id: 'today', status: 'Accepted', dates: { pickupDeadline: new Date('2026-10-13T00:00:00Z') } }),
        load({ _id: 'picked', status: 'Picked Up', dates: { pickupDeadline: new Date('2026-10-01T00:00:00Z') } }),
      ],
    });
    expect(result.items.filter((item) => item.kind === 'late_pickup').map((item) => item.loadId)).toEqual(['late']);
  });

  it('flags a delivery past its deadline day while the vehicles are on board', () => {
    const result = build({
      activeLoads: [
        load({ _id: 'late', status: 'In-Transit', dates: { deliveryDeadline: new Date('2026-10-10T00:00:00Z') } }),
        load({ _id: 'not-picked', status: 'Accepted', dates: { deliveryDeadline: new Date('2026-10-10T00:00:00Z') } }),
      ],
    });
    expect(result.items.filter((item) => item.kind === 'late_delivery')).toEqual([
      expect.objectContaining({ loadId: 'late', date: '2026-10-10' }),
    ]);
  });

  it('shows quiet GPS only when the silence alert fired and the user may see that driver', () => {
    const lastSeen = new Date(now - 40 * 60_000);
    const locations = [{ userId: 'driver-1', status: 'offline', offlineAlertSentAt: new Date(now - 30 * 60_000), lastSeenAt: lastSeen }];
    const activeLoads = [load({ _id: 'tracked', status: 'In-Transit' })];

    expect(build({ activeLoads, locations }).items).toEqual([
      expect.objectContaining({ kind: 'gps_quiet', loadId: 'tracked', since: lastSeen.toISOString() }),
    ]);
    expect(build({ activeLoads, locations, canSeeGps: () => false }).counts.gps_quiet).toBe(0);
    // Sharing again clears the alert mark.
    expect(
      build({ activeLoads, locations: [{ ...locations[0], status: 'on-route', offlineAlertSentAt: null }] }).counts.gps_quiet,
    ).toBe(0);
  });

  it('lists each driver credential once: expired, or expiring within 14 days', () => {
    const result = build({
      activeLoads: [load({ _id: 'one' }), load({ _id: 'two', status: 'Picked Up' })],
      profiles: [
        {
          userId: 'driver-1',
          licenseExpirationDate: new Date(now - 2 * DAY),
          medicalCardExpirationDate: new Date(now + 5 * DAY),
          insuranceExpirationDate: new Date(now + 60 * DAY),
        },
      ],
    });
    expect(result.counts.document_expired).toBe(1);
    expect(result.counts.document_expiring).toBe(1);
    expect(result.items.find((item) => item.kind === 'document_expired')).toMatchObject({
      credential: 'CDL',
      loadId: 'one',
    });
    expect(result.items.find((item) => item.kind === 'document_expiring')).toMatchObject({
      credential: 'medical card',
      daysLeft: 5,
    });
  });

  it('caps each kind at 25 items but keeps the full count', () => {
    const proofLoads = Array.from({ length: 30 }, (_, index) =>
      load({ _id: `p${index}`, status: 'Delivered', proofOfDelivery: { submittedAt: new Date(now - index * 60_000) } }),
    );
    const result = build({ proofLoads });
    expect(result.counts.proof_waiting).toBe(30);
    expect(result.items).toHaveLength(25);
  });
});

describe("work waiting for Dispatch", () => {
  const HOUR = 3_600_000;

  it("flags a load with no driver from its pickup day on, but not before", () => {
    const result = build({
      unassignedLoads: [
        load({ _id: "today", status: "Posted", assignedDriverId: null, dates: { pickupDeadline: new Date("2026-10-13T00:00:00Z") } }),
        load({ _id: "past", status: "Draft", assignedDriverId: null, dates: { pickupDeadline: new Date("2026-10-11T00:00:00Z") } }),
        load({ _id: "tomorrow", status: "Posted", assignedDriverId: null, dates: { pickupDeadline: new Date("2026-10-14T00:00:00Z") } }),
        load({ _id: "has-driver", status: "Posted", dates: { pickupDeadline: new Date("2026-10-12T00:00:00Z") } }),
      ],
    });
    expect(result.counts.unassigned_pickup).toBe(2);
    expect(result.items.filter((item) => item.kind === "unassigned_pickup").map((item) => item.loadId)).toEqual(["past", "today"]);
  });

  it("flags an assignment the driver has not accepted after 2 hours", () => {
    const result = build({
      activeLoads: [
        load({ _id: "old", status: "Assigned", assignedAt: new Date(now - 2 * HOUR - 1) }),
        load({ _id: "new", status: "Assigned", assignedAt: new Date(now - HOUR) }),
        load({ _id: "accepted", status: "Accepted", assignedAt: new Date(now - 5 * HOUR) }),
      ],
    });
    expect(result.counts.not_accepted).toBe(1);
    expect(result.items.find((item) => item.kind === "not_accepted")).toMatchObject({ loadId: "old", driverName: "Sam Driver" });
  });

  it("lists release requests on loads the driver has, emergencies first", () => {
    const activeLoads = [load({ _id: "a" }), load({ _id: "b" })];
    const result = build({
      activeLoads,
      releaseRequests: [
        { loadId: "a", driverId: "driver-1", priority: "standard", requestedAt: new Date(now - 3 * HOUR) },
        { loadId: "b", driverId: "driver-1", priority: "emergency", requestedAt: new Date(now - HOUR) },
        { loadId: "gone", driverId: "driver-1", priority: "standard", requestedAt: new Date(now - HOUR) },
      ],
    });
    expect(result.items.filter((item) => item.kind === "release_request").map((item) => [item.loadId, item.emergency])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });

  it("counts drivers waiting on a posted load and keeps the earliest request time", () => {
    const result = build({
      requestedLoads: [
        load({
          _id: "board",
          status: "Posted",
          assignedDriverId: null,
          driverRequests: [
            { driverId: "d1", requestedAt: new Date(now - HOUR) },
            { driverId: "d2", requestedAt: new Date(now - 3 * HOUR) },
          ],
        }),
        load({ _id: "taken", status: "Assigned", driverRequests: [{ driverId: "d3", requestedAt: new Date(now) }] }),
      ],
    });
    expect(result.counts.load_request).toBe(1);
    expect(result.items.find((item) => item.kind === "load_request")).toMatchObject({
      loadId: "board",
      requestCount: 2,
      since: new Date(now - 3 * HOUR).toISOString(),
    });
  });

  it("lists waiting customer shipping requests, oldest first, without a load", () => {
    const result = build({
      customerRequests: [
        { _id: "q2", firstName: "Maria", lastName: "Santos", vehicleName: "2021 Toyota Camry", createdAt: new Date(now - HOUR) },
        { _id: "q1", firstName: "", lastName: "", createdAt: new Date(now - 5 * HOUR) },
      ],
    });
    const items = result.items.filter((item) => item.kind === "customer_request");
    expect(items.map((item) => item.quoteId)).toEqual(["q1", "q2"]);
    expect(items[0]).toMatchObject({ loadId: "", customerName: "A customer" });
    expect(items[1]).toMatchObject({ customerName: "Maria Santos", vehicleName: "2021 Toyota Camry" });
  });
});

describe("vehicles removed from inventory", () => {
  it("lists a load before pickup and a waiting quote whose vehicle was removed", () => {
    const result = build({
      removedVehicles: [
        { load: load({ _id: "load-1", status: "Posted", assignedDriverId: null }), vehicleName: "2020 Honda Civic" },
        { quote: { _id: "quote-1", firstName: "Maria", lastName: "Santos", vehicleName: "2021 Toyota Camry", createdAt: new Date(now) } },
      ],
    });
    expect(result.counts.vehicle_removed).toBe(2);
    const items = result.items.filter((item) => item.kind === "vehicle_removed");
    expect(items[0]).toMatchObject({ loadId: "load-1", vehicleName: "2020 Honda Civic" });
    expect(items[1]).toMatchObject({ loadId: "", quoteId: "quote-1", customerName: "Maria Santos", vehicleName: "2021 Toyota Camry" });
  });
});
