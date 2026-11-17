// Tests from the October 16, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

// Fakes from loadConditionReport.service.test.ts
jest.mock('../../src/utils/signedUrlCache', () => ({
  getSignedProofUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
}));

import { complianceExpiryCutoff, complianceExpiryItems, expiringSoonItems, isComplianceExpiredAt, mountainDaysUntil } from '../../src/models/DriverProfile.model';
import { buildLoadAttention, scheduleDayKey, type AttentionLoad } from '../../src/services/loadAttention.service';
import { assertConditionStopEditable, editableConditionStops, omitConditionReportsFromList, parseConditionStop, parseDeliverySignature, parseVehicleIndex, presentConditionReportsForStaff, sanitizeConditionDetails } from '../../src/services/loadConditionReport.service';

describe('expiringSoonItems.test.ts', () => {
  const day = (key: string) => new Date(`${key}T00:00:00Z`);
  // Oct 13, 2026 at 10:00 AM MDT.
  const morning = Date.parse('2026-10-13T16:00:00Z');

  describe('expiration days on the Mountain Time calendar', () => {
    // Oct 16 at 9:00 PM MDT, which is already Oct 17 in UTC.
    const evening = Date.parse('2026-10-17T03:00:00Z');

    it('counts whole Mountain Time days, 0 on the day itself', () => {
      expect(mountainDaysUntil(day('2026-10-17'), evening)).toBe(1);
      expect(mountainDaysUntil(day('2026-10-16'), evening)).toBe(0);
      expect(mountainDaysUntil(day('2026-10-10'), evening)).toBe(-6);
      expect(mountainDaysUntil(null, evening)).toBeNull();
    });

    it("doesn't call a credential expired the evening before its date (it used to at 6 PM)", () => {
      const profile = { licenseExpirationDate: day('2026-10-17') };
      expect(isComplianceExpiredAt(profile, evening)).toBe(false);
      expect(complianceExpiryItems(profile, evening)[0]).toMatchObject({ expired: false, daysLeft: 1 });
      // From midnight Mountain Time on Oct 17 it has expired.
      expect(isComplianceExpiredAt(profile, Date.parse('2026-10-17T06:00:00Z'))).toBe(true);
    });

    it('gives the database cutoff that matches: the start of tomorrow, as stored', () => {
      expect(complianceExpiryCutoff(evening).toISOString()).toBe('2026-10-17T00:00:00.000Z');
      expect(complianceExpiryCutoff(Date.parse('2026-10-17T06:00:00Z')).toISOString()).toBe('2026-10-18T00:00:00.000Z');
    });
  });

  describe('expiringSoonItems (Driver Page "expires soon" notice)', () => {
    it('counts the days on the Mountain Time calendar, also late in the evening', () => {
      const profile = { licenseExpirationDate: day('2026-10-16') };
      expect(expiringSoonItems(profile, 30, morning)[0].daysLeft).toBe(3);
      // Oct 13 at 9:00 PM MDT is already Oct 14 in UTC; it's still Oct 13 in Denver.
      expect(expiringSoonItems(profile, 30, Date.parse('2026-10-14T03:00:00Z'))[0].daysLeft).toBe(3);
    });

    it('includes 30, 14 and 3 days out, but not the expiration day itself or later', () => {
      const at = (key: string) => expiringSoonItems({ medicalCardExpirationDate: day(key) }, 30, morning);
      expect(at('2026-11-12')[0].daysLeft).toBe(30);
      expect(at('2026-10-27')[0].daysLeft).toBe(14);
      expect(at('2026-10-14')[0].daysLeft).toBe(1);
      expect(at('2026-11-13')).toEqual([]);
      expect(at('2026-10-13')).toEqual([]);
      expect(at('2026-10-01')).toEqual([]);
    });

    it("uses an uploaded document's date even when the profile has a later one", () => {
      const items = expiringSoonItems(
        {
          licenseExpirationDate: day('2030-07-19'),
          documents: [{ type: 'drivers_license', label: 'CDL', expiresAt: day('2026-10-27'), reviewStatus: 'pending' }],
        },
        30,
        morning,
      );
      expect(items).toEqual([{ label: 'CDL', date: '2026-10-27', expired: false, daysLeft: 14 }]);
    });

    it('lets an uploaded renewal replace the old document, and ignores rejected ones', () => {
      expect(
        expiringSoonItems(
          {
            documents: [
              { type: 'drivers_license', expiresAt: day('2026-10-20'), reviewStatus: 'approved' },
              { type: 'drivers_license', expiresAt: day('2030-10-20'), reviewStatus: 'pending' },
              { type: 'medical_card', expiresAt: day('2031-01-01'), reviewStatus: 'rejected' },
              { type: 'medical_card', expiresAt: day('2026-10-18'), reviewStatus: 'approved' },
            ],
          },
          30,
          morning,
        ),
      ).toEqual([{ label: 'medical card', date: '2026-10-18', expired: false, daysLeft: 5 }]);
    });

    it('covers every dated document type, closest first', () => {
      const items = expiringSoonItems(
        {
          documents: [
            { type: 'vehicle_registration', expiresAt: day('2026-11-01'), reviewStatus: 'approved' },
            { type: 'dot_inspection', expiresAt: day('2026-10-20'), reviewStatus: 'pending' },
            { type: 'other', label: 'Hazmat Endorsement', expiresAt: day('2026-10-25'), reviewStatus: 'approved' },
          ],
        },
        30,
        morning,
      );
      expect(items.map((item) => [item.label, item.daysLeft])).toEqual([
        ['DOT inspection', 7],
        ['Hazmat Endorsement', 12],
        ['vehicle registration', 19],
      ]);
    });
  });
});

describe('loadAttention.service.test.ts', () => {
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
});

describe('loadConditionReport.service.test.ts', () => {
  describe('condition report rules', () => {
    it('accepts only the pickup and delivery stops', () => {
      expect(parseConditionStop('pickup')).toBe('pickup');
      expect(parseConditionStop('delivery')).toBe('delivery');
      expect(() => parseConditionStop('somewhere')).toThrow(/pickup or the delivery/);
    });

    it('accepts only a vehicle that is on the load', () => {
      expect(parseVehicleIndex('1', 2)).toBe(1);
      expect(() => parseVehicleIndex('2', 2)).toThrow(/no longer on this load/);
      expect(() => parseVehicleIndex('-1', 2)).toThrow();
      expect(() => parseVehicleIndex('x', 2)).toThrow();
    });

    it('opens pickup from acceptance until the route starts, and delivery until delivered', () => {
      expect(editableConditionStops('Assigned')).toEqual([]);
      expect(editableConditionStops('Accepted')).toEqual(['pickup']);
      expect(editableConditionStops('Picked Up')).toEqual(['pickup', 'delivery']);
      expect(editableConditionStops('In-Transit')).toEqual(['delivery']);
      expect(editableConditionStops('Delivered')).toEqual([]);
      expect(() => assertConditionStopEditable('pickup', 'In-Transit', 'LD-1')).toThrow(/until you start the route/);
      expect(() => assertConditionStopEditable('delivery', 'Delivered', 'LD-1')).toThrow(/until the load is delivered/);
    });

    it('keeps only known damage areas and kinds, without repeats, and trims the note', () => {
      expect(
        sanitizeConditionDetails({
          damageAreas: ['hood', 'hood', 'spaceship', 'left_front'],
          damageTypes: ['dent', 'explosion'],
          note: `  ${'x'.repeat(1200)}  `,
        }),
      ).toEqual({ damageAreas: ['hood', 'left_front'], damageTypes: ['dent'], note: 'x'.repeat(1000) });
      expect(sanitizeConditionDetails(null)).toEqual({ damageAreas: [], damageTypes: [], note: '' });
    });

    it('needs a name and a drawn PNG signature', () => {
      const png = 'data:image/png;base64,iVBORw0KGgo=';
      expect(parseDeliverySignature({ signerName: ' Pat Customer ', signatureDataUrl: png })).toEqual({
        signerName: 'Pat Customer',
        signatureDataUrl: png,
      });
      expect(() => parseDeliverySignature({ signerName: '', signatureDataUrl: png })).toThrow(/name of the person/);
      expect(() => parseDeliverySignature({ signerName: 'Pat', signatureDataUrl: 'javascript:alert(1)' })).toThrow(
        /sign in the box/,
      );
      expect(() =>
        parseDeliverySignature({ signerName: 'Pat', signatureDataUrl: `data:image/png;base64,${'A'.repeat(300_001)}` }),
      ).toThrow(/too large/);
    });

    it('shows Dispatch photo links, never the storage keys', async () => {
      const load: Record<string, any> = {
        conditionReports: [
          {
            _id: 'r1',
            stop: 'pickup',
            vehicleIndex: 0,
            driverId: 'd1',
            driverName: 'Sam',
            photos: [{ _id: 'p1', key: 'condition-report/a.jpg', uploadedAt: '2026-10-13T10:00:00Z' }],
            damageAreas: ['hood'],
            damageTypes: ['dent'],
            note: 'Small dent',
          },
        ],
      };
      await presentConditionReportsForStaff(load);
      expect(load.conditionReports[0].photos).toEqual([
        // area: the damaged part the photo shows; null for a general photo.
        { id: 'p1', url: 'https://signed.example/condition-report/a.jpg', uploadedAt: '2026-10-13T10:00:00Z', area: null },
      ]);
      expect(JSON.stringify(load)).not.toContain('"key"');
    });

    it('leaves condition reports and the signature drawing out of load lists', () => {
      const load: Record<string, any> = {
        conditionReports: [{ photos: [] }],
        deliverySignature: { signerName: 'Pat', signatureDataUrl: 'data:image/png;base64,AAA', signedAt: 'now' },
      };
      omitConditionReportsFromList(load);
      expect(load).toEqual({ deliverySignature: { signerName: 'Pat', signedAt: 'now' } });
    });
  });
});
