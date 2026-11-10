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

// Every new account must meet the password rules (validations/auth.validation.ts).
const PASSWORD = 'Onboarding-Passw0rd!';

// Brought up to date 2026-11-11: strong passwords, driver invitations through
// the staff path are refused (drivers apply through the driver sign-up and the
// Suprah AI team's review), and a staff invitation can only be accepted by the
// account it was sent to, never by a driver account.
describe('Streamlined Onboarding E2E', () => {
    jest.setTimeout(20000);
    let testOrg: any;
    let dealerAdmin: any;

    const accessTokenFor = async (user: any) => {
        const tokenService = (await import('../src/services/token.service')).default;
        return tokenService.generateAccessToken(user as any);
    };

    const inviteFor = (email: string, role: string, tag: string) =>
        Invitation.create({
            email,
            role,
            organizationId: testOrg._id,
            token: `test-token-${tag}-${Date.now()}`,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

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
        it('refuses signing up with a leftover driver invitation (drivers apply through the driver sign-up)', async () => {
            const email = 'driver.invited@test-onboarding.com';
            const invite = await inviteFor(email, 'driver', 'email');

            const response = await request(app)
                .post('/api/auth/register')
                .send({ name: 'Invited Driver Email', email, password: PASSWORD, inviteToken: invite.token });

            expect(response.status).toBe(410);
            expect(await User.findOne({ email })).toBeNull();
            expect((await Invitation.findById(invite._id))?.status).toBe('pending');
        });

        it('should require approval for drivers who sign up without an invite', async () => {
            const email = 'driver.direct@test-onboarding.com';

            // 1. Register without token
            const response = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'Direct Driver Email',
                    email: email,
                    password: PASSWORD,
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
        it('refuses accepting a leftover driver invitation and leaves the customer unchanged', async () => {
            const email = 'customer.to.driver@test-onboarding.com';
            const customer = await User.create({
                email,
                name: 'Existing Customer',
                role: 'customer',
                onboardingCompleted: true,
                emailVerified: true
            });
            const invite = await inviteFor(email, 'driver', 'promote');

            const response = await request(app)
                .post('/api/invitations/accept')
                .set('Authorization', `Bearer ${await accessTokenFor(customer)}`)
                .send({ token: invite.token });

            expect(response.status).toBe(410);
            const unchanged = await User.findById(customer._id);
            expect(unchanged?.role).toBe('customer');
            expect(unchanged?.organizationId).toBeFalsy();
        });

        it('only the account the invitation was sent to can accept it', async () => {
            const someoneElse = await User.create({
                email: 'someone.else@test-onboarding.com',
                name: 'Someone Else',
                role: 'customer',
                onboardingCompleted: true,
                emailVerified: true
            });
            const invite = await inviteFor('invited.staff@test-onboarding.com', 'member', 'other-account');

            const response = await request(app)
                .post('/api/invitations/accept')
                .set('Authorization', `Bearer ${await accessTokenFor(someoneElse)}`)
                .send({ token: invite.token });

            expect(response.status).toBe(403);
            expect(response.body.message).toContain('invited.staff@test-onboarding.com');
            const unchanged = await User.findById(someoneElse._id);
            expect(unchanged?.role).toBe('customer');
            expect((await Invitation.findById(invite._id))?.status).toBe('pending');
        });

        it('a driver account with the invited email cannot become dealership staff', async () => {
            const email = 'driver.to.staff@test-onboarding.com';
            const driver = await User.create({
                email,
                name: 'Existing Driver',
                role: 'driver',
                onboardingCompleted: true,
                emailVerified: true,
                isApproved: false
            });
            const invite = await inviteFor(email, 'member', 'driver-account');

            const response = await request(app)
                .post('/api/invitations/accept')
                .set('Authorization', `Bearer ${await accessTokenFor(driver)}`)
                .send({ token: invite.token });

            expect(response.status).toBe(409);
            const unchanged = await User.findById(driver._id);
            expect(unchanged?.role).toBe('driver');
            expect(unchanged?.organizationId).toBeFalsy();
        });

        it('should NOT affect dealership admin invitations (No Regression)', async () => {
            const email = 'new.admin@test-onboarding.com';
            const invite = await inviteFor(email, 'admin', 'admin');

            const response = await request(app)
                .post('/api/auth/register')
                .send({ name: 'New Admin', email, password: PASSWORD, inviteToken: invite.token });

            expect(response.status).toBe(201);

            // Verify role is admin (not driver/employee)
            const user = await User.findOne({ email });
            expect(user?.role).toBe('admin');
            expect(user?.organizationRole).toBe('admin');
        });

        it('should promote customer to employee for member invites (No Regression)', async () => {
            const email = 'customer.to.emp@test-onboarding.com';
            const customer = await User.create({
                email,
                role: 'customer',
                name: 'CtoE User'
            });
            const invite = await inviteFor(email, 'member', 'member');

            const response = await request(app)
                .post('/api/invitations/accept')
                .set('Authorization', `Bearer ${await accessTokenFor(customer)}`)
                .send({ token: invite.token });

            expect(response.status).toBe(200);
            const updatedUser = await User.findById(customer._id);
            expect(updatedUser?.role).toBe('employee'); // member invite promotes customer to employee
            expect(updatedUser?.organizationRole).toBe('member');
        });

        it('should allow a new user to sign up as a member via bulk invite', async () => {
            const email = 'new.member@test-onboarding.com';
            const invite = await inviteFor(email, 'member', 'bulk-mem');

            const response = await request(app)
                .post('/api/auth/register')
                .send({ name: 'New Member', email, password: PASSWORD, inviteToken: invite.token });

            expect(response.status).toBe(201);
            const user = await User.findOne({ email });
            expect(user?.role).toBe('employee');
            expect(user?.organizationRole).toBe('member');
            expect(user?.onboardingCompleted).toBe(true);
        });

        it('should allow a new user to sign up as an admin via bulk invite', async () => {
            const email = 'new.bulk.admin@test-onboarding.com';
            const invite = await inviteFor(email, 'admin', 'bulk-adm');

            const response = await request(app)
                .post('/api/auth/register')
                .send({ name: 'New Bulk Admin', email, password: PASSWORD, inviteToken: invite.token });

            expect(response.status).toBe(201);
            const user = await User.findOne({ email });
            expect(user?.role).toBe('admin');
            expect(user?.organizationRole).toBe('admin');
            expect(user?.onboardingCompleted).toBe(true);
        });
    });
});
