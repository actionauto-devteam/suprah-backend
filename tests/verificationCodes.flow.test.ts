/**
 * Email codes (sign-up verification and password reset), through the real
 * endpoints: asking for a code again while the current one is still valid
 * sends the same code, so the code in an earlier email keeps working.
 *
 * Data safety (same as load-flow): every account is created by this suite and
 * removed afterwards; emails are not really sent.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import DriverProfile from '../src/models/DriverProfile.model';
import DriverRequest from '../src/models/DriverRequest.model';

const TEST_EMAIL_DOMAIN = '@verification-codes-test.com';
const codeOf = async (email: string) =>
  ((await User.findOne({ email }).select('+otpCode +otpExpiresAt').lean()) as any) ?? {};

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const users = await User.find({ email: { $regex: /@verification-codes-test\.com$/ } }).select('_id');
  const ids = users.map((u) => u._id);
  await DriverRequest.deleteMany({ driverUserId: { $in: ids } });
  await DriverProfile.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
  await mongoose.disconnect();
});

describe('Email codes keep working when another one is requested', () => {
  const email = `new-driver${TEST_EMAIL_DOMAIN}`;

  it('sign-up: the first email code still works after Resend', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'New Driver', email, password: 'Codes-Passw0rd!', role: 'driver' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    const first = await codeOf(email);
    expect(first.otpCode).toMatch(/^\d{6}$/);

    await request(app).post('/api/auth/resend-otp').send({ email }).expect(200);
    const after = await codeOf(email);
    expect(after.otpCode).toBe(first.otpCode);
    // The expiry is not extended by asking again.
    expect(new Date(after.otpExpiresAt).getTime()).toBe(new Date(first.otpExpiresAt).getTime());

    await request(app).post('/api/auth/verify-email').send({ email, otp: first.otpCode }).expect(200);
  });

  it('password reset: asking twice sends the same code, and the first one resets the password', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email }).expect(200);
    const first = await codeOf(email);
    await request(app).post('/api/auth/forgot-password').send({ email }).expect(200);
    expect((await codeOf(email)).otpCode).toBe(first.otpCode);

    await request(app)
      .post('/api/auth/reset-password')
      .send({ email, otp: first.otpCode, newPassword: 'Codes-Passw0rd-2!' })
      .expect(200);
    // A used code can't be used again.
    await request(app)
      .post('/api/auth/reset-password')
      .send({ email, otp: first.otpCode, newPassword: 'Codes-Passw0rd-3!' })
      .expect(400);
  });

  it('new accounts need an uppercase letter, a number and a symbol, on every sign-up path', async () => {
    const weak = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Weak Password', email: `weak${TEST_EMAIL_DOMAIN}`, password: 'password12345', role: 'driver' })
      .expect(400);
    expect(weak.body.message).toBe(
      'Please fix the following: Password must include at least one uppercase letter. Password must include at least one special character.',
    );
    expect(await User.exists({ email: `weak${TEST_EMAIL_DOMAIN}` })).toBeNull();

    // Invite links (customers, drivers, dealerships) check the password before the link.
    const viaInvite = await request(app)
      .post('/api/auth/invite/no-such-link/register')
      .send({ name: 'Weak Password', email: `weak-invite${TEST_EMAIL_DOMAIN}`, password: 'password12345' })
      .expect(400);
    expect(viaInvite.body.message).toBe(
      'Please fix the following: Password must include at least one uppercase letter. Password must include at least one special character.',
    );
    const badLink = await request(app)
      .post('/api/auth/invite/no-such-link/register')
      .send({ name: 'Strong Password', email: `strong-invite${TEST_EMAIL_DOMAIN}`, password: 'Codes-Passw0rd!' })
      .expect(404);
    expect(badLink.body.message).toBe("This invite link isn't valid. Ask the person who sent it for a new one.");
  });

  it('a code close to expiring is replaced by a new one', async () => {
    const other = `nearly-expired${TEST_EMAIL_DOMAIN}`;
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Other Driver', email: other, password: 'Codes-Passw0rd!', role: 'driver' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    await User.updateOne({ email: other }, { $set: { otpExpiresAt: new Date(Date.now() + 2 * 60 * 1000) } });
    const old = await codeOf(other);

    await request(app).post('/api/auth/resend-otp').send({ email: other }).expect(200);
    const fresh = await codeOf(other);
    expect(new Date(fresh.otpExpiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    // A new 15-minute code was issued (it can match the old one only by chance).
    expect(fresh.otpCode).toMatch(/^\d{6}$/);
    expect(new Date(fresh.otpExpiresAt).getTime()).not.toBe(new Date(old.otpExpiresAt).getTime());
  });
});
