import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Referral from '../src/models/referral.model';
import Transaction from '../src/models/transaction.model';
import Organization from '../src/models/Organization.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Digital Wallet and Referral Engine Integration Tests', () => {

    // Accommodate heavy DB connections and CRM seeding on app startup
    jest.setTimeout(30000);

    const referrerEmail = 'cris.veteran@example.com';
    const newCustomerEmail = 'sarah.newbie@example.com';
    let referrerCode = '';
    let referrerToken = '';
    let sarahToken = '';
    let testOrg: any;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up only our specific test users and their related data
        const testEmails = [referrerEmail, newCustomerEmail];
        await User.deleteMany({ email: { $in: testEmails } });
        await Organization.deleteMany({ slug: 'wallet-test-org' });

        // Initialize Test Organization
        testOrg = await Organization.create({
            name: 'Wallet Test Org',
            slug: 'wallet-test-org',
        });

        // Initialize the referrer
        const referrer = new User({
            name: 'Cris Reyes',
            email: referrerEmail,
            role: 'customer',
            organizationId: testOrg._id,
            walletBalance: 200,
            emailVerified: true,
            onboardingCompleted: true
        });
        const savedReferrer = await referrer.save();
        referrerCode = savedReferrer.referralCode as string;
        referrerToken = tokenService.generateAccessToken(savedReferrer);

        // Initialize the new customer
        const newCustomer = new User({
            name: 'Sarah New',
            email: newCustomerEmail,
            role: 'customer',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });
        const savedCustomer = await newCustomer.save();
        sarahToken = tokenService.generateAccessToken(savedCustomer);
    });

    afterAll(async () => {
        const testEmails = [referrerEmail, newCustomerEmail];
        const testUsers = await User.find({ email: { $in: testEmails } });
        const testUserIds = testUsers.map(u => u._id);

        await User.deleteMany({ email: { $in: testEmails } });
        await Referral.deleteMany({ organizationId: testOrg?._id });
        await Transaction.deleteMany({ organizationId: testOrg?._id });
        await Organization.deleteOne({ _id: testOrg?._id });

        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    // 1. Customer linking flow
    test('POST /api/customer/wallet/link-referral should securely link two users', async () => {
        const res = await request(app)
            .post('/api/customer/wallet/link-referral')
            .set('Authorization', `Bearer ${sarahToken}`)
            .send({ referralCode: referrerCode })
            .expect(201);

        expect(res.body.success).toBe(true);
        // Note: Field names might still be referrerClerkId in models, but we use internal IDs/Emails
    });

    test('POST /api/customer/wallet/link-referral should prevent double dipping', async () => {
        const res = await request(app)
            .post('/api/customer/wallet/link-referral')
            .set('Authorization', `Bearer ${sarahToken}`)
            .send({ referralCode: referrerCode })
            .expect(400);

        expect(res.body.message).toBe('You have already been referred');
    });

    // 2. Withdrawal Lock security
    test('POST /api/customer/wallet/withdraw should create pending requested without instantly draining wallet', async () => {
        const initialUser = await User.findOne({ email: referrerEmail });
        expect(initialUser?.walletBalance).toBe(200);

        const res = await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', `Bearer ${referrerToken}`)
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
        const untouchedUser = await User.findOne({ email: referrerEmail });
        expect(untouchedUser?.walletBalance).toBe(200);
    });

    test('POST /api/customer/wallet/withdraw should block insufficient funds', async () => {
        const res = await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', `Bearer ${referrerToken}`)
            .send({
                amount: 500, // They only have 200
                methodType: 'bank_transfer',
                methodDetails: '123456789'
            })
            .expect(400);

        expect(res.body.message).toBe('Insufficient wallet balance');
    });
});
