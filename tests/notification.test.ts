import request from 'supertest';
import app from '../src/server';
import Notification from '../src/models/Notification.model';
import User from '../src/models/User.model';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Notification API - Organization Isolation', () => {
    const orgA = 'notif_org_A';
    const orgB = 'notif_org_B';
    const userA_id = 'notif_clerk_A';
    const userB_id = 'notif_clerk_B';
    let mongoUserA_id: mongoose.Types.ObjectId;
    let mongoUserB_id: mongoose.Types.ObjectId;

    beforeAll(async () => {
        const userA = await User.create({ clerkId: userA_id, email: 'notif_userA@example.com', name: 'User A', role: 'user' });
        mongoUserA_id = userA._id as mongoose.Types.ObjectId;

        const userB = await User.create({ clerkId: userB_id, email: 'notif_userB@example.com', name: 'User B', role: 'user' });
        mongoUserB_id = userB._id as mongoose.Types.ObjectId;
    }, 15000);

    afterAll(async () => {
        await User.deleteMany({ clerkId: { $in: [userA_id, userB_id] } });
        await Notification.deleteMany({ organizationId: { $in: [orgA, orgB] } });
    });

    it('should only return notifications belonging to the user\'s organization', async () => {
        await Notification.create({
            userId: mongoUserA_id,
            organizationId: orgA,
            type: 'quote_created',
            title: 'Title A',
            message: 'Message A'
        });

        await Notification.create({
            userId: mongoUserB_id,
            organizationId: orgB,
            type: 'quote_created',
            title: 'Title B',
            message: 'Message B'
        });

        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const res = await request(app)
            .get('/api/notifications')
            .set('Authorization', 'Bearer token_A')
            .expect(200);

        expect(res.body.data.notifications.length).toBe(1);
        expect(res.body.data.notifications[0].organizationId).toBe(orgA);
    });

    it('should mark only own organization notifications as read', async () => {
        const notifA = await Notification.create({
            userId: mongoUserA_id,
            organizationId: orgA,
            type: 'quote_created',
            title: 'Title A',
            message: 'Message A'
        });

        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        await request(app)
            .patch(`/api/notifications/${notifA._id}/read`)
            .set('Authorization', 'Bearer token_A')
            .expect(200);

        const updated = await Notification.findById(notifA._id);
        expect(updated?.isRead).toBe(true);
    });
});
