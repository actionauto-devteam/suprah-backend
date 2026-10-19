/**
 * New-load alerts — through the real endpoints:
 *   Dispatch posts a public load → drivers who can request it are told
 *   ("New Load You Can Request", or "Check Before Requesting" with the reasons),
 *   drivers who can't request it are not, private loads stay quiet until they're
 *   made public, and each load is announced only once.
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
import Notification from '../src/models/Notification.model';
import tokenService from '../src/services/token.service';
import logger from '../src/utils/logger';
import { storageService } from '../src/services/storage.service';
import { setLifecycleOutboxRequestFlushMode } from '../src/services/loadLifecycleOutbox.service';
import { invalidateActiveOrganizations } from '../src/services/activeOrganizations.service';
import { announceNewBoardLoad } from '../src/services/newLoadAlert.service';
import * as commitments from '../src/services/driverWorkCommitment.service';
import * as socketEmitter from '../src/utils/socketEmitter';

const TEST_ORG_SLUG = 'new-load-alerts-test-org';
const TEST_EMAIL_DOMAIN = '@new-load-alerts-test.com';
const ALERT_TYPES = ['new_load_available', 'new_load_check_first'];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const signatureFor = (signerName: string) => ({ agreedToTerms: true, signatureDataUrl: PNG_DATA_URL, signerName });

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// A pickup two weeks out, as the date picker sends it (YYYY-MM-DD).
const pickupDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 14));
const PICKUP = pickupDate.toISOString().slice(0, 10);
const PICKUP_DAY = WEEKDAYS[pickupDate.getUTCDay()];
const OTHER_DAY = WEEKDAYS[(pickupDate.getUTCDay() + 1) % 7];

let org: any;
let dispatcher: any;
let dispatcherToken: string;
const drivers: Record<string, { id: string; token: string }> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const currentVersion = async (id: unknown) =>
  ((await Load.findById(id).select('updatedAt').lean()) as any).updatedAt.toISOString();
const alertsFor = (label: string, loadId: unknown) =>
  Notification.find({ userId: drivers[label].id, type: { $in: ALERT_TYPES }, 'metadata.loadId': String(loadId) }).lean();

async function createDriver(label: string, profile: Record<string, unknown>, account: Record<string, unknown> = {}) {
  const user = await User.create({
    email: `${label}${TEST_EMAIL_DOMAIN}`,
    name: `Driver ${label}`,
    role: 'driver',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
    ...account,
  });
  await DriverProfile.create({
    userId: user._id,
    operationalStatus: 'active',
    verificationStatus: 'verified',
    trailerType: 'open_2car',
    maxVehicleCapacity: 2,
    availableDays: [PICKUP_DAY],
    ...profile,
  });
  drivers[label] = { id: String(user._id), token: tokenService.generateAccessToken(user as any) };
}

const boardLoad = (visibility: 'public' | 'private') => ({
  postType: 'load-board',
  pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
  deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
  vehicles: [
    { year: 2021, make: 'Honda', model: 'Civic', condition: 'Operable' },
    { year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' },
  ],
  trailerType: 'open_2car',
  dates: { firstAvailable: PICKUP },
  additionalInfo: { visibility },
});

// Resolves with the summary of the next announcement run that finishes.
function nextAnnouncement(): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    const spy = jest.spyOn(logger, 'info').mockImplementation(((data: any, message?: string) => {
      if (String(message ?? '').startsWith('[new-load alerts]')) {
        spy.mockRestore();
        resolve(data);
      }
    }) as any);
  });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  setLifecycleOutboxRequestFlushMode('inline');
  jest.spyOn(storageService, 'upload').mockImplementation(async (_file: any, prefix?: string) => `${prefix || 'test'}/alerts.png`);
  jest.spyOn(storageService, 'getSignedUrl').mockResolvedValue('https://signed.example/alerts.png');
  jest.spyOn(socketEmitter, 'emitDriverPoolChange').mockImplementation(() => {});

  const oldOrgs = await Organization.find({ slug: TEST_ORG_SLUG }).select('_id');
  await Load.deleteMany({ organizationId: { $in: oldOrgs.map((o) => o._id) } });
  const oldUsers = await User.find({ email: { $regex: /@new-load-alerts-test\.com$/ } }).select('_id');
  await Notification.deleteMany({ userId: { $in: oldUsers.map((u) => u._id) } });
  await DriverProfile.deleteMany({ userId: { $in: oldUsers.map((u) => u._id) } });
  await User.deleteMany({ _id: { $in: oldUsers.map((u) => u._id) } });
  await Organization.deleteMany({ _id: { $in: oldOrgs.map((o) => o._id) } });

  org = await Organization.create({ name: 'New Load Alerts Test Org', slug: TEST_ORG_SLUG, status: 'active' });
  invalidateActiveOrganizations();
  dispatcher = await User.create({
    email: `dispatcher${TEST_EMAIL_DOMAIN}`,
    name: 'Dispatcher',
    role: 'admin',
    organizationId: org._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  dispatcherToken = tokenService.generateAccessToken(dispatcher);

  await createDriver('fits', {});
  await createDriver('off-day', { availableDays: [OTHER_DAY] });
  await createDriver('other-trailer', { trailerType: 'enclosed_2car' });
  await createDriver('small-trailer', { maxVehicleCapacity: 1 });
  await createDriver('on-leave', { operationalStatus: 'on_leave' });
  await createDriver('not-approved', {}, { isApproved: false });
  await createDriver('busy', {});
  // Already driving another load right now.
  await Load.create({
    organizationId: org._id,
    createdBy: dispatcher._id,
    postType: 'assign-carrier',
    status: 'In-Transit',
    assignedDriverId: drivers.busy.id,
    pickupLocation: { address: '1 A St', city: 'Ogden', state: 'UT', zip: '84401' },
    deliveryLocation: { address: '2 B St', city: 'Boise', state: 'ID', zip: '83702' },
    vehicles: [{ year: 2019, make: 'Ford', model: 'F-150', condition: 'Operable' }],
    trailerType: 'open_2car',
    additionalInfo: { visibility: 'private' },
  });
}, 60000);

afterAll(async () => {
  jest.restoreAllMocks();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const users = await User.find({ email: { $regex: /@new-load-alerts-test\.com$/ } }).select('_id');
  const userIds = users.map((u) => u._id);
  await Load.deleteMany({ organizationId: org?._id });
  await Notification.deleteMany({ userId: { $in: userIds } });
  await DriverProfile.deleteMany({ userId: { $in: userIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await Organization.deleteMany({ _id: org?._id });
  await mongoose.disconnect();
});

describe('Drivers are told about a new public load they can request', () => {
  let loadId: string;
  let loadNumber: string;

  it('posting a public load tells exactly the drivers who could request it', async () => {
    const announced = nextAnnouncement();
    const res = await request(app).post('/api/loads').set(auth(dispatcherToken)).send(boardLoad('public')).expect(201);
    loadId = String(res.body.data.load._id);
    loadNumber = res.body.data.load.loadNumber;
    const summary = await announced;
    expect(summary).toMatchObject({ loadId, fits: expect.any(Number), checkFirst: expect.any(Number) });

    const [fits] = await alertsFor('fits', loadId);
    expect(fits).toMatchObject({
      type: 'new_load_available',
      title: 'New Load You Can Request',
      metadata: { loadNumber, route: `/driver/available-loads/${loadId}`, pushTag: 'new-board-loads' },
    });
    expect(fits.message).toMatch(
      new RegExp(`^Load ${loadNumber} was just posted: Salt Lake City, UT to Denver, CO, 2 vehicles, pickup \\w{3}, \\w{3} \\d{1,2}\\. It fits your trailer, and the pickup is on one of your work days\\. Open it to see the details and request it\\.$`),
    );

    const [offDay] = await alertsFor('off-day', loadId);
    expect(offDay).toMatchObject({ type: 'new_load_check_first', title: 'New Load: Check Before Requesting' });
    expect(offDay.message).toContain(`check first: the pickup is on ${PICKUP_DAY[0].toUpperCase()}${PICKUP_DAY.slice(1)}, which isn't one of your work days.`);

    const [otherTrailer] = await alertsFor('other-trailer', loadId);
    expect(otherTrailer.type).toBe('new_load_check_first');
    expect(otherTrailer.message).toContain('it asks for an Open 2-Car trailer, and yours is an Enclosed 2-Car');

    for (const label of ['small-trailer', 'on-leave', 'not-approved', 'busy']) {
      expect(await alertsFor(label, loadId)).toHaveLength(0);
    }
  });

  it('announcing does not change the load version, so an open edit form still saves', async () => {
    const stored: any = await Load.findById(loadId).select('+boardAlertSentAt updatedAt createdAt').lean();
    expect(stored.boardAlertSentAt).toBeInstanceOf(Date);
    expect(stored.updatedAt.getTime()).toBe(stored.createdAt.getTime());
  });

  it('what the notice says matches what happens when the driver presses Request', async () => {
    // "You can request": goes straight through.
    await request(app)
      .post(`/api/driver-tracking/loads/${loadId}/request`)
      .set(auth(drivers.fits.token))
      .send(signatureFor('Driver fits'))
      .expect((res) => expect([200, 201]).toContain(res.status));

    // "Check first" (pickup day): asks to confirm, then goes through.
    const confirm = await request(app)
      .post(`/api/driver-tracking/loads/${loadId}/request`)
      .set(auth(drivers['off-day'].token))
      .send(signatureFor('Driver off-day'))
      .expect(409);
    expect(confirm.body.message).toMatch(/outside your regular availability/);
    await request(app)
      .post(`/api/driver-tracking/loads/${loadId}/request`)
      .set(auth(drivers['off-day'].token))
      .send({ ...signatureFor('Driver off-day'), overrideAvailability: true })
      .expect((res) => expect([200, 201]).toContain(res.status));

    // Not told: the trailer can't carry 2 vehicles, and Request refuses too.
    await request(app)
      .post(`/api/driver-tracking/loads/${loadId}/request`)
      .set(auth(drivers['small-trailer'].token))
      .send(signatureFor('Driver small-trailer'))
      .expect(409);
  });

  it('a private load tells nobody until it is made public, and then only once', async () => {
    const res = await request(app).post('/api/loads').set(auth(dispatcherToken)).send(boardLoad('private')).expect(201);
    const privateId = String(res.body.data.load._id);
    // Nothing to wait for: a private load starts no announcement.
    expect(await announceNewBoardLoad(privateId)).toEqual({ fits: 0, checkFirst: 0, notEligible: 0 });
    expect(await alertsFor('fits', privateId)).toHaveLength(0);

    const announced = nextAnnouncement();
    await request(app)
      .put(`/api/loads/${privateId}`)
      .set(auth(dispatcherToken))
      .send({ additionalInfo: { visibility: 'public' }, expectedUpdatedAt: await currentVersion(privateId) })
      .expect(200);
    await announced;
    expect(await alertsFor('fits', privateId)).toHaveLength(1);

    // Private and public again: no second announcement.
    await request(app)
      .put(`/api/loads/${privateId}`)
      .set(auth(dispatcherToken))
      .send({ additionalInfo: { visibility: 'private' }, expectedUpdatedAt: await currentVersion(privateId) })
      .expect(200);
    await request(app)
      .put(`/api/loads/${privateId}`)
      .set(auth(dispatcherToken))
      .send({ additionalInfo: { visibility: 'public' }, expectedUpdatedAt: await currentVersion(privateId) })
      .expect(200);
    expect(await announceNewBoardLoad(privateId)).toEqual({ fits: 0, checkFirst: 0, notEligible: 0 });
    // Still the one notification; making it private marked it unavailable.
    const all = await Notification.find({ userId: drivers.fits.id, 'metadata.loadId': privateId }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: 'new_load_unavailable', title: 'Load No Longer Available' });
  });

  it('posting a draft (a converted quote) puts it on the board and tells drivers', async () => {
    const draft: any = await Load.create({ ...boardLoad('public'), organizationId: org._id, createdBy: dispatcher._id, status: 'Draft' });
    const save = async (status: string) =>
      request(app)
        .put(`/api/loads/${draft._id}`)
        .set(auth(dispatcherToken))
        .send({ status, expectedUpdatedAt: await currentVersion(draft._id) });

    // The edit form still can't make any other status change.
    expect((await save('Assigned')).status).toBe(409);

    const announced = nextAnnouncement();
    expect((await save('Posted')).status).toBe(200);
    await announced;
    expect(((await Load.findById(draft._id).lean()) as any).status).toBe('Posted');
    expect(await alertsFor('fits', draft._id)).toHaveLength(1);

    // Once posted, it can't go back to Draft from the form.
    expect((await save('Draft')).status).toBe(409);
  });

  it('a local server connected to the live database tells nobody', async () => {
    const load: any = await Load.create({ ...boardLoad('public'), organizationId: org._id, createdBy: dispatcher._id, status: 'Posted' });
    const saved = { nodeEnv: process.env.NODE_ENV, override: process.env.ALLOW_PRODUCTION_DB };
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_PRODUCTION_DB = 'live-database.example.net';
    try {
      expect(await announceNewBoardLoad(String(load._id))).toEqual({ fits: 0, checkFirst: 0, notEligible: 0 });
    } finally {
      process.env.NODE_ENV = saved.nodeEnv;
      if (saved.override === undefined) delete process.env.ALLOW_PRODUCTION_DB;
      else process.env.ALLOW_PRODUCTION_DB = saved.override;
    }
    expect(await alertsFor('fits', load._id)).toHaveLength(0);
    expect(((await Load.findById(load._id).select('+boardAlertSentAt').lean()) as any).boardAlertSentAt).toBeUndefined();
  });
});

describe('A request is checked again if Dispatch changes the load while it is being sent', () => {
  // Dispatch changes the load after the request's checks passed but before it
  // is saved (the last check is the schedule-conflict check).
  async function requestWhileDispatchChanges(change: Record<string, unknown>) {
    const load: any = await Load.create({ ...boardLoad('public'), organizationId: org._id, createdBy: dispatcher._id, status: 'Posted' });
    const realCheck = commitments.assertNoDriverCommitmentConflict;
    const spy = jest.spyOn(commitments, 'assertNoDriverCommitmentConflict').mockImplementation(async (params) => {
      await realCheck(params);
      await Load.updateOne({ _id: load._id }, change);
    });
    try {
      const res = await request(app)
        .post(`/api/driver-tracking/loads/${load._id}/request`)
        .set(auth(drivers.fits.token))
        .send(signatureFor('Driver fits'));
      const stored: any = await Load.findById(load._id).lean();
      return { res, requests: stored.driverRequests ?? [] };
    } finally {
      spy.mockRestore();
    }
  }

  it.each([
    ['made private', { $set: { 'additionalInfo.visibility': 'private' } }],
    ['given another vehicle', { $push: { vehicles: { year: 2018, make: 'Ford', model: 'Focus', condition: 'Operable' } } }],
    ['given another trailer type', { $set: { trailerType: 'enclosed_2car' } }],
    ['moved to another pickup date', { $set: { 'dates.firstAvailable': new Date(pickupDate.getTime() + 86_400_000) } }],
  ])('refuses the request when the load is %s', async (_label, change) => {
    const { res, requests } = await requestWhileDispatchChanges(change);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/changed while your request was being submitted\. Refresh Available Loads and try again\./);
    expect(requests).toHaveLength(0);
  });
});

describe('Alerts for a load that left the board say so', () => {
  const waitFor = async (check: () => Promise<boolean>, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('timed out waiting for the alerts to update');
  };
  const alertsOf = (label: string, loadId: unknown) =>
    Notification.find({ userId: drivers[label].id, 'metadata.loadId': String(loadId) }).lean();

  async function postAndAnnounce() {
    const announced = nextAnnouncement();
    const res = await request(app).post('/api/loads').set(auth(dispatcherToken)).send(boardLoad('public')).expect(201);
    await announced;
    return String(res.body.data.load._id);
  }

  it('assigned to a driver: theirs points to My Loads, everyone else sees it is gone', async () => {
    const loadId = await postAndAnnounce();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId, driverId: drivers['other-trailer'].id })
      .expect(200);

    await waitFor(async () => (await alertsOf('fits', loadId))[0]?.type === 'new_load_unavailable');
    const [fits] = await alertsOf('fits', loadId);
    expect(fits).toMatchObject({
      title: 'Load No Longer Available',
      isRead: true,
      metadata: { boardState: 'gone', route: '/driver/available-loads' },
    });
    expect(fits.message).toMatch(/was assigned to another driver or taken off the load board, so it can't be requested\. You don't need to do anything\.$/);

    await waitFor(async () => (await alertsOf('other-trailer', loadId)).some((n: any) => n.metadata?.boardState));
    const own = (await alertsOf('other-trailer', loadId)).find((n: any) => n.type === 'new_load_check_first');
    expect(own).toMatchObject({
      title: 'Load Now Assigned to You',
      isRead: true,
      metadata: { boardState: 'assigned_to_you', route: `/driver/loads/${loadId}` },
    });
  });

  it('made private or deleted: every alert says it is no longer available', async () => {
    const madePrivate = await postAndAnnounce();
    await request(app)
      .put(`/api/loads/${madePrivate}`)
      .set(auth(dispatcherToken))
      .send({ additionalInfo: { visibility: 'private' }, expectedUpdatedAt: await currentVersion(madePrivate) })
      .expect(200);
    await waitFor(async () => (await alertsOf('fits', madePrivate))[0]?.type === 'new_load_unavailable');

    const deleted = await postAndAnnounce();
    await request(app).delete(`/api/loads/${deleted}`).set(auth(dispatcherToken)).expect(200);
    await waitFor(async () => (await alertsOf('fits', deleted))[0]?.type === 'new_load_unavailable');
    expect(await Notification.countDocuments({ 'metadata.loadId': deleted, type: { $in: ALERT_TYPES } })).toBe(0);
  });
});
