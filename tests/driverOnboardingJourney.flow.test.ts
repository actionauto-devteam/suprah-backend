/**
 * Driver onboarding journey — one new driver, start to finish, through the
 * real endpoints:
 *   sign up → verify email → wait for approval → super admin approves
 *   → Dispatch sees and assigns them → accept → arrive → pickup proof
 *   → In-Transit → arrive → delivery proof → Delivered → Dispatch confirms
 *   → the load board asks for trailer capacity, then lets them request.
 *
 * Data safety (same as load-flow): every record is created under this suite's
 * own organization and users and removed afterwards; file storage is stubbed.
 */

import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Load from '../src/models/Load.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import DriverRequest from '../src/models/DriverRequest.model';
import DriverReviewEvent from '../src/models/DriverReviewEvent.model';
import DriverLocation from '../src/models/DriverLocation.model';
import Notification from '../src/models/Notification.model';
import tokenService from '../src/services/token.service';
import { storageService } from '../src/services/storage.service';
import { setLifecycleOutboxRequestFlushMode } from '../src/services/loadLifecycleOutbox.service';
import * as socketEmitter from '../src/utils/socketEmitter';

const TEST_ORG_SLUG = 'onboarding-journey-test-org';
const TEST_EMAIL_DOMAIN = '@onboarding-journey-test.com';
const DRIVER_EMAIL = `new-driver${TEST_EMAIL_DOMAIN}`;

// Smallest valid PNG, so upload content validation (magic bytes) passes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const signatureFor = (signerName: string) => ({ agreedToTerms: true, signatureDataUrl: PNG_DATA_URL, signerName });

let org: any;
let dispatcher: any;
let dispatcherToken: string;
let superAdminToken: string;
let driverId: string;
let driverToken: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const reload = (id: unknown) => Load.findById(id);

async function seedLoad(overrides: Record<string, unknown> = {}) {
  return Load.create({
    organizationId: org._id,
    createdBy: dispatcher._id,
    postType: 'assign-carrier',
    status: 'Posted',
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    additionalInfo: { visibility: 'private' },
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
    contract: { agreedToTerms: true, signatureDataUrl: PNG_DATA_URL, signerName: 'Dispatcher' },
    ...overrides,
  });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  setLifecycleOutboxRequestFlushMode('inline');
  jest.spyOn(storageService, 'upload').mockImplementation(async (_file: any, prefix?: string) => `${prefix || 'test'}/journey.png`);
  jest.spyOn(storageService, 'getSignedUrl').mockResolvedValue('https://signed.example/journey.png');
  jest.spyOn(storageService, 'delete').mockResolvedValue(undefined as any);
  jest.spyOn(socketEmitter, 'emitDriverPoolChange').mockImplementation(() => {});

  const oldOrgs = await Organization.find({ slug: TEST_ORG_SLUG }).select('_id');
  await Load.deleteMany({ organizationId: { $in: oldOrgs.map((o) => o._id) } });
  const oldUsers = await User.find({ email: { $regex: /@onboarding-journey-test\.com$/ } }).select('_id');
  await DriverRequest.deleteMany({ driverUserId: { $in: oldUsers.map((u) => u._id) } });
  await DriverProfile.deleteMany({ userId: { $in: oldUsers.map((u) => u._id) } });
  await User.deleteMany({ _id: { $in: oldUsers.map((u) => u._id) } });
  await Organization.deleteMany({ _id: { $in: oldOrgs.map((o) => o._id) } });

  org = await Organization.create({ name: 'Onboarding Journey Test Org', slug: TEST_ORG_SLUG, status: 'active' });
  dispatcher = await User.create({
    email: `dispatcher${TEST_EMAIL_DOMAIN}`,
    name: 'Dispatcher',
    role: 'admin',
    organizationId: org._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  const superAdmin = await User.create({
    email: `superadmin${TEST_EMAIL_DOMAIN}`,
    name: 'Suprah Super Admin',
    role: 'super_admin',
    organizationId: org._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  dispatcherToken = tokenService.generateAccessToken(dispatcher);
  superAdminToken = tokenService.generateAccessToken(superAdmin);
}, 60000);

afterAll(async () => {
  jest.restoreAllMocks();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const users = await User.find({ email: { $regex: /@onboarding-journey-test\.com$/ } }).select('_id');
  const userIds = users.map((u) => u._id);
  await Load.deleteMany({ organizationId: org?._id });
  await Notification.deleteMany({ userId: { $in: userIds } });
  await DriverReviewEvent.deleteMany({ driverId: { $in: userIds } });
  await DriverLocation.deleteMany({ userId: { $in: userIds } });
  await DriverRequest.deleteMany({ driverUserId: { $in: userIds } });
  await DriverProfile.deleteMany({ userId: { $in: userIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await Organization.deleteMany({ _id: org?._id });
  await mongoose.disconnect();
});

describe('A new driver signs up, is approved and completes a load', () => {
  it('signs up as a driver and verifies their email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'New Driver', email: DRIVER_EMAIL, password: 'Journey-Passw0rd!', role: 'driver' })
      .expect((res) => expect([200, 201]).toContain(res.status));

    const created: any = await User.findOne({ email: DRIVER_EMAIL }).select('+otpCode');
    expect(created).toMatchObject({ role: 'driver', isApproved: false });
    driverId = String(created._id);

    const verified = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: DRIVER_EMAIL, otp: created.otpCode })
      .expect(200);
    driverToken = verified.body.data.accessToken;
    expect(driverToken).toBeTruthy();
  });

  it('waits for approval: the application exists and load work is refused', async () => {
    const status = await request(app).get('/api/driver-requests/my-status').set(auth(driverToken)).expect(200);
    expect(status.body.data.status).toBe('pending');
    const refused = await request(app).get('/api/driver-tracking/my-loads').set(auth(driverToken)).expect(403);
    expect(refused.body.message).toMatch(/pending approval/);
  });

  it('submits the application with only what the form asks for', async () => {
    // Pressing Submit too early says what's missing, in plain words.
    const early = await request(app)
      .patch('/api/driver-profile/identity-verification')
      .set(auth(driverToken))
      .send({ ssnLast4: '1234', backgroundCheckConsent: true, verificationAgreement: true })
      .expect(400);
    expect(early.body.message).toBe(
      "Your application can't be submitted yet. Please add a photo of your CDL, CDL number, license state, CDL expiration date.",
    );

    // Documents step: the CDL only. Compliance step: no insurance and no VIN.
    await request(app)
      .post('/api/driver-profile/documents')
      .set(auth(driverToken))
      .field('type', 'drivers_license')
      .field('label', 'CDL')
      .field('expiresAt', '2030-01-31')
      .attach('document', PNG, 'cdl.png')
      .expect(200);
    await request(app)
      .patch('/api/driver-profile/compliance')
      .set(auth(driverToken))
      .send({ driversLicenseNumber: 'DL-12345678', licenseState: 'UT', licenseExpirationDate: '2030-01-31', insuranceProvider: '', insurancePolicyNumber: '' })
      .expect(200);

    // Agreement step: Submit goes through, with the name taken from the account.
    await request(app)
      .patch('/api/driver-profile/identity-verification')
      .set(auth(driverToken))
      .send({ ssnLast4: '1234', backgroundCheckConsent: true, verificationAgreement: true })
      .expect(200);
    const profile: any = await DriverProfile.findOne({ userId: driverId });
    expect(profile).toMatchObject({ verificationStatus: 'under_review', firstName: 'New', lastName: 'Driver' });

    // Signing in again waits for approval; the open session keeps working.
    await request(app).post('/api/auth/login').send({ email: DRIVER_EMAIL, password: 'Journey-Passw0rd!' }).expect(403);
    await request(app).get('/api/driver-requests/my-status').set(auth(driverToken)).expect(200);
  });

  it('a super admin approves right away, and the driver can work immediately', async () => {
    const application: any = await DriverRequest.findOne({ driverUserId: driverId, status: 'pending' });
    expect(application).toBeTruthy();
    await request(app)
      .patch(`/api/driver-requests/${application._id}/approve`)
      .set(auth(superAdminToken))
      .send({})
      .expect(200);

    // The "waiting for approval" page sees the approval and opens the driver
    // portal; its first requests must not still be refused.
    const status = await request(app).get('/api/driver-requests/my-status').set(auth(driverToken)).expect(200);
    expect(status.body.data.status).toBe('approved');
    await request(app).get('/api/driver-tracking/my-loads').set(auth(driverToken)).expect(200);
    const me = await request(app).get('/api/users/me').set(auth(driverToken)).expect(200);
    expect(me.body.data).toMatchObject({ role: 'driver', isApproved: true });

    // Told in the app (the email is sent through the stubbed email service).
    expect(await Notification.countDocuments({ userId: driverId })).toBeGreaterThan(0);
  });

  it('Dispatch sees the new driver as assignable', async () => {
    const res = await request(app)
      .get('/api/driver-tracking/org-drivers')
      .query({ scope: 'assignable' })
      .set(auth(dispatcherToken))
      .expect(200);
    const entry = res.body.data.drivers.find((d: any) => d.id === driverId);
    expect(entry).toMatchObject({ accountApproved: true, assignable: true });
  });

  let load: any;

  it('assigning asks Dispatch to confirm capacity until the driver sets it, then assigns', async () => {
    // A new driver's trailer counts as carrying 1 vehicle until they set it up.
    load = await seedLoad({
      vehicles: [
        { year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' },
        { year: 2019, make: 'Honda', model: 'Civic', condition: 'Operable' },
      ],
    });
    const ask = await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId })
      .expect(409);
    expect(ask.body.message).toMatch(/requires 2 vehicles/);

    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId, overrideCapacity: true })
      .expect(200);
    expect((await reload(load._id))!.status).toBe('Assigned');
  });

  it('the driver accepts and completes the whole trip, and Dispatch confirms', async () => {
    const driverPost = (path: string) =>
      request(app).post(`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(driverToken));

    await driverPost('accept').send(signatureFor('New Driver')).expect(200);
    expect((await reload(load._id))!.status).toBe('Accepted');

    await driverPost('arrive').send({ stop: 'pickup' }).expect(200);
    await driverPost('submit-pickup-proof').attach('proof', PNG, 'pickup.png').expect(200);
    await driverPost('pickup').expect(200);
    expect((await reload(load._id))!.status).toBe('Picked Up');

    await driverPost('start-route').expect(200);
    expect((await reload(load._id))!.status).toBe('In-Transit');

    await driverPost('arrive').send({ stop: 'delivery' }).expect(200);
    await driverPost('submit-proof').attach('proof', PNG, 'pod.png').expect(200);
    await driverPost('deliver').expect(200);
    expect((await reload(load._id))!.status).toBe('Delivered');

    await request(app).post(`/api/loads/${load._id}/confirm-delivery`).set(auth(dispatcherToken)).expect(200);
    const confirmed: any = await reload(load._id);
    expect(confirmed.proofOfDelivery.confirmedAt).toBeDefined();
    expect(String(confirmed.assignedDriverId)).toBe(driverId);
  });

  // The application doesn't ask for equipment, so a new driver's capacity is
  // the profile default (1 vehicle) until they set it under Equipment.
  it('a 2-car load on the load board waits until the driver sets up their trailer', async () => {
    const before = await request(app).get('/api/driver-tracking/dashboard-stats').set(auth(driverToken)).expect(200);
    expect(before.body.data.trailerSetUp).toBe(false);

    const boardLoad = await seedLoad({
      postType: 'load-board',
      additionalInfo: { visibility: 'public' },
      vehicles: [
        { year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' },
        { year: 2019, make: 'Honda', model: 'Civic', condition: 'Operable' },
      ],
    });
    const blocked = await request(app)
      .post(`/api/driver-tracking/loads/${boardLoad._id}/request`)
      .set(auth(driverToken))
      .send(signatureFor('New Driver'))
      .expect(409);
    expect(blocked.body.message).toMatch(/^Set up your trailer first\. On the Equipment page/);

    await request(app)
      .patch('/api/driver-profile/equipment')
      .set(auth(driverToken))
      .send({ trailerType: 'open_2car', maxVehicleCapacity: 2 })
      .expect(200);

    const after = await request(app).get('/api/driver-tracking/dashboard-stats').set(auth(driverToken)).expect(200);
    expect(after.body.data.trailerSetUp).toBe(true);

    await request(app)
      .post(`/api/driver-tracking/loads/${boardLoad._id}/request`)
      .set(auth(driverToken))
      .send(signatureFor('New Driver'))
      .expect(200);
  });

  it('a set-up trailer that is too small gets a plain reason naming its size', async () => {
    const bigLoad = await seedLoad({
      postType: 'load-board',
      additionalInfo: { visibility: 'public' },
      vehicles: [
        { year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' },
        { year: 2019, make: 'Honda', model: 'Civic', condition: 'Operable' },
        { year: 2021, make: 'Ford', model: 'Focus', condition: 'Operable' },
      ],
    });
    const res = await request(app)
      .post(`/api/driver-tracking/loads/${bigLoad._id}/request`)
      .set(auth(driverToken))
      .send(signatureFor('New Driver'))
      .expect(409);
    expect(res.body.message).toBe(
      'This load has 3 vehicles, but your trailer is set to carry 2. If your trailer can carry more, update it on the Equipment page, then request this load again.',
    );
  });
});

describe('Starting an application while waiting for approval', () => {
  it('a pending driver without an application can start one, only once', async () => {
    const user = await User.create({
      email: `no-application${TEST_EMAIL_DOMAIN}`,
      name: 'No Application',
      role: 'driver',
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
      isApproved: false,
    });
    const token = tokenService.generateAccessToken(user as any);
    const before = await request(app).get('/api/driver-requests/my-status').set(auth(token)).expect(200);
    expect(before.body.data.status).toBe('no-request');

    await request(app).post('/api/driver-requests').set(auth(token)).send({}).expect(201);
    await request(app).post('/api/driver-requests').set(auth(token)).send({}).expect(400);
    expect(await DriverRequest.countDocuments({ driverUserId: user._id, status: 'pending' })).toBe(1);

    // Everything else still waits for approval.
    await request(app).get('/api/driver-tracking/my-loads').set(auth(token)).expect(403);
  });
});
