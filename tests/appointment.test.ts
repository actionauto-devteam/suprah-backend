import request from 'supertest';
import app from '../src/server';
import Appointment from '../src/models/Appointment.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Appointment API - Organization Isolation', () => {
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
        const testEmails = ['app_userA@example.com', 'app_userB@example.com'];
        await User.deleteMany({ email: { $in: testEmails } });
        await Organization.deleteMany({ slug: { $in: ['org-a', 'org-b'] } });

        // Create Orgs
        orgA = await Organization.create({ name: 'Org A', slug: 'org-a', status: 'active' });
        orgB = await Organization.create({ name: 'Org B', slug: 'org-b', status: 'active' });

        // Create Users
        userA = await User.create({
            email: 'app_userA@example.com',
            name: 'User A',
            role: 'admin',
            organizationId: orgA._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        userB = await User.create({
            email: 'app_userB@example.com',
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
        await User.deleteMany({ email: { $in: ['app_userA@example.com', 'app_userB@example.com'] } });
        await Organization.deleteMany({ _id: { $in: [orgA?._id, orgB?._id] } });
        await Appointment.deleteMany({ organizationId: { $in: [orgA?._id, orgB?._id] } });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    it('should only return appointments belonging to the user\'s organization', async () => {
        const futureDate = new Date();
        futureDate.setHours(futureDate.getHours() + 1);

        // 1. Create appointment for Org A
        await Appointment.create({
            title: 'Org A Meeting',
            startTime: futureDate,
            endTime: new Date(futureDate.getTime() + 3600000),
            organizationId: orgA._id.toString(),
            createdBy: userA._id,
            participants: [userA._id],
            entryType: 'appointment'
        });

        // 2. Create appointment for Org B
        await Appointment.create({
            title: 'Org B Meeting',
            startTime: futureDate,
            endTime: new Date(futureDate.getTime() + 3600000),
            organizationId: orgB._id.toString(),
            createdBy: userB._id,
            participants: [userB._id],
            entryType: 'appointment'
        });

        // 3. Request as Org A user
        const resA = await request(app)
            .get('/api/appointments')
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);

        expect(resA.body.data.appointments.length).toBe(1);
        expect(resA.body.data.appointments[0].organizationId).toBe(orgA._id.toString());
        expect(resA.body.data.appointments[0].title).toBe('Org A Meeting');

        // 4. Request as Org B user
        const resB = await request(app)
            .get('/api/appointments')
            .set('Authorization', `Bearer ${tokenB}`)
            .expect(200);

        expect(resB.body.data.appointments.length).toBe(1);
        expect(resB.body.data.appointments[0].organizationId).toBe(orgB._id.toString());
        expect(resB.body.data.appointments[0].title).toBe('Org B Meeting');
    });

    it('should prevent access to an appointment from a different organization', async () => {
        const futureDate = new Date();
        futureDate.setHours(futureDate.getHours() + 1);

        // 1. Create appointment for Org A
        const apptA = await Appointment.create({
            title: 'Private Meeting',
            startTime: futureDate,
            endTime: new Date(futureDate.getTime() + 3600000),
            organizationId: orgA._id.toString(),
            createdBy: userA._id,
            participants: [userA._id],
            entryType: 'appointment'
        });

        // 2. Attempt to fetch it as Org B user
        const res = await request(app)
            .get(`/api/appointments/${apptA._id}`)
            .set('Authorization', `Bearer ${tokenB}`)
            .expect(404);

        expect(res.body.message).toContain('not found');
    });

    it('should assign correct organizationId when creating a new appointment', async () => {
        const futureDate = new Date();
        futureDate.setHours(futureDate.getHours() + 2);

        const newAppt = {
            title: 'New Appointment',
            startTime: futureDate,
            endTime: new Date(futureDate.getTime() + 3600000),
            type: 'in-person',
            entryType: 'appointment'
        };

        const res = await request(app)
            .post('/api/appointments')
            .set('Authorization', `Bearer ${tokenA}`)
            .send(newAppt)
            .expect(201);

        expect(res.body.data.organizationId).toBe(orgA._id.toString());
        expect(res.body.data.createdBy._id).toBe(userA._id.toString());

        const savedAppt = await Appointment.findById(res.body.data._id);
        expect(savedAppt?.organizationId.toString()).toBe(orgA._id.toString());
    });
});
