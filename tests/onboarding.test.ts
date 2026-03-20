import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Invitation from '../src/models/Invitation.model';
import DriverRequest from '../src/models/DriverRequest.model';

// Mock Email Service to prevent slow tests and timeouts
jest.mock('../src/services/email.service', () => ({
    sendEmail: jest.fn().mockResolvedValue(undefined),
    sendAppointmentInvitation: jest.fn().mockResolvedValue(undefined),
    sendAppointmentUpdate: jest.fn().mockResolvedValue(undefined),
    sendAppointmentCancellation: jest.fn().mockResolvedValue(undefined),
    sendAppointmentReminder: jest.fn().mockResolvedValue(undefined),
}));

describe('Streamlined Onboarding E2E', () => {
    jest.setTimeout(20000);
    let testOrg: any;
    let dealerAdmin: any;

    beforeAll(async () => {
        // Create a test organization
        testOrg = await Organization.create({
            name: 'Test Onboarding Org',
            slug: 'test-onboarding-org-' + Date.now(),
        });

        // Create a dealer admin
        dealerAdmin = await User.create({
            email: 'dealer.admin@test-onboarding.com',
            name: 'Dealer Admin',
            role: 'admin',
            organizationId: testOrg._id,
            onboardingCompleted: true
        });
    }, 30000);

    afterAll(async () => {
        // Cleanup only test data
        // Scope deletions to the specific test domain to avoid hitting user data
        const testEmails = { $regex: /@test-onboarding\.com$/ };
        const users = await User.find({ email: testEmails });
        const userIds = users.map(u => u._id);

        await DriverRequest.deleteMany({ driverUserId: { $in: userIds } });
        await Invitation.deleteMany({ organizationId: testOrg._id });
        await User.deleteMany({ _id: { $in: userIds } });
        await Organization.deleteOne({ _id: testOrg._id });
    });

    describe('Email/Password Registration', () => {
        it('should allow a driver to sign up via invite, skip approval and bind to org', async () => {
            const email = 'driver.invited@test-onboarding.com';

            // 1. Create invitation
            const invite = await Invitation.create({
                email: email,
                role: 'driver',
                organizationId: testOrg._id,
                token: 'test-token-email-' + Date.now(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            // 2. Register with token
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'Invited Driver Email',
                    email: email,
                    password: 'password12345',
                    inviteToken: invite.token
                });

            expect(response.status).toBe(201);

            // 3. Verify user state in DB
            const user = await User.findOne({ email });
            expect(user).toBeDefined();
            expect(user?.role).toBe('driver');
            expect(user?.isApproved).toBe(true);
            expect(user?.organizationId?.toString()).toBe(testOrg._id.toString());
            expect(user?.onboardingCompleted).toBe(true);

            // 4. Verify no DriverRequest was created
            const requestDoc = await DriverRequest.findOne({ driverUserId: user?._id });
            expect(requestDoc).toBeNull();

            // 5. Verify invite is accepted
            const updatedInvite = await Invitation.findById(invite._id);
            expect(updatedInvite?.status).toBe('accepted');
        });

        it('should require approval for drivers who sign up without an invite', async () => {
            const email = 'driver.direct@test-onboarding.com';

            // 1. Register without token
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'Direct Driver Email',
                    email: email,
                    password: 'password12345',
                    role: 'driver'
                });

            expect(response.status).toBe(201);

            // 2. Verify user state
            const user = await User.findOne({ email });
            expect(user?.role).toBe('driver');
            expect(user?.isApproved).toBe(false);

            // 3. Verify DriverRequest WAS created
            const requestDoc = await DriverRequest.findOne({ driverUserId: user?._id });
            expect(requestDoc).toBeDefined();
            expect(requestDoc?.status).toBe('pending');
        });
    });

    describe('Role Promotion (Existing Users)', () => {
        it('should promote an existing customer to a driver when accepting an invite', async () => {
            const email = 'customer.to.driver@test-onboarding.com';

            // 1. Create a customer
            const customer = await User.create({
                email,
                name: 'Existing Customer',
                role: 'customer',
                onboardingCompleted: true,
                emailVerified: true
            });

            // 2. Create driver invite
            const invite = await Invitation.create({
                email,
                role: 'driver',
                organizationId: testOrg._id,
                token: 'test-token-promote-' + Date.now(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            // 3. Generate access token for the customer
            const tokenService = (await import('../src/services/token.service')).default;
            const accessToken = tokenService.generateAccessToken(customer as any);

            // 4. Accept invite via API
            const response = await request(app)
                .post('/api/invitations/accept')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({ token: invite.token });

            expect(response.status).toBe(200);

            // 5. Verify promotion
            const updatedUser = await User.findById(customer._id);
            expect(updatedUser?.role).toBe('driver');
            expect(updatedUser?.isApproved).toBe(true);
            expect(updatedUser?.organizationId?.toString()).toBe(testOrg._id.toString());

            // 6. Verify status endpoint (FIX VERIFICATION)
            const statusResponse = await request(app)
                .get('/api/driver-requests/my-status')
                .set('Authorization', `Bearer ${accessToken}`);

            expect(statusResponse.status).toBe(200);
            expect(statusResponse.body.data.status).toBe('approved');
        });

        it('should NOT affect dealership admin invitations (No Regression)', async () => {
            const email = 'new.admin@test-onboarding.com';

            // 1. Create admin invite
            const invite = await Invitation.create({
                email,
                role: 'admin',
                organizationId: testOrg._id,
                token: 'test-token-admin-' + Date.now(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            // 2. Register
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'New Admin',
                    email,
                    password: 'password12345',
                    inviteToken: invite.token
                });

            expect(response.status).toBe(201);

            // 3. Verify role is admin (not driver/employee)
            const user = await User.findOne({ email });
            expect(user?.role).toBe('admin');
            expect(user?.organizationRole).toBe('admin');
        });

        it('should promote customer to employee for member invites (No Regression)', async () => {
            const email = 'customer.to.emp@test-onboarding.com';

            // 1. Create customer
            const customer = await User.create({
                email,
                role: 'customer',
                name: 'CtoE User'
            });

            // 2. Create member invite
            const invite = await Invitation.create({
                email,
                role: 'member',
                organizationId: testOrg._id,
                token: 'test-token-member-' + Date.now(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            // 3. Generate token
            const tokenService = (await import('../src/services/token.service')).default;
            const accessToken = tokenService.generateAccessToken(customer as any);

            // 4. Accept
            await request(app)
                .post('/api/invitations/accept')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({ token: invite.token });

            // 5. Verify
            const updatedUser = await User.findById(customer._id);
            expect(updatedUser?.role).toBe('employee'); // member invite promotes customer to employee
            expect(updatedUser?.organizationRole).toBe('member');
        });

        it('should allow a new user to sign up as a member via bulk invite', async () => {
            const email = 'new.member@test-onboarding.com';

            // 1. Create member invite
            const invite = await Invitation.create({
                email,
                role: 'member',
                organizationId: testOrg._id,
                token: 'test-token-bulk-mem-' + Date.now(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            // 2. Register
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'New Member',
                    email,
                    password: 'password12345',
                    inviteToken: invite.token
                });

            expect(response.status).toBe(201);

            // 3. Verify
            const user = await User.findOne({ email });
            expect(user?.role).toBe('employee');
            expect(user?.organizationRole).toBe('member');
            expect(user?.onboardingCompleted).toBe(true);
        });

        it('should allow a new user to sign up as an admin via bulk invite', async () => {
            const email = 'new.bulk.admin@test-onboarding.com';

            // 1. Create admin invite
            const invite = await Invitation.create({
                email,
                role: 'admin',
                organizationId: testOrg._id,
                token: 'test-token-bulk-adm-' + Date.now(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            // 2. Register
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'New Bulk Admin',
                    email,
                    password: 'password12345',
                    inviteToken: invite.token
                });

            expect(response.status).toBe(201);

            // 3. Verify
            const user = await User.findOne({ email });
            expect(user?.role).toBe('admin');
            expect(user?.organizationRole).toBe('admin');
            expect(user?.onboardingCompleted).toBe(true);
        });
    });
});
