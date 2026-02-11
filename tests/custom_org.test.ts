import request from 'supertest';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Invitation from '../src/models/Invitation.model';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Custom Organization System', () => {
    jest.setTimeout(30000); // Increase global timeout for this suite

    const userA_clerkId = 'clerk_user_A';
    const userB_clerkId = 'clerk_user_B';
    const userA_email = 'usera@example.com';
    const userB_email = 'userb@example.com';

    let userA_id: mongoose.Types.ObjectId;
    let userB_id: mongoose.Types.ObjectId;
    let createdOrgId: string;
    let inviteToken: string;

    beforeAll(async () => {
        // Cleanup
        await User.deleteMany({});
        await Organization.deleteMany({});
        await Invitation.deleteMany({});

        // Create User A (Owner)
        const userA = await User.create({
            clerkId: userA_clerkId,
            email: userA_email,
            name: 'User A',
            role: 'user'
        });
        userA_id = userA._id as mongoose.Types.ObjectId;

        // Create User B (Invitee)
        const userB = await User.create({
            clerkId: userB_clerkId,
            email: userB_email,
            name: 'User B',
            role: 'user'
        });
        userB_id = userB._id as mongoose.Types.ObjectId;
    });

    afterAll(async () => {
        await User.deleteMany({});
        await Organization.deleteMany({});
        await Invitation.deleteMany({});
    });

    it('should create an organization', async () => {
        // Mock Auth for User A
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_clerkId,
            sid: 'sess_A',
        });
        // Mock getUser for User A (middleware fallback)
        mockedClerk.users.getUser.mockResolvedValueOnce({
            id: userA_clerkId,
            emailAddresses: [{ emailAddress: userA_email }],
            firstName: 'User',
            lastName: 'A',
            imageUrl: 'http://img'
        });

        const res = await request(app)
            .post('/api/organizations')
            .set('Authorization', 'Bearer token_A')
            .send({
                name: 'My New Org',
                slug: 'my-new-org'
            })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('My New Org');
        createdOrgId = res.body.data._id;

        // Verify User A is updated
        const updatedUserA = await User.findById(userA_id);
        expect(updatedUserA?.organizationId?.toString()).toBe(createdOrgId);
        expect(updatedUserA?.organizationRole).toBe('admin');
    });

    it('should invite a member', async () => {
        // Mock Auth for User A
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_clerkId,
            sid: 'sess_A',
        });

        const res = await request(app)
            .post('/api/invitations')
            .set('Authorization', 'Bearer token_A')
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
        // Mock Auth for User B
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userB_clerkId,
            sid: 'sess_B',
        });
        // Mock getUser for User B
        mockedClerk.users.getUser.mockResolvedValueOnce({
            id: userB_clerkId,
            emailAddresses: [{ emailAddress: userB_email }],
            firstName: 'User',
            lastName: 'B',
            imageUrl: 'http://img'
        });


        const res = await request(app)
            .post('/api/invitations/accept')
            .set('Authorization', 'Bearer token_B')
            .send({
                token: inviteToken
            })
            .expect(200);

        expect(res.body.success).toBe(true);

        // Verify User B is updated
        const updatedUserB = await User.findById(userB_id);
        expect(updatedUserB?.organizationId?.toString()).toBe(createdOrgId);
        expect(updatedUserB?.organizationRole).toBe('member');

        // Verify Invitation status
        const invite = await Invitation.findOne({ token: inviteToken });
        expect(invite?.status).toBe('accepted');
    });
});
