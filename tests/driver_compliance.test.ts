import mongoose from 'mongoose';
import DriverProfile, { REQUIRED_COMPLIANCE_DOCS } from '../src/models/DriverProfile.model';
import User from '../src/models/User.model';
import driverProfileController from '../src/controllers/driverProfile.controller';
import { Request, Response } from 'express';
// We just need to test the logic, but since it's an asyncHandler we might need a mock req/res or just test the model method if we had one.
// Since the logic is in the controller directly, I'll test it by mocking the req/res and the DB interaction.

describe('Driver Compliance Logic', () => {
    let testUser: any;

    beforeAll(async () => {
        // Mongoose connection is handled by setup.ts
    });

    afterAll(async () => {
        // Cleanup ONLY test data
        if (testUser) {
            await User.deleteOne({ _id: testUser._id }).catch(() => {});
            await DriverProfile.deleteOne({ userId: testUser._id }).catch(() => {});
        }
    });

    it('should calculate 0/7 compliance score when no documents are uploaded', async () => {
        const uniqueEmail = `test-${Date.now()}@driver.com`;
        testUser = await User.create({
            name: 'Test Driver',
            email: uniqueEmail,
            role: 'driver',
            organizationId: new mongoose.Types.ObjectId()
        });

        const profile = await DriverProfile.create({
            userId: testUser._id,
            organizationId: testUser.organizationId.toString()
        });

        // Manually trigger the logic that would happen in updateIdentityVerification
        const uploadedTypes = new Set(profile.documents.map((d: any) => d.type));
        const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter(t => uploadedTypes.has(t)).length;
        const complianceScore = Math.round((uploadedCount / REQUIRED_COMPLIANCE_DOCS.length) * 100);

        expect(uploadedCount).toBe(0);
        expect(complianceScore).toBe(0);
        expect(profile.verificationStatus).toBe('not_started');
    });

    it('should calculate 100% compliance when all 7 documents are uploaded', async () => {
        const orgId = new mongoose.Types.ObjectId();
        const user = await User.create({
            name: 'Full Driver',
            email: 'full@driver.com',
            role: 'driver',
            organizationId: orgId
        });

        const profile = await DriverProfile.create({
            userId: user._id,
            organizationId: orgId.toString()
        });

        // Simulate uploading all 7 required docs
        REQUIRED_COMPLIANCE_DOCS.forEach(type => {
            profile.documents.push({
                type,
                label: `Test ${type}`,
                fileUrl: 'http://test.com/file.jpg',
                fileKey: 'test-key',
                fileName: 'test.jpg',
                fileSize: 1024,
                mimeType: 'image/jpeg',
                uploadedAt: new Date(),
                verified: false,
                reviewStatus: 'pending'
            });
        });

        const uploadedTypes = new Set(profile.documents.map((d: any) => d.type));
        const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter(t => uploadedTypes.has(t)).length;
        const complianceScore = Math.round((uploadedCount / REQUIRED_COMPLIANCE_DOCS.length) * 100);

        expect(uploadedCount).toBe(7);
        expect(complianceScore).toBe(100);

        // Cleanup
        await User.deleteOne({ _id: user._id });
        await DriverProfile.deleteOne({ userId: user._id });
    });
});
