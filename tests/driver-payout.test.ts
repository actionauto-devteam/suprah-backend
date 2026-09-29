/**
 * Driver payouts — only confirmed deliveries, one payout per load, staff-only
 * reads. Stripe is replaced with a stand-in: no money moves and no network
 * calls are made.
 */
import request from 'supertest';
import mongoose from 'mongoose';

const transfersCreate = jest.fn();
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    transfers: { create: (...args: unknown[]) => transfersCreate(...args) },
    accounts: { create: jest.fn(), retrieve: jest.fn(), createLoginLink: jest.fn() },
    accountLinks: { create: jest.fn() },
  })),
);

import app from '../src/server';
import Load from '../src/models/Load.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverPayout from '../src/models/DriverPayout.model';
import Notification from '../src/models/Notification.model';
import tokenService from '../src/services/token.service';

const SLUG = 'driver-payout-test-org';
const DOMAIN = '@driver-payout-test.com';

let org: any;
let admin: any;
let driver: any;
let adminToken: string;
let driverToken: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function deliveredLoad(confirmed: boolean) {
  return Load.create({
    organizationId: org._id,
    createdBy: admin._id,
    postType: 'load-board',
    status: 'Delivered',
    assignedDriverId: driver._id,
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
    proofOfDelivery: {
      imageUrl: 'test/pod.png',
      submittedBy: driver._id,
      submittedAt: new Date(),
      ...(confirmed ? { confirmedAt: new Date(), confirmedBy: admin._id } : {}),
    },
  });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const oldOrg = await Organization.findOne({ slug: SLUG });
  if (oldOrg) {
    await Load.deleteMany({ organizationId: oldOrg._id });
    await DriverPayout.deleteMany({ organizationId: String(oldOrg._id) });
    await Organization.deleteOne({ _id: oldOrg._id });
  }
  await User.deleteMany({ email: { $regex: /@driver-payout-test\.com$/ } });

  org = await Organization.create({ name: 'Driver Payout Test Org', slug: SLUG, status: 'active' });
  admin = await User.create({
    email: `admin${DOMAIN}`, name: 'Payout Admin', role: 'admin', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  driver = await User.create({
    email: `driver${DOMAIN}`, name: 'Payout Driver', role: 'driver', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true,
    stripeConnectAccountId: 'acct_test_payout',
  });
  adminToken = tokenService.generateAccessToken(admin);
  driverToken = tokenService.generateAccessToken(driver);
}, 60000);

afterEach(() => {
  transfersCreate.mockReset();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const users = await User.find({ email: { $regex: /@driver-payout-test\.com$/ } }).select('_id');
  await Notification.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await Load.deleteMany({ organizationId: org?._id });
  await DriverPayout.deleteMany({ organizationId: String(org?._id) });
  await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  await Organization.deleteMany({ _id: org?._id });
  await mongoose.disconnect();
});

describe('Driver payouts', () => {
  it('a delivery Dispatch has not confirmed yet cannot be paid', async () => {
    const load = await deliveredLoad(false);
    const res = await request(app)
      .post('/api/driver-payouts')
      .set(auth(adminToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), amount: 500 })
      .expect(409);
    expect(res.body.message).toMatch(/Confirm the driver's proof-of-delivery photo first/);
    expect(transfersCreate).not.toHaveBeenCalled();

    const ready = await request(app).get('/api/driver-payouts/deliverable').set(auth(adminToken)).expect(200);
    expect(ready.body.data.some((item: any) => String(item._id) === String(load._id))).toBe(false);
  });

  it('two payouts for the same load at once send money only once', async () => {
    const load = await deliveredLoad(true);
    transfersCreate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { id: 'tr_test_once' };
    });
    const pay = () =>
      request(app)
        .post('/api/driver-payouts')
        .set(auth(adminToken))
        .send({ loadId: String(load._id), driverId: String(driver._id), amount: 500 });

    const [first, second] = await Promise.all([pay(), pay()]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(transfersCreate).toHaveBeenCalledTimes(1);
    expect(transfersCreate.mock.calls[0][1]).toEqual({ idempotencyKey: expect.stringMatching(/^driver-payout-/) });
    expect(await DriverPayout.countDocuments({ loadId: load._id, status: 'paid' })).toBe(1);

    // Later attempts see it was already paid.
    const again = await pay().expect(400);
    expect(again.body.message).toMatch(/already/);
    expect(transfersCreate).toHaveBeenCalledTimes(1);
  });

  it('a failed transfer can be retried', async () => {
    const load = await deliveredLoad(true);
    transfersCreate.mockRejectedValueOnce(new Error('card declined')).mockResolvedValueOnce({ id: 'tr_test_retry' });
    const pay = () =>
      request(app)
        .post('/api/driver-payouts')
        .set(auth(adminToken))
        .send({ loadId: String(load._id), driverId: String(driver._id), amount: 300 });
    await pay().expect(402);
    await pay().expect(201);
    expect(await DriverPayout.countDocuments({ loadId: load._id, status: 'paid' })).toBe(1);
  });

  it('only staff can see payouts', async () => {
    await request(app).get('/api/driver-payouts').set(auth(driverToken)).expect(403);
    await request(app).get('/api/driver-payouts/deliverable').set(auth(driverToken)).expect(403);
    await request(app).get('/api/driver-payouts/stats').set(auth(driverToken)).expect(403);
    await request(app).get('/api/driver-payouts').set(auth(adminToken)).expect(200);
    await request(app).get('/api/driver-payouts/my-payouts').set(auth(driverToken)).expect(200);
  });
});
