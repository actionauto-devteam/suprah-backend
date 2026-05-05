import mongoose from 'mongoose';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Appointment from '../src/models/Appointment.model';
import Lead from '../src/models/lead.model';
import CrmUser from '../src/models/CrmUser.model';
import appointmentService from '../src/services/appointment.service';
import googleCalendarService from '../src/services/googleCalendar.service';
import { ApiError } from '../src/utils/ApiError';

// Mock the Google Calendar Service to prevent real API calls
jest.mock('../src/services/googleCalendar.service', () => ({
  isCrmUserCalendarConnected: jest.fn(),
  syncAppointmentToGoogleCalendar: jest.fn().mockResolvedValue('mock-google-id'),
  getCalendarClient: jest.fn()
}));

describe('CRM Appointment Intelligence (Surgical Integration Tests)', () => {
  let createdIds: mongoose.Types.ObjectId[] = [];
  let testOrgId = new mongoose.Types.ObjectId();
  let testCrmUserId = new mongoose.Types.ObjectId();
  let testLeadId: mongoose.Types.ObjectId;

  // Helper to track and create docs
  const trackDoc = async (model: any, data: any) => {
    const doc = await model.create(data);
    createdIds.push(doc._id);
    return doc;
  };

  beforeEach(async () => {
    // Re-register models because setup.ts clears them beforeEach
    if (!mongoose.models.User) mongoose.model('User', User.schema);
    if (!mongoose.models.Organization) mongoose.model('Organization', Organization.schema);
    if (!mongoose.models.Appointment) mongoose.model('Appointment', Appointment.schema);
    if (!mongoose.models.Lead) mongoose.model('Lead', Lead.schema);
    if (!mongoose.models.CrmUser) mongoose.model('CrmUser', CrmUser.schema);
  });

  beforeAll(async () => {
    console.log('[JEST-DIAGNOSTIC] Registered Models:', mongoose.modelNames());
    // Create a dummy lead for testing
    const lead = await trackDoc(Lead, {
      organizationId: testOrgId,
      createdBy: testCrmUserId,
      firstName: '[JEST-TEST] John',
      lastName: 'Doe',
      email: 'john.jest@example.com',
      phone: '1234567890',
      source: 'Test',
      channel: 'web'
    });
    testLeadId = lead._id;

    // Create a dummy CRM User
    await trackDoc(CrmUser, {
      _id: testCrmUserId,
      organizationId: testOrgId,
      fullName: 'Jest Test User',
      username: 'jest_001',
      password: 'password123',
      email: `jest.user.${Date.now()}@example.com`,
      role: 'employee',
      googleCalendar: {
        calendarConnected: true
      }
    });
  });

  afterAll(async () => {
    console.log(`[SURGICAL-CLEANUP] Deleting ${createdIds.length} test records from LIVE database...`);
    for (const id of createdIds) {
      await Appointment.findByIdAndDelete(id);
      await Lead.findByIdAndDelete(id);
      await CrmUser.findByIdAndDelete(id);
    }
    console.log('[SURGICAL-CLEANUP] Done.');
  });

  describe('Conflict Detection (Double-Booking)', () => {
    it('should block scheduling an overlapping appointment', async () => {
      const startTime = new Date();
      startTime.setHours(startTime.getHours() + 24); // Tomorrow
      const endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1);

      // 1. Create the first appointment
      await trackDoc(Appointment, {
        title: '[JEST-TEST-DATA] Existing Meeting',
        startTime,
        endTime,
        organizationId: testOrgId,
        createdBy: testCrmUserId,
        participants: [testCrmUserId],
        status: 'scheduled'
      });

      // 2. Attempt to create a conflicting one
      const conflictStart = new Date(startTime);
      conflictStart.setMinutes(conflictStart.getMinutes() + 30); // 30 mins into the existing one
      const conflictEnd = new Date(conflictStart);
      conflictEnd.setHours(conflictEnd.getHours() + 1);

      await expect(
        appointmentService.createAppointment(testCrmUserId.toString(), testOrgId.toString(), {
          title: '[JEST-TEST-DATA] Conflicting Meeting',
          startTime: conflictStart,
          endTime: conflictEnd,
          type: 'in-person',
          entryType: 'appointment',
          participants: [testCrmUserId.toString()]
        })
      ).rejects.toThrow(/Double-Booking Conflict/);
    });

    it('should allow back-to-back appointments (no overlap)', async () => {
      const startTime = new Date();
      startTime.setHours(startTime.getHours() + 48); // Day after tomorrow
      const endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1);

      // 1. Create first
      await trackDoc(Appointment, {
        title: '[JEST-TEST-DATA] Morning Meeting',
        startTime,
        endTime,
        organizationId: testOrgId,
        createdBy: testCrmUserId,
        participants: [testCrmUserId],
        status: 'scheduled'
      });

      // 2. Create second starting exactly when first ends
      const nextStart = new Date(endTime);
      const nextEnd = new Date(nextStart);
      nextEnd.setHours(nextStart.getHours() + 1);

      const appointment = await appointmentService.createAppointment(testCrmUserId.toString(), testOrgId.toString(), {
        title: '[JEST-TEST-DATA] Afternoon Meeting',
        startTime: nextStart,
        endTime: nextEnd,
        type: 'in-person',
        entryType: 'appointment',
        participants: [testCrmUserId.toString()]
      });

      expect(appointment).toBeDefined();
      createdIds.push(appointment._id);
    });
  });

  describe('Lead Integration', () => {
    it('should link the appointment to the leadId', async () => {
      const startTime = new Date();
      startTime.setHours(startTime.getHours() + 72);
      const endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1);

      const appointment = await appointmentService.createAppointment(testCrmUserId.toString(), testOrgId.toString(), {
        title: '[JEST-TEST-DATA] Lead Appointment',
        startTime,
        endTime,
        type: 'in-person',
        entryType: 'appointment',
        participants: [testCrmUserId.toString()],
        leadId: testLeadId.toString()
      });

      expect(appointment.leadId?.toString()).toBe(testLeadId.toString());
      createdIds.push(appointment._id);

      // Verify Lead status was updated
      const updatedLead = await Lead.findById(testLeadId);
      expect(updatedLead?.status).toBe('Appointment Set');
    });
  });

  describe('Accountability (Status Updates)', () => {
    it('should allow updating status without errors', async () => {
       const apt = await trackDoc(Appointment, {
          title: '[JEST-TEST-DATA] Status Test',
          startTime: new Date(),
          endTime: new Date(Date.now() + 3600000),
          organizationId: testOrgId,
          createdBy: testCrmUserId,
          createdByModel: 'CrmUser',
          participants: [testCrmUserId],
          participantModel: 'CrmUser',
          status: 'scheduled'
       });

       const updated = await appointmentService.updateAppointment(
         apt._id.toString(),
         testOrgId.toString(),
         testCrmUserId.toString(),
         { status: 'confirmed' }
       );

       expect(updated.status).toBe('confirmed');
    });
  });
});
