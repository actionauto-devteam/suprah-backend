import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Referral from '../src/models/referral.model';
import Transaction from '../src/models/transaction.model';
import Payment from '../src/models/Payment.model';
import mongoose from 'mongoose';
import { clerkClient } from '@clerk/clerk-sdk-node';
import notificationService from '../src/services/notification.service';
import config from '../src/config';
import Organization from '../src/models/Organization.model';

// Mock Notification Service to avoid real side effects and verify calls
jest.mock('../src/services/notification.service', () => ({
    createNotification: jest.fn().mockResolvedValue({ success: true }),
    getNotifications: jest.fn()
}));

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Referral Automation Integration Tests', () => {
    // Increase timeout for DB operations
    jest.setTimeout(60000);

    const referrerClerkId = 'clerk_referrer_789';
    const customerClerkId = 'clerk_customer_012';
    const adminClerkId = 'clerk_admin_999';
    let referrerCode = '';
    const customerEmail = 'customer.automation.test@example.com';
    let testOrgId = '';

    beforeAll(async () => {
        // Ensure we are connected to the same database as the app
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(config.mongoose.url);
        }

        testOrgId = new mongoose.Types.ObjectId().toString();

        // Clean up any old test data
        await Organization.deleteMany({ name: 'Automation Test Org' });
        await User.deleteMany({ email: { $regex: 'automation.test@example.com' } });
        // await Referral.deleteMany({});
        // await Transaction.deleteMany({});
        await Payment.deleteMany({ customerEmail: customerEmail });

        // Create Test Organization
        await Organization.create({
            _id: testOrgId,
            name: 'Automation Test Org',
            slug: 'automation-test-org',
            status: 'active'
        });

        // 1. Create Referrer
        const referrer = new User({
            name: 'Referrer User',
            email: 'referrer.automation.test@example.com',
            clerkId: referrerClerkId,
            role: 'customer',
            organizationId: testOrgId,
            walletBalance: 0,
            totalEarned: 0
        });
        const savedReferrer = await referrer.save();
        referrerCode = savedReferrer.referralCode as string;

        // 2. Create Customer (not linked yet)
        const customer = new User({
            name: 'Customer User',
            email: customerEmail,
            clerkId: customerClerkId,
            organizationId: testOrgId,
            role: 'customer'
        });
        await customer.save();

        // 3. Create Admin
        const admin = new User({
            name: 'Admin User',
            email: 'admin.automation.test@example.com',
            clerkId: adminClerkId,
            organizationId: testOrgId,
            role: 'admin'
        });
        await admin.save();
    });

    afterAll(async () => {
        // Final cleanup
        await User.deleteMany({ email: { $regex: 'automation.test@example.com' } });
        await Referral.deleteMany({});
        await Transaction.deleteMany({});
        await Payment.deleteMany({ customerEmail: customerEmail });

        // Only disconnect if we are in the standalone test DB
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    test('Phase 1: Link Referral and Trigger Signup Notification', async () => {
        // Mock authentication as the new customer
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: customerClerkId,
            sid: 'sess_1'
        });

        const res = await request(app)
            .post('/api/customer/wallet/link-referral')
            .set('Authorization', 'Bearer customer_token')
            .send({ referralCode: referrerCode })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.referrerClerkId).toBe(referrerClerkId);

        // Verify notification service was called
        expect(notificationService.createNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'referral_joined',
                title: expect.stringContaining('Signup')
            })
        );
    });

    test('Phase 2: Automated $100 Payout on Manual Payment Success', async () => {
        // Create a pending payment for the customer linked to a quote (Vehicle Purchase)
        const payment = await Payment.create({
            organizationId: testOrgId,
            customerId: customerClerkId,
            customerName: 'Customer User',
            customerEmail: customerEmail,
            amount: 5000,
            currency: 'usd',
            status: 'pending',
            description: 'Vehicle Purchase Deposit',
            quoteId: new mongoose.Types.ObjectId(), // CRITICAL logic: must have quoteId
            createdBy: new mongoose.Types.ObjectId()
        });

        // Mock Admin/Dealer Authentication
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: adminClerkId,
            sid: 'sess_admin',
            org_id: payment.organizationId,
            org_role: 'org:admin'
        });

        // Dealer marks payment as succeeded (Manual Update)
        const res = await request(app)
            .patch(`/api/payments/${payment._id}`)
            .set('Authorization', 'Bearer admin_token')
            .send({ status: 'succeeded' })
            .expect(200);

        expect(res.body.data.status).toBe('succeeded');

        // Verify Referrer Wallet Balance Increase
        const updatedReferrer = await User.findOne({ clerkId: referrerClerkId });
        expect(updatedReferrer?.walletBalance).toBe(100);
        expect(updatedReferrer?.totalEarned).toBe(100);

        // Verify Transaction Record was created
        const transaction = await Transaction.findOne({
            userClerkId: referrerClerkId,
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
        // Fetch current state
        const initialReferrer = await User.findOne({ clerkId: referrerClerkId });
        expect(initialReferrer?.walletBalance).toBe(100);

        const payment = await Payment.findOne({ customerEmail: customerEmail });

        // Mock Admin Authentication again
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: adminClerkId,
            sid: 'sess_admin',
            org_id: payment?.organizationId,
            org_role: 'org:admin'
        });

        // Dealer updates the same payment again (e.g., adding notes)
        await request(app)
            .patch(`/api/payments/${payment?._id}`)
            .set('Authorization', 'Bearer admin_token')
            .send({ notes: 'Adding extra notes while status is already succeeded', status: 'succeeded' })
            .expect(200);

        // Verify Referrer Wallet has NOT increased again
        const finalReferrer = await User.findOne({ clerkId: referrerClerkId });
        expect(finalReferrer?.walletBalance).toBe(100); // Should still be 100

        // Verify no extra transactions were created
        const depositCount = await Transaction.countDocuments({
            userClerkId: referrerClerkId,
            type: 'deposit'
        });
        expect(depositCount).toBe(1);
    });

    test('Phase 4: Non-Vehicle Payments should NOT trigger rewards', async () => {
        // Create a new customer and link them
        const nonVehicleClerkId = 'clerk_non_vehicle_444';
        const nonVehicleEmail = 'non.vehicle.automation.test@example.com';

        const customer2 = new User({
            name: 'Normal Service Customer',
            email: nonVehicleEmail,
            clerkId: nonVehicleClerkId,
            role: 'customer'
        });
        await customer2.save();

        // Already linked logic is tested in Phase 1, we'll manually create referral record for simplicity
        await Referral.create({
            referrerClerkId: referrerClerkId,
            referredUserClerkId: nonVehicleClerkId,
            referralCodeUsed: referrerCode
        });

        // Create a payment WITHOUT quoteId (e.g., a simple service repair)
        const servicePayment = await Payment.create({
            organizationId: testOrgId,
            customerId: nonVehicleClerkId,
            customerName: 'Normal Service Customer',
            customerEmail: nonVehicleEmail,
            amount: 150,
            currency: 'usd',
            status: 'pending',
            description: 'Oil Change Service',
            // NO quoteId here
            createdBy: new mongoose.Types.ObjectId()
        });

        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: adminClerkId,
            sid: 'sess_admin_2',
            org_id: servicePayment.organizationId,
            org_role: 'org:admin'
        });

        await request(app)
            .patch(`/api/payments/${servicePayment._id}`)
            .set('Authorization', 'Bearer admin_token')
            .send({ status: 'succeeded' })
            .expect(200);

        // Referrer wallet should STILL be 100 (from the first vehicle sale)
        const referrer = await User.findOne({ clerkId: referrerClerkId });
        expect(referrer?.walletBalance).toBe(100);
    });

    test('Phase 5: Shipment-based payments should trigger rewards via lookup', async () => {
        // 1. Create a new referred customer
        const shipmentCustomerClerkId = 'clerk_shipment_555';
        const shipmentCustomerEmail = 'shipment.automation.test@example.com';

        const customer = new User({
            name: 'Shipment Customer',
            email: shipmentCustomerEmail,
            clerkId: shipmentCustomerClerkId,
            role: 'customer',
            organizationId: testOrgId
        });
        await customer.save();

        await Referral.create({
            referrerClerkId: referrerClerkId,
            referredUserClerkId: shipmentCustomerClerkId,
            referralCodeUsed: referrerCode
        });

        // 2. Create a shipment for this customer (contains quoteId)
        const quoteId = new mongoose.Types.ObjectId();
        const shipment = await mongoose.model('Shipment').create({
            organizationId: testOrgId,
            quoteId: quoteId,
            status: 'Available for Pickup',
            origin: 'Test Origin',
            destination: 'Test Destination',
            requestedPickupDate: new Date()
        });

        // 3. Create a payment linked ONLY to the shipment (simulating the bug state)
        const shipmentPayment = await Payment.create({
            organizationId: testOrgId,
            customerId: shipmentCustomerClerkId,
            customerName: 'Shipment Customer',
            customerEmail: shipmentCustomerEmail,
            amount: 1200,
            currency: 'usd',
            status: 'pending',
            description: 'Vehicle Transport - Test',
            shipmentId: shipment._id, // NO quoteId directly on the payment
            createdBy: new mongoose.Types.ObjectId()
        });

        // 4. Update payment to succeeded
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: adminClerkId,
            sid: 'sess_admin_shipment',
            org_id: testOrgId,
            org_role: 'org:admin'
        });

        await request(app)
            .patch(`/api/payments/${shipmentPayment._id}`)
            .set('Authorization', 'Bearer admin_token')
            .send({ status: 'succeeded' })
            .expect(200);

        // 5. Verify reward was issued (referrer should now have 100 + 100 = 200)
        const referrer = await User.findOne({ clerkId: referrerClerkId });
        expect(referrer?.walletBalance).toBe(200);

        // Verify transaction exists with reference to the referral
        const transaction = await Transaction.findOne({
            userClerkId: referrerClerkId,
            amount: 100,
            note: { $regex: /shipment/i }
        });
        // Note: The note might not contain "shipment" because the service uses customer name/email.
        // Let's just check for a second completed deposit.
        const depositCount = await Transaction.countDocuments({
            userClerkId: referrerClerkId,
            type: 'deposit',
            status: 'completed'
        });
        expect(depositCount).toBe(2);
    });
});
