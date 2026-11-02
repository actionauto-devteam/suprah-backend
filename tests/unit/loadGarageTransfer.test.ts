/**
 * "Add to customer's garage" on a delivered load: only for a customer's own
 * portal request, never for a customer of another dealership, and it does
 * what Garage Review's transfer does (garage entry, Sold and locked, transfer
 * record), telling the customer once. Models are stand-ins; no database is used.
 */
const mockQuoteFindOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockVehicleFindOne = jest.fn();
const mockCrmFindOne = jest.fn();
const mockOwnedFindOne = jest.fn();
const mockOwnedExists = jest.fn();
const mockOwnedCreate = jest.fn();
const mockTransferCreate = jest.fn();
const mockNotify = jest.fn();
const mockEmit = jest.fn();

const lean = (result: () => unknown) => {
  const self: any = { select: () => self, lean: () => Promise.resolve(result()) };
  return self;
};

jest.mock('../../src/models/Quote.model', () => ({ __esModule: true, default: { findOne: (f: unknown) => lean(() => mockQuoteFindOne(f)) } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: (f: unknown) => lean(() => mockUserFindOne(f)) } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findOne: (f: unknown) => lean(() => mockCrmFindOne(f)) } }));
jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: { findOne: (f: unknown) => Promise.resolve(mockVehicleFindOne(f)) } }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: () => lean(() => ({ name: 'Action Auto' })) } }));
jest.mock('../../src/models/OwnedVehicle.model', () => ({
  OwnedVehicle: {
    findOne: (f: unknown) => Promise.resolve(mockOwnedFindOne(f)),
    exists: (f: unknown) => Promise.resolve(mockOwnedExists(f)),
    create: (d: unknown) => mockOwnedCreate(d),
  },
}));
jest.mock('../../src/models/GarageTransfer.model', () => ({ __esModule: true, default: { create: (d: unknown) => Promise.resolve(mockTransferCreate(d)) } }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: { createNotification: (n: unknown) => mockNotify(n) } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: jest.fn(() => Promise.resolve()) } }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: (...args: unknown[]) => mockEmit(...args) }));

import { addLoadCarToGarage, loadGarageState, MY_GARAGE_ROUTE } from '../../src/services/loadGarageTransfer.service';

const ORG = '64b0000000000000000000a1';
const OTHER_ORG = '64b0000000000000000000a2';
const QUOTE = '64b0000000000000000000b1';
const CAR = '64b0000000000000000000c1';
const CUSTOMER = '64b0000000000000000000d1';
const STAFF = { _id: '64b0000000000000000000e1', name: 'Jovi Staff', email: 'Staff@Example.com' };

const deliveredLoad = (extra: Record<string, unknown> = {}) => ({
  _id: 'load-1', loadNumber: 'LD-9', status: 'Delivered', quoteId: QUOTE, vehicles: [{ vehicleId: CAR }], ...extra,
});
let car: any;

beforeEach(() => {
  jest.clearAllMocks();
  car = { _id: CAR, vin: '1HGCM82633A123456', year: 2021, make: 'Toyota', modelName: 'Camry', mileage: 120, images: ['a.jpg', ''], status: 'Ready for Sale', save: jest.fn() };
  mockQuoteFindOne.mockReturnValue({ _id: QUOTE, vehicleId: CAR, requestedBy: CUSTOMER });
  mockUserFindOne.mockReturnValue({ _id: CUSTOMER, name: 'Maria Santos', email: 'maria@example.com', organizationId: null });
  mockVehicleFindOne.mockImplementation(() => car);
  mockOwnedFindOne.mockReturnValue(null);
  mockOwnedExists.mockReturnValue(null);
  mockOwnedCreate.mockImplementation((doc: any) => Promise.resolve({ _id: 'owned-1', ...doc }));
  mockTransferCreate.mockImplementation((doc: any) => ({ _id: 'transfer-1', ...doc }));
  mockCrmFindOne.mockReturnValue({ _id: 'crm-1', fullName: 'Jovi CRM' });
});

describe('whether the load page offers the button', () => {
  it("offers it for a delivered customer request whose car is in Inventory", async () => {
    expect(await loadGarageState(ORG, deliveredLoad())).toEqual({ state: 'available', customerName: 'Maria Santos', vehicleLabel: '2021 Toyota Camry' });
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE, organizationId: ORG, source: 'customer_portal' });
    expect(mockUserFindOne).toHaveBeenCalledWith({ _id: CUSTOMER, role: 'customer' });
    expect(mockVehicleFindOne).toHaveBeenCalledWith({ _id: CAR, organizationId: ORG, isDeleted: { $ne: true } });
  });

  it('shows nothing for loads that are not delivered customer requests', async () => {
    expect(await loadGarageState(ORG, deliveredLoad({ status: 'In-Transit' }))).toBeNull();
    expect(await loadGarageState(ORG, deliveredLoad({ quoteId: undefined }))).toBeNull();
    mockQuoteFindOne.mockReturnValueOnce(null); // a staff quote, or another dealership's quote
    expect(await loadGarageState(ORG, deliveredLoad())).toBeNull();
    mockUserFindOne.mockReturnValueOnce(null); // the customer account is gone
    expect(await loadGarageState(ORG, deliveredLoad())).toBeNull();
  });

  it('explains instead of offering it for another dealership, a car not in Inventory, or one already added', async () => {
    mockUserFindOne.mockReturnValueOnce({ _id: CUSTOMER, name: 'Maria Santos', organizationId: OTHER_ORG });
    expect((await loadGarageState(ORG, deliveredLoad()))?.state).toBe('other_dealership');
    mockVehicleFindOne.mockImplementationOnce(() => null);
    expect(await loadGarageState(ORG, deliveredLoad())).toEqual({ state: 'no_inventory_car', customerName: 'Maria Santos' });
    mockOwnedExists.mockReturnValueOnce({ _id: 'owned-1' });
    expect((await loadGarageState(ORG, deliveredLoad()))?.state).toBe('done');
  });
});

describe('adding the car to the garage', () => {
  it("does what Garage Review does and tells the customer", async () => {
    const result = await addLoadCarToGarage(ORG, deliveredLoad(), STAFF);
    expect(result).toEqual({ alreadyInGarage: false, vehicleMarkedSold: true, customerName: 'Maria Santos', vehicleLabel: '2021 Toyota Camry' });
    expect(mockOwnedCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: CUSTOMER, vin: car.vin, make: 'Toyota', model: 'Camry', year: '2021', currentMileage: 120, images: ['a.jpg'],
      status: 'ACTIVE', source: 'DEALERSHIP_TRANSFER', dealershipName: 'Action Auto',
    }));
    expect(car).toMatchObject({ status: 'Sold', manualStatusLock: true });
    expect(car.save).toHaveBeenCalled();
    expect(mockCrmFindOne).toHaveBeenCalledWith({ email: 'staff@example.com', organizationId: ORG });
    expect(mockTransferCreate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG, vehicleId: CAR, customerId: CUSTOMER, vehicleMarkedSold: true, performedBy: 'crm-1', performedByName: 'Jovi CRM', status: 'transferred',
    }));
    expect(mockEmit).toHaveBeenCalledWith(ORG, 'garage:vehicle_transferred', expect.objectContaining({ vehicleId: CAR, status: 'transferred' }));
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: CUSTOMER, type: 'vehicle_added', title: 'Added to My Garage',
      message: 'Action Auto added your 2021 Toyota Camry to My Garage.', metadata: { vehicleId: CAR, route: MY_GARAGE_ROUTE },
    }));
  });

  it("doesn't tell the customer twice or mark a Sold car again", async () => {
    Object.assign(car, { status: 'Sold', manualStatusLock: true });
    mockOwnedFindOne.mockReturnValue({ _id: 'owned-1', status: 'ACTIVE', currentMileage: 200, images: ['x.jpg'], save: jest.fn() });
    const result = await addLoadCarToGarage(ORG, deliveredLoad(), STAFF);
    expect(result).toMatchObject({ alreadyInGarage: true, vehicleMarkedSold: false });
    expect(car.save).not.toHaveBeenCalled();
    expect(mockOwnedCreate).not.toHaveBeenCalled();
    expect(mockTransferCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'already_in_garage' }));
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('locks a car already marked Sold at delivery, so the feed keeps it Sold', async () => {
    const soldAt = new Date('2026-11-01T10:00:00Z');
    Object.assign(car, { status: 'Sold', dateSold: soldAt });
    const result = await addLoadCarToGarage(ORG, deliveredLoad(), STAFF);
    expect(result).toMatchObject({ vehicleMarkedSold: false });
    expect(car).toMatchObject({ status: 'Sold', manualStatusLock: true, dateSold: soldAt });
    expect(car.save).toHaveBeenCalled();
  });

  it('copes with two taps at the same moment', async () => {
    mockOwnedCreate.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })));
    mockOwnedFindOne.mockReturnValueOnce(null).mockReturnValueOnce({ _id: 'owned-1', status: 'ACTIVE' });
    await expect(addLoadCarToGarage(ORG, deliveredLoad(), STAFF)).resolves.toMatchObject({ vehicleMarkedSold: true });
    expect(mockTransferCreate).toHaveBeenCalledWith(expect.objectContaining({ ownedVehicleId: 'owned-1' }));
  });

  it('credits the staff member when they have no CRM account', async () => {
    mockCrmFindOne.mockReturnValueOnce(null);
    await addLoadCarToGarage(ORG, deliveredLoad(), STAFF);
    expect(mockTransferCreate).toHaveBeenCalledWith(expect.objectContaining({ performedBy: STAFF._id, performedByName: 'Jovi Staff' }));
  });

  it('refuses with a plain reason when it does not apply', async () => {
    await expect(addLoadCarToGarage(ORG, deliveredLoad({ status: 'Picked Up' }), STAFF)).rejects.toMatchObject({ statusCode: 400 });
    mockUserFindOne.mockReturnValueOnce({ _id: CUSTOMER, name: 'Maria Santos', organizationId: OTHER_ORG });
    await expect(addLoadCarToGarage(ORG, deliveredLoad(), STAFF)).rejects.toMatchObject({
      statusCode: 403,
      message: "Maria Santos is registered with another dealership, so this car can't be added to their garage from here.",
    });
    mockVehicleFindOne.mockImplementationOnce(() => null);
    await expect(addLoadCarToGarage(ORG, deliveredLoad(), STAFF)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockOwnedCreate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('still succeeds when the customer notice fails', async () => {
    mockNotify.mockRejectedValueOnce(new Error('down'));
    await expect(addLoadCarToGarage(ORG, deliveredLoad(), STAFF)).resolves.toMatchObject({ alreadyInGarage: false });
  });
});
