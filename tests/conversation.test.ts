import request from 'supertest';
import app from '../src/server';
import Conversation from '../src/models/Conversation.model';
import User from '../src/models/User.model';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Conversation API - Organization Isolation', () => {
    const orgA = 'conv_org_A';
    const orgB = 'conv_org_B';
    const userA_id = 'conv_clerk_A';
    const userB_id = 'conv_clerk_B';
    let mongoUserA_id: mongoose.Types.ObjectId;
    let mongoUserB_id: mongoose.Types.ObjectId;

    beforeAll(async () => {
        const userA = await User.create({ clerkId: userA_id, email: 'conv_userA@example.com', name: 'User A', role: 'user' });
        mongoUserA_id = userA._id as mongoose.Types.ObjectId;

        const userB = await User.create({ clerkId: userB_id, email: 'conv_userB@example.com', name: 'User B', role: 'user' });
        mongoUserB_id = userB._id as mongoose.Types.ObjectId;
    });

    afterAll(async () => {
        await User.deleteMany({ clerkId: { $in: [userA_id, userB_id] } });
        await Conversation.deleteMany({ organizationId: { $in: [orgA, orgB] } });
    });

    it('should only return conversations belonging to the user\'s organization', async () => {
        await Conversation.create({
            type: 'direct',
            organizationId: orgA,
            participants: [mongoUserA_id]
        });

        await Conversation.create({
            type: 'direct',
            organizationId: orgB,
            participants: [mongoUserB_id]
        });

        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const res = await request(app)
            .get('/api/conversations')
            .set('Authorization', 'Bearer token_A')
            .expect(200);

        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].organizationId).toBe(orgA);
    });

    it('should create conversation with correct organizationId', async () => {
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const res = await request(app)
            .post('/api/conversations')
            .set('Authorization', 'Bearer token_A')
            .send({
                participants: [mongoUserA_id.toString()],
                message: 'Hello'
            })
            .expect(201);

        expect(res.body.data.organizationId).toBe(orgA);

        const saved = await Conversation.findById(res.body.data._id);
        expect(saved?.organizationId).toBe(orgA);
    });
});
