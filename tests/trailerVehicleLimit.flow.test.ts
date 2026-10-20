/**
 * Trailer vehicle limit (10), through the real Equipment endpoint: a driver
 * can't set more than 10, a profile saved before the limit is brought down to
 * 10 on its next save, and load matching never counts more than 10.
 *
 * Data safety (same as load-flow): every account is created by this suite and
 * removed afterwards.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import DriverProfile from '../src/models/DriverProfile.model';
import tokenService from '../src/services/token.service';
import { evaluateDriverLoadCompatibility } from '../src/services/driverLoadCompatibility.service';

const TEST_EMAIL_DOMAIN = '@trailer-limit-test.com';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const capacityOf = async (userId: unknown) =>
  ((await DriverProfile.findOne({ userId }).lean()) as any)?.maxVehicleCapacity;

let driver: any;
let driverToken: string;

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const old = await User.find({ email: { $regex: /@trailer-limit-test\.com$/ } }).select('_id');
  await DriverProfile.deleteMany({ userId: { $in: old.map((u) => u._id) } });
  await User.deleteMany({ _id: { $in: old.map((u) => u._id) } });

  driver = await User.create({
    email: `driver${TEST_EMAIL_DOMAIN}`,
    name: 'Limit Driver',
    role: 'driver',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
  });
  await DriverProfile.create({ userId: driver._id, operationalStatus: 'active', verificationStatus: 'verified' });
  driverToken = tokenService.generateAccessToken(driver);
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const users = await User.find({ email: { $regex: /@trailer-limit-test\.com$/ } }).select('_id');
  await DriverProfile.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  await mongoose.disconnect();
});

describe('A trailer carries at most 10 vehicles', () => {
  it('Equipment refuses more than 10 and says why', async () => {
    const res = await request(app)
      .patch('/api/driver-profile/equipment')
      .set(auth(driverToken))
      .send({ trailerType: 'other', customTrailerName: 'Custom hauler', maxVehicleCapacity: 11 })
      .expect(400);
    expect(res.body.message).toBe(
      'A trailer can carry at most 10 vehicles. Set Max Vehicles to 10 or less, then save again.',
    );
    expect(await capacityOf(driver._id)).toBe(1);
  });

  it('Equipment saves 10', async () => {
    await request(app)
      .patch('/api/driver-profile/equipment')
      .set(auth(driverToken))
      .send({ trailerType: 'other', customTrailerName: 'Custom hauler', maxVehicleCapacity: 10 })
      .expect(200);
    expect(await capacityOf(driver._id)).toBe(10);
  });

  it('a profile saved above 10 before the limit still saves, and comes down to 10', async () => {
    // Written straight to the database, the way an older profile looks.
    await DriverProfile.collection.updateOne({ userId: driver._id }, { $set: { maxVehicleCapacity: 12 } });
    expect(await capacityOf(driver._id)).toBe(12);

    await request(app)
      .patch('/api/driver-profile/equipment')
      .set(auth(driverToken))
      .send({ truckMake: 'Peterbilt' })
      .expect(200);
    expect(await capacityOf(driver._id)).toBe(10);
  });

  it('load matching counts an older value above 10 as 10', () => {
    const vehicles = (n: number) => Array.from({ length: n }, () => ({ year: 2020, make: 'Toyota', model: 'Camry' }));
    const profile = { maxVehicleCapacity: 12, trailerType: 'other' };
    const fits = evaluateDriverLoadCompatibility(profile, { vehicles: vehicles(10), trailerType: 'other' }).capacity;
    expect(fits).toMatchObject({ status: 'match', maxVehicles: 10 });
    const tooMany = evaluateDriverLoadCompatibility(profile, { vehicles: vehicles(11), trailerType: 'other' }).capacity;
    expect(tooMany).toMatchObject({ status: 'exceeded', maxVehicles: 10 });
  });
});
