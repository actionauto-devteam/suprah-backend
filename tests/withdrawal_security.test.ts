import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Referral from '../src/models/referral.model';
import Transaction from '../src/models/transaction.model';
import Organization from '../src/models/Organization.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Withdrawal Security & Audit Integration Tests', () => {

    jest.setTimeout(30000);

    const customerEmail = 'user@security.com';
    const adminEmail = 'admin@security.com';
    let customerToken = '';
    let adminToken = '';
    let testOrg: any;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        const testEmails = [customerEmail, adminEmail];
        const testUsers = await User.find({ email: { $in: testEmails } });
        const testUserIds = testUsers.map(u => u._id);

        await User.deleteMany({ email: { $in: testEmails } });
        await Referral.deleteMany({ userId: { $in: testUserIds } });
        await Transaction.deleteMany({ userId: { $in: testUserIds } });

        // Create a test organization
        testOrg = await Organization.create({
            name: 'Withdrawal Security Org',
            slug: 'withdrawal-security-org-' + Date.now(),
        });

        // Create a customer with a balance
        const customer = new User({
            name: 'Security Test User',
            email: customerEmail,
            role: 'customer',
            organizationId: testOrg._id,
            walletBalance: 200,
            emailVerified: true,
            onboardingCompleted: true
        });
        const savedCustomer = await customer.save();
        customerToken = tokenService.generateAccessToken(savedCustomer);

        // Create a super admin
        const admin = new User({
            name: 'Super Admin',
            email: adminEmail,
            role: 'super_admin',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });
        const savedAdmin = await admin.save();
        adminToken = tokenService.generateAccessToken(savedAdmin);
    });

    afterAll(async () => {
        const testEmails = [customerEmail, adminEmail];
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

    /**
     * TEST: Net Balance Loophole Fix
     */
    test('Should block withdrawal if pending requests consume the available balance', async () => {
        // First withdrawal: $100 (Pending)
        await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', `Bearer ${customerToken}`)
            .send({ amount: 100, methodType: 'venmo', methodDetails: '@user' })
            .expect(201);

        // Second withdrawal attempt: $150 (Total pending would be 250, but balance is only 200)
        const res = await request(app)
            .post('/api/customer/wallet/withdraw')
            .set('Authorization', `Bearer ${customerToken}`)
            .send({ amount: 150, methodType: 'venmo', methodDetails: '@user' })
            .expect(400);

        expect(res.body.message).toMatch(/Insufficient available balance/);
        expect(res.body.message).toMatch(/\$100\.00 in pending withdrawals/);
    });

    /**
     * TEST: Admin Audit Detail (Lineage)
     */
    test('Admin should be able to view credit lineage for a withdrawal', async () => {
        const customer = await User.findOne({ email: customerEmail });
        
        // Give user some referral credit (Manual Deposit)
        const referral = await Referral.create({
            organizationId: testOrg._id,
            referrerId: customer?._id,
            referredUserId: new mongoose.Types.ObjectId(), // Virtual target
            referralCodeUsed: 'TEST-CODE'
        });

        await Transaction.create({
            userId: customer?._id,
            type: 'deposit',
            status: 'completed',
            amount: 100,
            note: 'Referral Earned',
            referralId: referral._id
        });

        // Get the pending withdrawal we created earlier
        const pendingWithdrawal = await Transaction.findOne({ userId: customer?._id, type: 'withdrawal', status: 'pending' });

        // Admin audit request
        const res = await request(app)
            .get(`/api/admin/referrals/withdrawals/${pendingWithdrawal?._id}/audit`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.data.lineage.length).toBeGreaterThan(0);
        expect(res.body.data.lineage[0].referralId.toString()).toBe(referral._id.toString());
    });

    /**
     * TEST: Admin Rejection
     */
    test('Admin should be able to reject a withdrawal', async () => {
        const customer = await User.findOne({ email: customerEmail });
        const pendingWithdrawal = await Transaction.findOne({ userId: customer?._id, type: 'withdrawal', status: 'pending' });

        const res = await request(app)
            .post(`/api/admin/referrals/withdrawals/${pendingWithdrawal?._id}/reject`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ reason: 'Suspicious activity' })
            .expect(200);

        expect(res.body.data.status).toBe('rejected');
        expect(res.body.data.note).toMatch(/REJECTED: Suspicious activity/);

        // Verify balance is still untouched
        const updatedUser = await User.findOne({ email: customerEmail });
        expect(updatedUser?.walletBalance).toBe(200);
    });

    /**
     * TEST: RBAC Check (Non-admin cannot audit)
     */
    test('RBAC: Non-admin should NOT be able to access audit endpoint', async () => {
        const customer = await User.findOne({ email: customerEmail });
        const pendingWithdrawal = await Transaction.findOne({ userId: customer?._id, type: 'withdrawal' });

        await request(app)
            .get(`/api/admin/referrals/withdrawals/${pendingWithdrawal?._id}/audit`)
            .set('Authorization', `Bearer ${customerToken}`)
            .expect(403);
    });
});
