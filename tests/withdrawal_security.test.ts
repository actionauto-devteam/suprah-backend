import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Referral from '../src/models/referral.model';
import Transaction from '../src/models/transaction.model';
import mongoose from 'mongoose';
import { clerkClient } from '@clerk/clerk-sdk-node';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Withdrawal Security & Audit Integration Tests', () => {

    jest.setTimeout(30000);

    const customerId = 'clerk_cust_999';
    const adminId = 'clerk_admin_000';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        await User.deleteMany({ email: { $regex: '@security.com' } });
        // Targeted cleanup of records linked to our test customer
        await Referral.deleteMany({ referrerClerkId: customerId });
        await Transaction.deleteMany({ userClerkId: customerId });

        // Create a customer with a balance
        await new User({
            name: 'Security Test User',
            email: 'user@security.com',
            clerkId: customerId,
            role: 'customer',
            walletBalance: 200
        }).save();

        // Create a super admin
        await new User({
            name: 'Super Admin',
            email: 'admin@security.com',
            clerkId: adminId,
            role: 'super_admin'
        }).save();
    });

    afterAll(async () => {
        await User.deleteMany({ email: { $regex: '@security.com' } });
        // Only delete the specific referral and transaction we created in tests
        await Referral.deleteMany({ referrerClerkId: customerId });
        await Transaction.deleteMany({ userClerkId: customerId });
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    /**
     * TEST: Net Balance Loophole Fix
     */
    test('Should block withdrawal if pending requests consume the available balance', async () => {
        // First withdrawal: $100 (Pending)
        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: customerId, sid: 'sess_1' });
        await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', 'Bearer token1')
            .send({ amount: 100, methodType: 'venmo', methodDetails: '@user' })
            .expect(201);

        // Second withdrawal attempt: $150 (Total pending would be 250, but balance is only 200)
        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: customerId, sid: 'sess_2' });
        const res = await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', 'Bearer token2')
            .send({ amount: 150, methodType: 'venmo', methodDetails: '@user' })
            .expect(400);

        expect(res.body.message).toMatch(/Insufficient available balance/);
        expect(res.body.message).toMatch(/\$100\.00 in pending withdrawals/);
    });

    /**
     * TEST: Admin Audit Detail (Lineage)
     */
    test('Admin should be able to view credit lineage for a withdrawal', async () => {
        // Give user some referral credit (Manual Deposit)
        const referral = await Referral.create({
            referrerClerkId: customerId,
            referredUserClerkId: 'friend_1',
            referralCodeUsed: 'TEST-CODE'
        });

        const deposit = await Transaction.create({
            userClerkId: customerId,
            type: 'deposit',
            status: 'completed',
            amount: 100,
            note: 'Referral Earned',
            referralId: referral._id
        });

        // Get the pending withdrawal we created earlier
        const pendingWithdrawal = await Transaction.findOne({ userClerkId: customerId, type: 'withdrawal', status: 'pending' });

        // Admin audit request
        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: adminId, sid: 'sess_admin' });
        const res = await request(app)
            .get(`/api/admin/referrals/withdrawals/${pendingWithdrawal?._id}/audit`)
            .set('Authorization', 'Bearer admin_token')
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.data.lineage.length).toBeGreaterThan(0);
        expect(res.body.data.lineage[0].referralId.toString()).toBe(referral._id.toString());
    });

    /**
     * TEST: Admin Rejection
     */
    test('Admin should be able to reject a withdrawal', async () => {
        const pendingWithdrawal = await Transaction.findOne({ userClerkId: customerId, type: 'withdrawal', status: 'pending' });

        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: adminId, sid: 'sess_admin_rej' });
        const res = await request(app)
            .post(`/api/admin/referrals/withdrawals/${pendingWithdrawal?._id}/reject`)
            .set('Authorization', 'Bearer admin_token')
            .send({ reason: 'Suspicious activity' })
            .expect(200);

        expect(res.body.data.status).toBe('rejected');
        expect(res.body.data.note).toMatch(/REJECTED: Suspicious activity/);

        // Verify balance is still untouched
        const user = await User.findOne({ clerkId: customerId });
        expect(user?.walletBalance).toBe(200);
    });

    /**
     * TEST: RBAC Check (Non-admin cannot audit)
     */
    test('RBAC: Non-admin should NOT be able to access audit endpoint', async () => {
        const pendingWithdrawal = await Transaction.findOne({ userClerkId: customerId, type: 'withdrawal' });

        mockedClerk.verifyToken.mockResolvedValueOnce({ sub: customerId, sid: 'sess_user_hacker' });
        await request(app)
            .get(`/api/admin/referrals/withdrawals/${pendingWithdrawal?._id}/audit`)
            .set('Authorization', 'Bearer user_token')
            .expect(403);
    });
});
