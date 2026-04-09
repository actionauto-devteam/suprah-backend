import request from 'supertest';
import app from '../src/server';
import Notification from '../src/models/Notification.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Notification API - Organization Isolation', () => {
    let orgA: any;
    let orgB: any;
    let userA: any;
    let userB: any;
    let tokenA: string;
    let tokenB: string;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        const testEmails = ['notif_userA@example.com', 'notif_userB@example.com'];
        await User.deleteMany({ email: { $in: testEmails } });
        await Organization.deleteMany({ slug: { $in: ['notif-org-a', 'notif-org-b'] } });

        // Create Orgs
        orgA = await Organization.create({ name: 'Notif Org A', slug: 'notif-org-a', status: 'active' });
        orgB = await Organization.create({ name: 'Notif Org B', slug: 'notif-org-b', status: 'active' });

        // Create Users
        userA = await User.create({
            email: 'notif_userA@example.com',
            name: 'User A',
            role: 'admin',
            organizationId: orgA._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        userB = await User.create({
            email: 'notif_userB@example.com',
            name: 'User B',
            role: 'admin',
            organizationId: orgB._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        tokenA = tokenService.generateAccessToken(userA);
        tokenB = tokenService.generateAccessToken(userB);
    }, 30000);

    afterAll(async () => {
        await User.deleteMany({ email: { $in: ['notif_userA@example.com', 'notif_userB@example.com'] } });
        await Organization.deleteMany({ _id: { $in: [orgA?._id, orgB?._id] } });
        await Notification.deleteMany({ organizationId: { $in: [orgA?._id.toString(), orgB?._id.toString()] } });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    it('should only return notifications belonging to the user\'s organization', async () => {
        await Notification.create({
            userId: userA._id,
            organizationId: orgA._id.toString(),
            type: 'quote_created',
            title: 'Title A',
            message: 'Message A'
        });

        await Notification.create({
            userId: userB._id,
            organizationId: orgB._id.toString(),
            type: 'quote_created',
            title: 'Title B',
            message: 'Message B'
        });

        const res = await request(app)
            .get('/api/notifications')
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);

        expect(res.body.data.notifications.length).toBe(1);
        expect(res.body.data.notifications[0].organizationId).toBe(orgA._id.toString());
    });

    it('should mark only own organization notifications as read', async () => {
        const notifA = await Notification.create({
            userId: userA._id,
            organizationId: orgA._id.toString(),
            type: 'quote_created',
            title: 'Title A',
            message: 'Message A'
        });

        await request(app)
            .patch(`/api/notifications/${notifA._id}/read`)
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);

        const updated = await Notification.findById(notifA._id);
        expect(updated?.isRead).toBe(true);
    });
});
