import request from 'supertest';
import app from '../src/server';
import Appointment from '../src/models/Appointment.model';
import User from '../src/models/User.model';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Appointment API - Organization Isolation', () => {
    const orgA = 'app_org_A';
    const orgB = 'app_org_B';
    const userA_id = 'app_clerk_A';
    const userB_id = 'app_clerk_B';
    let mongoUserA_id: mongoose.Types.ObjectId;
    let mongoUserB_id: mongoose.Types.ObjectId;

    beforeAll(async () => {
        // Create users in DB
        const userA = await User.create({
            clerkId: userA_id,
            email: 'app_userA@example.com',
            name: 'User A',
            role: 'user'
        });
        mongoUserA_id = userA._id as mongoose.Types.ObjectId;

        const userB = await User.create({
            clerkId: userB_id,
            email: 'app_userB@example.com',
            name: 'User B',
            role: 'user'
        });
        mongoUserB_id = userB._id as mongoose.Types.ObjectId;
    }, 15000);

    beforeEach(async () => {
        const dbName = mongoose.connection.name;
        if (dbName && dbName.includes('test')) {
            await Appointment.deleteMany({});
        }
    });

    afterAll(async () => {
        const dbName = mongoose.connection.name;
        if (dbName && dbName.includes('test')) {
            await User.deleteMany({ clerkId: { $in: [userA_id, userB_id] } });
            await Appointment.deleteMany({});
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
            organizationId: orgA,
            createdBy: mongoUserA_id,
            participants: [mongoUserA_id],
            entryType: 'appointment'
        });

        // 2. Create appointment for Org B
        await Appointment.create({
            title: 'Org B Meeting',
            startTime: futureDate,
            endTime: new Date(futureDate.getTime() + 3600000),
            organizationId: orgB,
            createdBy: mongoUserB_id,
            participants: [mongoUserB_id],
            entryType: 'appointment'
        });

        // 3. Request as Org A user
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const resA = await request(app)
            .get('/api/appointments')
            .set('Authorization', 'Bearer token_A')
            .expect(200);

        expect(resA.body.data.appointments.length).toBe(1);
        expect(resA.body.data.appointments[0].organizationId).toBe(orgA);
        expect(resA.body.data.appointments[0].title).toBe('Org A Meeting');

        // 4. Request as Org B user
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userB_id,
            sid: 'sess_B',
            org_id: orgB,
            org_role: 'org:member'
        });

        const resB = await request(app)
            .get('/api/appointments')
            .set('Authorization', 'Bearer token_B')
            .expect(200);

        expect(resB.body.data.appointments.length).toBe(1);
        expect(resB.body.data.appointments[0].organizationId).toBe(orgB);
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
            organizationId: orgA,
            createdBy: mongoUserA_id,
            participants: [mongoUserA_id],
            entryType: 'appointment'
        });

        // 2. Attempt to fetch it as Org B user
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userB_id,
            sid: 'sess_B',
            org_id: orgB,
            org_role: 'org:member'
        });

        const res = await request(app)
            .get(`/api/appointments/${apptA._id}`)
            .set('Authorization', 'Bearer token_B')
            .expect(404);

        expect(res.body.message).toContain('not found');
    });

    it('should assign correct organizationId when creating a new appointment', async () => {
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

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
            .set('Authorization', 'Bearer token_A')
            .send(newAppt)
            .expect(201);

        expect(res.body.data.organizationId).toBe(orgA);
        expect(res.body.data.createdBy._id).toBe(mongoUserA_id.toString());

        const savedAppt = await Appointment.findById(res.body.data._id);
        expect(savedAppt?.organizationId).toBe(orgA);
    });
});
