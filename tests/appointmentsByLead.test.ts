import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';

describe('GET /api/leads/:id/appointments', () => {
    let testUser: any;
    let testOrg: any;
    let token: string;
    let testLead: any;
    let otherOrgLead: any;

    beforeAll(async () => {
        jest.setTimeout(30000);

        testOrg = await Organization.create({
            name: 'Reschedule Test Org',
            slug: 'reschedule-test-' + Date.now(),
            status: 'active',
        });

        testUser = await User.create({
            email: `reschedule-user-${Date.now()}@example.com`,
            password: 'Password123!',
            name: 'Reschedule Tester',
            role: 'admin',
            organizationId: testOrg._id,
            organizationRole: 'admin',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true,
        });

        token = tokenService.generateAccessToken(testUser);

        testLead = await Lead.create({
            firstName: 'Reschedule',
            lastName: 'Lead',
            email: 'reschedule-lead@example.com',
            organizationId: testOrg._id,
            createdBy: testUser._id,
            source: 'Manual Entry',
            channel: 'email',
            vehicle: {},
            comments: '',
        });

        const otherOrgId = new mongoose.Types.ObjectId();

        otherOrgLead = await Lead.create({
            firstName: 'Other Org',
            lastName: 'Lead',
            email: 'other-org-lead@example.com',
            organizationId: otherOrgId,
            createdBy: testUser._id,
            source: 'Manual Entry',
            channel: 'email',
            vehicle: {},
            comments: '',
        });

        await Appointment.insertMany([
            {
                title: 'Scheduled later',
                startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
                endTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 3600000),
                status: 'scheduled',
                entryType: 'appointment',
                organizationId: testOrg._id.toString(),
                createdBy: testUser._id,
                createdByModel: 'User',
                participants: [testUser._id],
                participantModel: 'User',
                leadId: testLead._id,
            },
            {
                title: 'Confirmed sooner',
                startTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
                endTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 3600000),
                status: 'confirmed',
                entryType: 'appointment',
                organizationId: testOrg._id.toString(),
                createdBy: testUser._id,
                createdByModel: 'User',
                participants: [testUser._id],
                participantModel: 'User',
                leadId: testLead._id,
            },
            {
                title: 'Already cancelled',
                startTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
                endTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 3600000),
                status: 'cancelled',
                entryType: 'appointment',
                organizationId: testOrg._id.toString(),
                createdBy: testUser._id,
                createdByModel: 'User',
                participants: [testUser._id],
                participantModel: 'User',
                leadId: testLead._id,
            },
            {
                title: 'Already completed',
                startTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
                endTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 + 3600000),
                status: 'completed',
                entryType: 'appointment',
                organizationId: testOrg._id.toString(),
                createdBy: testUser._id,
                createdByModel: 'User',
                participants: [testUser._id],
                participantModel: 'User',
                leadId: testLead._id,
            },
            {
                title: 'No-show, excluded',
                startTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
                endTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 3600000),
                status: 'no-show',
                entryType: 'appointment',
                organizationId: testOrg._id.toString(),
                createdBy: testUser._id,
                createdByModel: 'User',
                participants: [testUser._id],
                participantModel: 'User',
                leadId: testLead._id,
            },
            {
                title: 'Different org, excluded',
                startTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
                endTime: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 3600000),
                status: 'scheduled',
                entryType: 'appointment',
                organizationId: otherOrgLead.organizationId.toString(),
                createdBy: testUser._id,
                createdByModel: 'User',
                participants: [testUser._id],
                participantModel: 'User',
                leadId: otherOrgLead._id,
            },
        ]);
    });

    afterAll(async () => {
        if (testLead) await Appointment.deleteMany({ leadId: { $in: [testLead._id, otherOrgLead?._id] } });
        if (testLead) await Lead.deleteOne({ _id: testLead._id });
        if (otherOrgLead) await Lead.deleteOne({ _id: otherOrgLead._id });
        if (testUser) await User.deleteOne({ _id: testUser._id });
        if (testOrg) await Organization.deleteOne({ _id: testOrg._id });
    });

    it('returns only scheduled/confirmed appointments for the lead, sorted ascending by startTime', async () => {
        const res = await request(app)
            .get(`/api/leads/${testLead._id}/appointments`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        const appointments = res.body.data.appointments;
        expect(appointments).toHaveLength(2);
        expect(appointments.map((a: any) => a.title)).toEqual(['Confirmed sooner', 'Scheduled later']);
    });

    it('never returns an appointment belonging to a different organization', async () => {
        const res = await request(app)
            .get(`/api/leads/${testLead._id}/appointments`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        const titles = res.body.data.appointments.map((a: any) => a.title);
        expect(titles).not.toContain('Different org, excluded');
    });

    it('returns an empty list for a lead with no reschedulable appointments', async () => {
        const freshLead = await Lead.create({
            firstName: 'No',
            lastName: 'Appointments',
            email: 'no-appointments@example.com',
            organizationId: testOrg._id,
            createdBy: testUser._id,
            source: 'Manual Entry',
            channel: 'email',
            vehicle: {},
            comments: '',
        });

        const res = await request(app)
            .get(`/api/leads/${freshLead._id}/appointments`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.appointments).toEqual([]);

        await Lead.deleteOne({ _id: freshLead._id });
    });
});
