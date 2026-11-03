/**
 * A customer who listed a car for sale is told when the dealership approves
 * or rejects it, in plain English, with the reason when it wasn't approved.
 * Models and notifications are stand-ins; no database is used.
 */
const mockCreateNotification = jest.fn();
const mockOrgFindById = jest.fn();
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: (id: unknown) => ({ select: () => ({ lean: () => Promise.resolve(mockOrgFindById(id)) }) }) },
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { auctionListingNotice, listingVehicleName, notifyListingSeller } from '../../src/services/auctionListingNotice';

const ORG = '64b0000000000000000000a5';
const SELLER = '64b0000000000000000000b5';
const LISTING = '64b0000000000000000000c5';

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgFindById.mockReturnValue({ name: 'Action Auto Utah' });
  mockCreateNotification.mockResolvedValue(undefined);
});

it('says what happened and what to do next', () => {
  expect(auctionListingNotice('approved', { vehicleName: '2019 Honda Civic', dealerName: 'Action Auto Utah' })).toEqual({
    title: 'Your Listing Was Approved',
    message: "Action Auto Utah approved your listing for the 2019 Honda Civic. They'll contact you to arrange the next steps.",
  });
  expect(auctionListingNotice('rejected', { vehicleName: '2019 Honda Civic', dealerName: 'Action Auto Utah', reason: 'Photos are too dark.' })).toEqual({
    title: "Your Listing Wasn't Approved",
    message: "Action Auto Utah didn't approve your listing for the 2019 Honda Civic. Reason: Photos are too dark. You can update it and send it again from Auction.",
  });
  expect(auctionListingNotice('rejected', {}).message).toBe("The dealership didn't approve your listing for your car. You can update it and send it again from Auction.");
});

it("names the listing's car", () => {
  expect(listingVehicleName({ year: '2019', make: 'Honda', model: ' Civic ' })).toBe('2019 Honda Civic');
  expect(listingVehicleName({})).toBe('');
});

it('tells the customer who listed the car, opening their listing', async () => {
  await notifyListingSeller({ _id: LISTING, userId: { _id: SELLER }, year: '2019', make: 'Honda', model: 'Civic', rejectionReason: 'Photos are too dark' }, 'rejected', ORG);
  expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
    userId: SELLER,
    organizationId: ORG,
    type: 'general',
    title: "Your Listing Wasn't Approved",
    metadata: expect.objectContaining({ listingId: LISTING, route: `/customer/auction/${LISTING}` }),
  }));
});

it("never fails the decision, and skips a listing without a customer", async () => {
  expect(await notifyListingSeller({ _id: LISTING, userId: 'nope' }, 'approved', ORG)).toBe(false);
  mockCreateNotification.mockRejectedValueOnce(new Error('down'));
  expect(await notifyListingSeller({ _id: LISTING, userId: SELLER }, 'approved', ORG)).toBe(false);
});
