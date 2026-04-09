import mongoose from 'mongoose';
import DriverProfile, { REQUIRED_COMPLIANCE_DOCS } from '../src/models/DriverProfile.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';

describe('Driver Compliance Logic', () => {
    let testOrg: any;
    const testEmail = 'compliance.driver@test.com';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        await User.deleteMany({ email: testEmail });
        await Organization.deleteMany({ slug: 'compliance-org' });

        testOrg = await Organization.create({
            name: 'Compliance Org',
            slug: 'compliance-org',
            status: 'active'
        });
    }, 30000);

    afterAll(async () => {
        const users = await User.find({ email: testEmail });
        const userIds = users.map(u => u._id);
        
        await User.deleteMany({ email: testEmail });
        await DriverProfile.deleteMany({ userId: { $in: userIds } });
        await Organization.deleteOne({ _id: testOrg?._id });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    it('should calculate 0/7 compliance score when no documents are uploaded', async () => {
        const user = await User.create({
            name: 'Test Driver',
            email: testEmail,
            role: 'driver',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        const profile = await DriverProfile.create({
            userId: user._id,
            organizationId: testOrg._id.toString()
        });

        const uploadedTypes = new Set(profile.documents.map((d: any) => d.type));
        const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter(t => uploadedTypes.has(t)).length;
        const complianceScore = Math.round((uploadedCount / REQUIRED_COMPLIANCE_DOCS.length) * 100);

        expect(uploadedCount).toBe(0);
        expect(complianceScore).toBe(0);
        expect(profile.verificationStatus).toBe('not_started');
    });

    it('should calculate 100% compliance when all 7 documents are uploaded', async () => {
        const fullEmail = 'full.compliance@test.com';
        await User.deleteMany({ email: fullEmail });

        const user = await User.create({
            name: 'Full Driver',
            email: fullEmail,
            role: 'driver',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        const profile = await DriverProfile.create({
            userId: user._id,
            organizationId: testOrg._id.toString()
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
