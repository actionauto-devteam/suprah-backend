import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Invitation from '../src/models/Invitation.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Custom Organization System', () => {
    jest.setTimeout(30000);

    const userA_email = 'usera.org@example.com';
    const userB_email = 'userb.org@example.com';

    let userA: any;
    let userB: any;
    let tokenA: string;
    let tokenB: string;
    let createdOrgId: string;
    let inviteToken: string;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        await User.deleteMany({ email: { $in: [userA_email, userB_email] } });
        await Organization.deleteMany({ slug: 'my-new-org' });

        // Create User A
        userA = await User.create({
            email: userA_email,
            name: 'User A',
            role: 'customer',
            emailVerified: true,
            onboardingCompleted: true
        });
        tokenA = tokenService.generateAccessToken(userA);

        // Create User B
        userB = await User.create({
            email: userB_email,
            name: 'User B',
            role: 'customer',
            emailVerified: true,
            onboardingCompleted: true
        });
        tokenB = tokenService.generateAccessToken(userB);
    }, 30000);

    afterAll(async () => {
        await User.deleteMany({ email: { $in: [userA_email, userB_email] } });
        if (createdOrgId) {
            await Organization.deleteMany({ _id: createdOrgId });
            await Invitation.deleteMany({ organizationId: createdOrgId });
        }
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    it('should create an organization', async () => {
        const res = await request(app)
            .post('/api/organizations')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
                name: 'My New Org',
                slug: 'my-new-org'
            })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('My New Org');
        createdOrgId = res.body.data._id;

        // Verify User A is updated
        const updatedUserA = await User.findById(userA._id);
        expect(updatedUserA?.organizationId?.toString()).toBe(createdOrgId);
        expect(updatedUserA?.organizationRole).toBe('admin');
        
        // Refresh token for User A because role changed
        tokenA = tokenService.generateAccessToken(updatedUserA as any);
    });

    it('should invite a member', async () => {
        const res = await request(app)
            .post('/api/invitations')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
                email: userB_email,
                role: 'member'
            })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.token).toBeDefined();
        inviteToken = res.body.data.token;

        // Verify Invitation in DB
        const invite = await Invitation.findOne({ token: inviteToken });
        expect(invite?.email).toBe(userB_email);
        expect(invite?.organizationId.toString()).toBe(createdOrgId);
    });

    it('should validate an invitation token', async () => {
        const res = await request(app)
            .get(`/api/invitations/validate/${inviteToken}`)
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.data.email).toBe(userB_email);
        expect(res.body.data.organizationId._id).toBe(createdOrgId);
    });

    it('should accept an invitation', async () => {
        const res = await request(app)
            .post('/api/invitations/accept')
            .set('Authorization', `Bearer ${tokenB}`)
            .send({
                token: inviteToken
            })
            .expect(200);

        expect(res.body.success).toBe(true);

        // Verify User B is updated
        const updatedUserB = await User.findById(userB._id);
        expect(updatedUserB?.organizationId?.toString()).toBe(createdOrgId);
        expect(updatedUserB?.organizationRole).toBe('member');

        // Verify Invitation status
        const invite = await Invitation.findOne({ token: inviteToken });
        expect(invite?.status).toBe('accepted');
    });
});
