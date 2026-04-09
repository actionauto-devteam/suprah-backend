import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Referral from '../src/models/referral.model';
import Transaction from '../src/models/transaction.model';
import Payment from '../src/models/Payment.model';
import mongoose from 'mongoose';
import notificationService from '../src/services/notification.service';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';

// Mock Notification Service to avoid real side effects and verify calls
jest.mock('../src/services/notification.service', () => ({
    createNotification: jest.fn().mockResolvedValue({ success: true }),
    getNotifications: jest.fn()
}));

describe('Referral Automation Integration Tests', () => {
    // Increase timeout for DB operations
    jest.setTimeout(60000);

    const referrerEmail = 'referrer.automation.test@example.com';
    const customerEmail = 'customer.automation.test@example.com';
    const adminEmail = 'admin.automation.test@example.com';
    
    let referrerCode = '';
    let testOrg: any;
    let referrerToken: string;
    let customerToken: string;
    let adminToken: string;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up any old test data
        const testEmails = [referrerEmail, customerEmail, adminEmail];
        await User.deleteMany({ email: { $in: testEmails } });
        await Organization.deleteMany({ slug: 'automation-test-org' });

        // Create Test Organization
        testOrg = await Organization.create({
            name: 'Automation Test Org',
            slug: 'automation-test-org',
            status: 'active'
        });

        // 1. Create Referrer
        const referrer = new User({
            name: 'Referrer User',
            email: referrerEmail,
            role: 'customer',
            organizationId: testOrg._id,
            walletBalance: 0,
            totalEarned: 0,
            emailVerified: true,
            onboardingCompleted: true
        });
        const savedReferrer = await referrer.save();
        referrerCode = savedReferrer.referralCode as string;
        referrerToken = tokenService.generateAccessToken(savedReferrer);

        // 2. Create Customer (not linked yet)
        const customer = new User({
            name: 'Customer User',
            email: customerEmail,
            role: 'customer',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });
        const savedCustomer = await customer.save();
        customerToken = tokenService.generateAccessToken(savedCustomer);

        // 3. Create Admin
        const admin = new User({
            name: 'Admin User',
            email: adminEmail,
            role: 'admin',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });
        const savedAdmin = await admin.save();
        adminToken = tokenService.generateAccessToken(savedAdmin);
    });

    afterAll(async () => {
        const testEmails = [referrerEmail, customerEmail, adminEmail];
        const users = await User.find({ email: { $in: testEmails } });
        const userIds = users.map(u => u._id);

        await User.deleteMany({ email: { $in: testEmails } });
        await Referral.deleteMany({ userId: { $in: userIds } });
        await Transaction.deleteMany({ userId: { $in: userIds } });
        await Payment.deleteMany({ organizationId: testOrg?._id });
        await Organization.deleteOne({ _id: testOrg?._id });

        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    test('Phase 1: Link Referral and Trigger Signup Notification', async () => {
        const res = await request(app)
            .post('/api/customer/wallet/link-referral')
            .set('Authorization', `Bearer ${customerToken}`)
            .send({ referralCode: referrerCode })
            .expect(201);

        expect(res.body.success).toBe(true);

        // Verify notification service was called
        expect(notificationService.createNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'referral_joined',
                title: expect.stringContaining('Signup')
            })
        );
    });

    test('Phase 2: Automated $100 Payout on Manual Payment Success', async () => {
        const customer = await User.findOne({ email: customerEmail });
        
        // Create a pending payment for the customer linked to a quote
        const payment = await Payment.create({
            organizationId: testOrg._id.toString(),
            customerId: customer?._id.toString(),
            customerName: 'Customer User',
            customerEmail: customerEmail,
            amount: 5000,
            currency: 'usd',
            status: 'pending',
            description: 'Vehicle Purchase Deposit',
            quoteId: new mongoose.Types.ObjectId(),
            createdBy: new mongoose.Types.ObjectId()
        });

        // Dealer marks payment as succeeded
        const res = await request(app)
            .patch(`/api/payments/${payment._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ status: 'succeeded' })
            .expect(200);

        expect(res.body.data.status).toBe('succeeded');

        // Verify Referrer Wallet Balance Increase
        const updatedReferrer = await User.findOne({ email: referrerEmail });
        expect(updatedReferrer?.walletBalance).toBe(100);
        expect(updatedReferrer?.totalEarned).toBe(100);

        // Verify Transaction Record was created
        const transaction = await Transaction.findOne({
            userId: updatedReferrer?._id,
            type: 'deposit'
        });
        expect(transaction).toBeDefined();
        expect(transaction?.amount).toBe(100);
        expect(transaction?.status).toBe('completed');

        // Verify Reward Notification
        expect(notificationService.createNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'referral_rewarded',
                title: expect.stringContaining('Reward')
            })
        );
    });

    test('Phase 3: Prevent Duplicate Rewards on Multiple Updates', async () => {
        const initialReferrer = await User.findOne({ email: referrerEmail });
        expect(initialReferrer?.walletBalance).toBe(100);

        const payment = await Payment.findOne({ customerEmail: customerEmail });

        // Dealer updates the same payment again
        await request(app)
            .patch(`/api/payments/${payment?._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ notes: 'Adding extra notes', status: 'succeeded' })
            .expect(200);

        // Verify Referrer Wallet has NOT increased again
        const finalReferrer = await User.findOne({ email: referrerEmail });
        expect(finalReferrer?.walletBalance).toBe(100);

        const depositCount = await Transaction.countDocuments({
            userId: finalReferrer?._id,
            type: 'deposit'
        });
        expect(depositCount).toBe(1);
    });

    test('Phase 4: Non-Vehicle Payments should NOT trigger rewards', async () => {
        const nonVehicleEmail = 'non.vehicle.automation.test@example.com';

        const customer2 = await User.create({
            name: 'Normal Service Customer',
            email: nonVehicleEmail,
            role: 'customer',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        const referrerInstance = await User.findOne({ email: referrerEmail });
        await Referral.create({
            organizationId: testOrg._id,
            referrerId: referrerInstance?._id,
            referredUserId: customer2._id,
            referralCodeUsed: referrerCode
        });

        const servicePayment = await Payment.create({
            organizationId: testOrg._id.toString(),
            customerId: customer2._id.toString(),
            customerName: 'Normal Service Customer',
            customerEmail: nonVehicleEmail,
            amount: 150,
            currency: 'usd',
            status: 'pending',
            description: 'Oil Change Service',
            createdBy: new mongoose.Types.ObjectId()
        });

        await request(app)
            .patch(`/api/payments/${servicePayment._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ status: 'succeeded' })
            .expect(200);

        const referrer = await User.findOne({ email: referrerEmail });
        expect(referrer?.walletBalance).toBe(100);
    });
});
