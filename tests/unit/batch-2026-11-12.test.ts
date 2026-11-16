// Tests from the November 12, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

import Load from '../../src/models/Load.model';
import DriverPayout from '../../src/models/DriverPayout.model';
import Quote from '../../src/models/Quote.model';
import { accountDeletionBlocker, anonymizedAccountUpdate, deletableRole, deleteOwnAccount, deletionBlockerMessage, RETENTION_ACKNOWLEDGEMENT_REQUIRED, STAFF_DELETION_MESSAGE } from '../../src/services/accountDeletion.service';
import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import { addressAtPosition, amazonPlacesSettings, placeDetails, placeFields, resetAmazonPlacesForTests, searchPlaces, suggestionsFrom } from '../../src/services/amazonPlaces.service';

describe('accountDeletion.test.ts', () => {
  /**
   * Deleting your own account (2026-11-11): who can, what blocks it, and what a
   * deleted account keeps. Models are stand-ins; no database is used.
   */
  const USER_ID = '64b0000000000000000000d1';

  /** A stand-in for Model.find(...).select(...).limit(...).lean() and its shorter forms. */
  const query = (rows: unknown[]) => {
    const chain: any = {
      select: () => chain,
      limit: () => chain,
      lean: async () => rows,
    };
    return chain;
  };

  afterEach(() => jest.restoreAllMocks());

  describe('who can delete their own account', () => {
    it('drivers and customers; staff are told to ask their dealership', async () => {
      expect(deletableRole('driver')).toBe('driver');
      expect(deletableRole('customer')).toBe('customer');
      for (const role of ['admin', 'employee', 'super_admin', undefined]) expect(deletableRole(role)).toBeNull();

      await expect(deleteOwnAccount({ _id: USER_ID, role: 'admin' })).rejects.toMatchObject({
        statusCode: 403,
        message: STAFF_DELETION_MESSAGE,
      });
      expect(await accountDeletionBlocker({ _id: USER_ID, role: 'employee' })).toBe(STAFF_DELETION_MESSAGE);
    });
  });

  describe('what a deleted account keeps', () => {
    it('nothing to sign in with and nothing that names the person', () => {
      const update = anonymizedAccountUpdate(USER_ID, 'driver');
      expect(update.$set).toMatchObject({
        name: 'Former driver',
        email: `deleted-${USER_ID}@deleted.suprah.invalid`,
        isActive: false,
        isApproved: false,
        emailVerified: false,
        avatar: null,
        pushSubscriptions: [],
      });
      for (const field of ['password', 'passwordHash', 'googleId', 'personalInfo', 'signatureDataUrl', 'passwordResetToken', 'otpCode']) {
        expect(update.$unset).toHaveProperty(field);
      }
      expect(anonymizedAccountUpdate(USER_ID, 'customer').$set.name).toBe('Former customer');
      // An approved staff deletion request (2026-11-12).
      expect(anonymizedAccountUpdate(USER_ID, 'staff').$set.name).toBe('Former staff member');
    });
  });

  describe('what stops a deletion, in plain words', () => {
    it('a driver with a load in progress or a payout not paid yet', () => {
      expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: ['LD-1042'] })).toBe(
        'You have load LD-1042 in progress. Deliver it or ask dispatch to take it back, then you can delete your account.',
      );
      expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: ['LD-1', 'LD-2'] })).toContain('2 loads (LD-1, LD-2)');
      expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: [], unpaidPayouts: 1 })).toContain("payout that hasn't been paid yet");
      expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: [], unpaidPayouts: 0 })).toBeNull();
    });

    it('a customer with a car still being shipped to them', () => {
      expect(deletionBlockerMessage({ role: 'customer', activeShipmentCars: ['2021 Toyota Camry'] })).toBe(
        "Your 2021 Toyota Camry is still being shipped to you. Once it's delivered, you can delete your account.",
      );
      expect(deletionBlockerMessage({ role: 'customer', activeShipmentCars: [] })).toBeNull();
    });

    it("checks the driver's loads and payouts", async () => {
      const find = jest.spyOn(Load, 'find').mockReturnValue(query([{ loadNumber: 'LD-7' }]) as any);
      jest.spyOn(DriverPayout, 'countDocuments').mockResolvedValue(0 as never);
      expect(await accountDeletionBlocker({ _id: USER_ID, role: 'driver' })).toContain('load LD-7 in progress');
      expect(find.mock.calls[0][0]).toMatchObject({ status: { $in: ['Assigned', 'Accepted', 'Picked Up', 'In-Transit'] } });

      find.mockReturnValue(query([]) as any);
      jest.spyOn(DriverPayout, 'countDocuments').mockResolvedValue(2 as never);
      expect(await accountDeletionBlocker({ _id: USER_ID, role: 'driver' })).toContain('payout');
    });

    it("checks the customer's shipments, including staff quotes sent to their email", async () => {
      const quotes = jest.spyOn(Quote, 'find').mockReturnValue(query([{ _id: '64b0000000000000000000a1', vehicleName: '2020 Honda Civic' }]) as any);
      jest.spyOn(Load, 'find').mockReturnValue(query([{ quoteId: '64b0000000000000000000a1' }]) as any);
      expect(await accountDeletionBlocker({ _id: USER_ID, role: 'customer', email: 'Maria@Example.com' })).toContain('Your 2020 Honda Civic is still being shipped');
      expect(JSON.stringify(quotes.mock.calls[0][0])).toContain('maria@example.com');

      jest.spyOn(Load, 'find').mockReturnValue(query([]) as any);
      expect(await accountDeletionBlocker({ _id: USER_ID, role: 'customer', email: 'maria@example.com' })).toBeNull();
    });

    it('refuses the deletion with that message', async () => {
      jest.spyOn(Load, 'find').mockReturnValue(query([{ loadNumber: 'LD-9' }]) as any);
      jest.spyOn(DriverPayout, 'countDocuments').mockResolvedValue(0 as never);
      await expect(deleteOwnAccount({ _id: USER_ID, role: 'driver' }, { acknowledgedRetention: true })).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('acknowledging what Suprah AI keeps (2026-11-11)', () => {
    it('is required before anything is checked or removed', async () => {
      const find = jest.spyOn(Load, 'find');
      for (const acknowledgedRetention of [undefined, false, 'true', 1, {}]) {
        await expect(deleteOwnAccount({ _id: USER_ID, role: 'customer' }, { acknowledgedRetention })).rejects.toMatchObject({
          statusCode: 400,
          message: RETENTION_ACKNOWLEDGEMENT_REQUIRED,
        });
      }
      await expect(deleteOwnAccount({ _id: USER_ID, role: 'driver' })).rejects.toMatchObject({ statusCode: 400 });
      expect(find).not.toHaveBeenCalled();
    });

    it('names the four reasons in plain words', () => {
      expect(RETENTION_ACKNOWLEDGEMENT_REQUIRED).toBe(
        'Before your account can be deleted, confirm that you understand Suprah AI keeps some transaction records and personal information for compliance, accounting, tax laws and fraud prevention.',
      );
    });

    it('staff are still told to ask their dealership first', async () => {
      await expect(deleteOwnAccount({ _id: USER_ID, role: 'employee' }, { acknowledgedRetention: true })).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});

describe('amazonPlaces.test.ts', () => {
  /**
   * Amazon Location places for Create Load's "Pick on map" (2026-11-11).
   * Amazon is never called: the client's send is a stand-in.
   */
  const ON = { enabled: true, region: 'us-west-2', perMinute: 60 };

  const dealership = {
    PlaceId: 'amazon-place-1',
    PlaceType: 'PointOfInterest',
    Title: 'Action Auto Utah',
    Position: [-111.6946, 40.2969],
    Address: {
      Label: 'Action Auto Utah, 100 State St, Orem, UT 84058, United States',
      AddressNumber: '100',
      Street: 'State St',
      Locality: 'Orem',
      Region: { Code: 'UT', Name: 'Utah' },
      PostalCode: '84058',
      Country: { Code2: 'US', Code3: 'USA', Name: 'United States' },
    },
  };

  beforeEach(() => resetAmazonPlacesForTests());
  afterEach(() => jest.restoreAllMocks());

  describe('settings', () => {
    it('is off unless switched on, and uses the route region and cap', () => {
      expect(amazonPlacesSettings({})).toEqual({ enabled: false, region: 'us-west-2', perMinute: 60 });
      expect(amazonPlacesSettings({ AMAZON_LOCATION_PLACES_ENABLED: ' TRUE ', AMAZON_LOCATION_REGION: 'us-east-1', AMAZON_LOCATION_ROUTES_PER_MINUTE: '30' }))
        .toEqual({ enabled: true, region: 'us-east-1', perMinute: 30 });
    });
  });

  describe('reading an Amazon place into the load form', () => {
    it('a business keeps its name; the address, city, state, ZIP and position fill in', () => {
      expect(placeFields(dealership)).toEqual({
        name: 'Action Auto Utah', address: '100 State St', city: 'Orem', state: 'UT', zip: '84058', country: 'US',
        position: { lat: 40.2969, lng: -111.6946 }, exact: true,
      });
    });

    it('a plain street address has no business name; a city alone is not exact', () => {
      expect(placeFields({ ...dealership, PlaceType: 'PointAddress', Title: '100 State St' }).name).toBe('');
      const city = placeFields({ PlaceType: 'Locality', Title: 'Orem, UT', Address: { Locality: 'Orem', Region: { Code: 'UT' } } });
      expect(city).toMatchObject({ address: '', city: 'Orem', state: 'UT', exact: false, position: null });
    });

    it('search suggestions list places only', () => {
      expect(suggestionsFrom([
        { Title: 'Action Auto Utah', SuggestResultItemType: 'Place', Place: { PlaceId: 'amazon-place-1', Address: dealership.Address } },
        { Title: 'action auto', SuggestResultItemType: 'Query' },
        { Title: 'No id', SuggestResultItemType: 'Place', Place: {} },
      ])).toEqual([{ id: 'amazon-place-1', title: 'Action Auto Utah', label: dealership.Address.Label }]);
    });
  });

  describe('asking Amazon', () => {
    it('searches near the map, in the US', async () => {
      const send = jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue({
        ResultItems: [{ Title: 'Action Auto Utah', SuggestResultItemType: 'Place', Place: { PlaceId: 'amazon-place-1' } }],
      } as never);
      expect(await searchPlaces('action auto', { lat: 40.3, lng: -111.7 }, ON)).toEqual([{ id: 'amazon-place-1', title: 'Action Auto Utah', label: '' }]);
      const input = (send.mock.calls[0][0] as any).input;
      expect(input).toMatchObject({ QueryText: 'action auto', BiasPosition: [-111.7, 40.3], Filter: { IncludeCountries: ['USA'] } });
    });

    it('asks for places and addresses that are saved on a load with the "Storage" use', async () => {
      const send = jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue(dealership as never);
      expect((await placeDetails('amazon-place-1', ON))?.name).toBe('Action Auto Utah');
      expect((send.mock.calls[0][0] as any).input).toMatchObject({ PlaceId: 'amazon-place-1', IntendedUse: 'Storage' });

      send.mockResolvedValue({ ResultItems: [{ ...dealership, PlaceType: 'PointAddress' }] } as never);
      expect(await addressAtPosition(40.2969, -111.6946, ON)).toMatchObject({ address: '100 State St', city: 'Orem', zip: '84058' });
      expect((send.mock.calls[1][0] as any).input).toMatchObject({ QueryPosition: [-111.6946, 40.2969], IntendedUse: 'Storage' });

      send.mockResolvedValue({ ResultItems: [] } as never);
      expect(await addressAtPosition(0, 0, ON)).toBeNull();
    });

    it('a failure or the safety cap gives a plain message', async () => {
      jest.spyOn(GeoPlacesClient.prototype, 'send').mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }) as never);
      await expect(searchPlaces('x', null, ON)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('Click the map') });

      resetAmazonPlacesForTests();
      jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue({ ResultItems: [] } as never);
      const tight = { ...ON, perMinute: 1 };
      await searchPlaces('a', null, tight);
      await expect(searchPlaces('b', null, tight)).rejects.toMatchObject({ statusCode: 429 });
    });
  });
});
