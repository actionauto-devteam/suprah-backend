/**
 * Super-admin Drivers page: one page at a time, with search, filters,
 * sorting and platform-wide header totals. The full list stays available
 * for export.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import DriverProfile from '../src/models/DriverProfile.model';
import DriverRequest from '../src/models/DriverRequest.model';
import tokenService from '../src/services/token.service';

const DOMAIN = 'admin-drivers-test.com';
const users: Record<string, any> = {};
let superAdminToken = '';
let adminToken = '';

async function makeUser(key: string, name: string, role: string, isActive = true) {
  users[key] = await User.create({
    email: `${key}@${DOMAIN}`,
    name,
    role,
    emailVerified: true,
    onboardingCompleted: true,
    isActive,
    isApproved: true,
  });
  return users[key];
}

async function cleanUp() {
  const ids = (await User.find({ email: { $regex: /@admin-drivers-test\.com$/ } }).select('_id')).map((user) => user._id);
  await DriverRequest.deleteMany({ driverUserId: { $in: ids } });
  await DriverProfile.collection.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
}

const page = (query: Record<string, string>) =>
  request(app)
    .get('/api/admin/drivers')
    .query({ search: DOMAIN, ...query })
    .set({ Authorization: `Bearer ${superAdminToken}` })
    .expect(200)
    .then((res) => res.body.data);

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  superAdminToken = tokenService.generateAccessToken((await makeUser('super', 'Drivers Super', 'super_admin')) as any);
  adminToken = tokenService.generateAccessToken((await makeUser('admin', 'Drivers Admin', 'admin')) as any);
  const alpha = await makeUser('alpha', 'Alpha Driver', 'driver');
  const bravo = await makeUser('bravo', 'Bravo Driver', 'driver');
  await makeUser('charlie', 'Charlie Driver', 'driver', false);

  // Bravo applied first (approved), Alpha later (pending); Charlie never applied.
  const now = Date.now();
  await DriverRequest.collection.insertMany([
    { driverUserId: bravo._id, status: 'approved', createdAt: new Date(now - 60_000), updatedAt: new Date(now - 60_000) },
    { driverUserId: alpha._id, status: 'pending', createdAt: new Date(now), updatedAt: new Date(now) },
  ]);
  await DriverProfile.collection.insertOne({
    userId: bravo._id,
    verificationStatus: 'verified',
    profileCompletionScore: 80,
    isComplianceExpired: true,
  });
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Super-admin Drivers list, page by page', () => {
  it('returns one page at a time, newest application first, with header totals', async () => {
    const first = await page({ page: '1', limit: '2' });
    expect(first).toMatchObject({ matching: 3, page: 1, limit: 2, hasMore: true });
    expect(first.drivers.map((driver: any) => driver.name)).toEqual(['Alpha Driver', 'Bravo Driver']);
    expect(first.drivers[1]).toMatchObject({
      applicationStatus: 'approved',
      verificationStatus: 'verified',
      profileCompletionScore: 80,
      isComplianceExpired: true,
    });
    expect(first.summary.total).toBeGreaterThanOrEqual(3);
    expect(first.summary.pendingApplications).toBeGreaterThanOrEqual(1);
    expect(first.summary.expiredCompliance).toBeGreaterThanOrEqual(1);

    const second = await page({ page: '2', limit: '2' });
    expect(second.hasMore).toBe(false);
    expect(second.drivers.map((driver: any) => driver.name)).toEqual(['Charlie Driver']);
    expect(second.drivers[0]).toMatchObject({ applicationStatus: null, verificationStatus: 'not_started', isActive: false });
  });

  it('filters and sorts on the server', async () => {
    expect((await page({ page: '1', application: 'pending' })).drivers.map((d: any) => d.name)).toEqual(['Alpha Driver']);
    expect((await page({ page: '1', application: 'null' })).drivers.map((d: any) => d.name)).toEqual(['Charlie Driver']);
    expect((await page({ page: '1', active: 'false' })).drivers.map((d: any) => d.name)).toEqual(['Charlie Driver']);
    expect((await page({ page: '1', verification: 'verified' })).drivers.map((d: any) => d.name)).toEqual(['Bravo Driver']);
    expect((await page({ page: '1', sort: 'name', order: 'desc' })).drivers.map((d: any) => d.name)).toEqual([
      'Charlie Driver',
      'Bravo Driver',
      'Alpha Driver',
    ]);
    expect((await page({ page: '1', search: `bravo@${DOMAIN}` })).drivers.map((d: any) => d.name)).toEqual(['Bravo Driver']);
  });

  it('keeps the full list for export, and stays super-admin only', async () => {
    const full = await request(app)
      .get('/api/admin/drivers')
      .set({ Authorization: `Bearer ${superAdminToken}` })
      .expect(200);
    const ours = full.body.data.drivers.filter((driver: any) => String(driver.email).endsWith(`@${DOMAIN}`));
    expect(ours).toHaveLength(3);

    await request(app).get('/api/admin/drivers').query({ page: '1' }).set({ Authorization: `Bearer ${adminToken}` }).expect(403);
  });
});
