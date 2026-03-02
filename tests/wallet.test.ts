import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Referral from '../src/models/referral.model';
import Transaction from '../src/models/transaction.model';
import mongoose from 'mongoose';
import { clerkClient } from '@clerk/clerk-sdk-node';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Digital Wallet and Referral Engine Integration Tests', () => {

    // Accommodate heavy DB connections and CRM seeding on app startup
    jest.setTimeout(30000);

    const referrerId = 'clerk_referrer_123';
    const newCustomerId = 'clerk_newb_456';
    let referrerCode = '';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up any dirty data from failed previous runs
        await User.deleteMany({ email: { $regex: '@example.com' } });
        await Referral.deleteMany({});
        await Transaction.deleteMany({});

        // We act like a real customer by initializing the referrer
        const referrer = new User({
            name: 'Cris Reyes',
            email: 'cris.veteran@example.com',
            clerkId: referrerId,
            role: 'customer',
            walletBalance: 200 // Simulate they earned $200
        });
        const savedReferrer = await referrer.save();
        referrerCode = savedReferrer.referralCode as string;

        // Initialize the new customer
        const newCustomer = new User({
            name: 'Sarah New',
            email: 'sarah.newbie@example.com',
            clerkId: newCustomerId,
            role: 'customer'
        });
        await newCustomer.save();
    });

    afterAll(async () => {
        await User.deleteMany({ email: { $regex: '@example.com' } });
        await Referral.deleteMany({});
        await Transaction.deleteMany({});
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    // 1. Customer linking flow
    test('POST /api/customer/wallet/link-referral should securely link two users', async () => {
        // Mock authentication as Sarah
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: newCustomerId,
            sid: 'sess_sarah',
        });

        const res = await request(app)
            .post('/api/customer/wallet/link-referral')
            .set('Authorization', 'Bearer sarah_token')
            .send({ referralCode: referrerCode })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.referrerClerkId).toBe(referrerId);
        expect(res.body.data.referredUserClerkId).toBe(newCustomerId);
    });

    test('POST /api/customer/wallet/link-referral should prevent double dipping', async () => {
        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: newCustomerId, sid: 'sess_sarah' });

        const res = await request(app)
            .post('/api/customer/wallet/link-referral')
            .set('Authorization', 'Bearer sarah_token')
            .send({ referralCode: referrerCode })
            .expect(400);

        expect(res.body.message).toBe('You have already been referred');
    });

    // 2. Withdrawal Lock security
    test('POST /api/customer/wallet/withdraw should create pending requested without instantly draining wallet', async () => {
        // Mock authentication as Cris
        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: referrerId, sid: 'sess_cris' });

        const initialUser = await User.findOne({ clerkId: referrerId });
        expect(initialUser?.walletBalance).toBe(200);

        const res = await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', 'Bearer cris_token')
            .send({
                amount: 100,
                methodType: 'venmo',
                methodDetails: '@cris_venmo'
            })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('pending');
        expect(res.body.data.withdrawalMethod.type).toBe('venmo');

        // CRITICAL: Ensure wallet is NOT DRAINED. Wait for admin approval.
        const untouchedUser = await User.findOne({ clerkId: referrerId });
        expect(untouchedUser?.walletBalance).toBe(200);
    });

    test('POST /api/customer/wallet/withdraw should block insufficient funds', async () => {
        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: referrerId, sid: 'sess_cris' });

        const res = await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', 'Bearer cris_token')
            .send({
                amount: 500, // They only have 200
                methodType: 'bank_transfer',
                methodDetails: '123456789'
            })
            .expect(400);

        expect(res.body.message).toBe('Insufficient wallet balance');
    });
});
