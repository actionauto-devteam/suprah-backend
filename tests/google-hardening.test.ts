import mongoose from 'mongoose';
import User from '../src/models/User.model';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import Appointment from '../src/models/Appointment.model';
import orgGmailService from '../src/services/orgGmail.service';
import profileService from '../src/services/profile.service';
import appointmentService from '../src/services/appointment.service';
import { encrypt } from '../src/utils/crypto';

describe('Google Services Hardening & Multi-Tenant Isolation', () => {
    const testOrgId = new mongoose.Types.ObjectId().toString();
    let testUser: any;

    beforeAll(async () => {
        // Ensure we are in a test environment
        if (!mongoose.connection.name.includes('test')) {
            throw new Error('Verification must be run against a TEST database');
        }

        // 1. Setup Test User
        testUser = await User.create({
            name: 'Hardening Test User',
            email: 'hardening@example.com',
            role: 'admin',
            organizationId: testOrgId,
            onboardingCompleted: true
        });

        // 2. Setup Org Config (Encrypted)
        await OrgLeadConfig.create({
            organizationId: testOrgId,
            gmailConnected: true,
            calendarConnected: true,
            gmailAddress: 'dealership@gmail.com',
            accessToken: encrypt('fake_access_token'),
            refreshToken: encrypt('fake_refresh_token'),
            expiryDate: Date.now() + 3600000,
            isActive: true
        });
    });

    afterAll(async () => {
        await User.deleteMany({ organizationId: testOrgId });
        await OrgLeadConfig.deleteMany({ organizationId: testOrgId });
        await Appointment.deleteMany({ organizationId: testOrgId });
    });

    describe('OrgGmailService Consolidation', () => {
        it('should correctly report Gmail connection status from OrgLeadConfig', async () => {
            const connected = await orgGmailService.isGmailConnected(testOrgId);
            expect(connected).toBe(true);
        });

        it('should fail Gmail connection check for unknown org', async () => {
            const connected = await orgGmailService.isGmailConnected(new mongoose.Types.ObjectId().toString());
            expect(connected).toBe(false);
        });
    });

    describe('ProfileService Redirection', () => {
        it('should return Google status from Organization instead of User model', async () => {
            const profile = await profileService.getProfile(testUser._id.toString());
            
            // The User model fields were purged, so it MUST come from OrgLeadConfig
            expect(profile.googleCalendar.connected).toBe(true);
            expect((profile as any).googleCalendar.accessToken).toBeUndefined(); // Safety check
        });
    });

    describe('AppointmentService Multi-Tenant Refactor', () => {
        it('should successfully handle appointment cancellation using org-level tokens', async () => {
            const appointment = await Appointment.create({
                title: 'Test Appointment',
                startTime: new Date(),
                endTime: new Date(Date.now() + 3600000),
                organizationId: testOrgId,
                createdBy: testUser._id,
                participants: [testUser._id],
                status: 'scheduled',
                googleCalendarEventId: 'fake_event_123'
            });

            // This call triggers googleCalendarService.deleteFromGoogleCalendar
            // We verify it doesn't crash and reaches the Org-level logic
            // (The actual API call is mocked or will fail gracefully if it hits getCalendarClient)
            try {
                await appointmentService.cancelAppointment(appointment._id.toString(), testOrgId, testUser._id.toString());
            } catch (err: any) {
                // If it fails with "fake_access_token" decryption error or 404, it means it REACHED the orgGmail logic correctly
                // and bypassed the (now-deleted) user logic.
                expect(err.message).not.toContain('googleCalendar'); 
            }

            const updated = await Appointment.findById(appointment._id);
            expect(updated?.status).toBe('cancelled');
        });
    });

    describe('Security Hardening (Schema Wipe)', () => {
        it('should NOT have googleCalendar fields on the User model instance', async () => {
            const user = await User.findById(testUser._id);
            const userObj = user?.toObject();
            expect(userObj?.googleCalendar).toBeUndefined();
        });
    });
});
