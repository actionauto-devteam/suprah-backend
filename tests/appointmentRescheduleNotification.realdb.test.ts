import request from 'supertest';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import { CommunicationMessage } from '../src/models/communication.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';

describe('PUT /api/crm/calendar/appointments/:id — reschedule side effects', () => {
    let testUser: any;
    let testOrg: any;
    let token: string;
    let testLead: any;
    let testAppointment: any;
    const demoPhone = '+18015550142';

    beforeAll(async () => {
        jest.setTimeout(30000);

        testOrg = await Organization.create({
            name: 'Reschedule Notify Test Org',
            slug: 'reschedule-notify-test-' + Date.now(),
            status: 'active',
        });

        testUser = await User.create({
            email: `reschedule-notify-user-${Date.now()}@example.com`,
            password: 'Password123!',
            name: 'Reschedule Notify Tester',
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
            lastName: 'Notify',
            email: 'reschedule-notify-lead@example.com',
            phone: demoPhone,
            organizationId: testOrg._id,
            createdBy: testUser._id,
            source: 'Manual Entry',
            channel: 'sms',
            vehicle: {},
            comments: '',
        });

        testAppointment = await Appointment.create({
            title: 'Demo test drive',
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
            customerBooking: {
                firstName: 'Reschedule',
                lastName: 'Notify',
                email: 'demo.customer@example.com',
                phone: demoPhone,
                isCustomerBooking: false,
            },
        });
    });

    afterAll(async () => {
        if (testAppointment) await Appointment.deleteOne({ _id: testAppointment._id });
        if (testLead) await CommunicationMessage.deleteMany({ leadId: testLead._id });
        if (testLead) await Lead.deleteOne({ _id: testLead._id });
        if (testUser) await User.deleteOne({ _id: testUser._id });
        if (testOrg) await Organization.deleteOne({ _id: testOrg._id });
    });

    it('sends a reschedule notification text to the customer when the time actually changes', async () => {
        const newStartTime = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
        const newEndTime = new Date(newStartTime.getTime() + 3600000);

        await request(app)
            .put(`/api/crm/calendar/appointments/${testAppointment._id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({
                title: testAppointment.title,
                startTime: newStartTime.toISOString(),
                endTime: newEndTime.toISOString(),
                type: 'in-person',
                status: 'scheduled',
                participants: [testUser._id.toString()],
            })
            .expect(200);

        await new Promise((resolve) => setTimeout(resolve, 500));

        const messages = await CommunicationMessage.find({ leadId: testLead._id, direction: 'outbound' }).lean();
        expect(messages.length).toBeGreaterThan(0);
        const latest = messages[messages.length - 1];
        expect(latest.to).toBe(demoPhone);
        expect(latest.body.toLowerCase()).toContain('moved');

        const updated = await Appointment.findById(testAppointment._id).lean();
        expect(new Date((updated as any).startTime).getTime()).toBe(newStartTime.getTime());
    });

    it('does not send a reschedule notification when only a non-time field changes', async () => {
        await CommunicationMessage.deleteMany({ leadId: testLead._id });

        const current = await Appointment.findById(testAppointment._id).lean() as any;

        await request(app)
            .put(`/api/crm/calendar/appointments/${testAppointment._id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({
                title: testAppointment.title,
                startTime: current.startTime,
                endTime: current.endTime,
                notes: 'just a note update',
                type: 'in-person',
                status: 'scheduled',
                participants: [testUser._id.toString()],
            })
            .expect(200);

        await new Promise((resolve) => setTimeout(resolve, 500));

        const messages = await CommunicationMessage.find({ leadId: testLead._id, direction: 'outbound' }).lean();
        expect(messages.length).toBe(0);
    });
});
