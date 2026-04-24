import request from 'supertest';
import app from '../src/server';
import { storageService } from '../src/services/storage.service';
import User from '../src/models/User.model';
import DriverProfile from '../src/models/DriverProfile.model';
import Load from '../src/models/Load.model';
import SupraSpaceConversation from '../src/models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../src/models/SupraSpaceMessage.model';
import tokenService from '../src/services/token.service';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';

describe('Security Hardening Audit: Private Asset Access', () => {
    let testOrg: any;
    let driver: any;
    let admin: any;
    let driverToken: string;
    let adminToken: string;
    
    let loadId: mongoose.Types.ObjectId;
    let conversationId: mongoose.Types.ObjectId;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        const testEmails = ['driver@verify.com', 'admin@verify.com'];
        await User.deleteMany({ email: { $in: testEmails } });
        await Organization.deleteMany({ slug: 'verify-org' });

        // Mock Storage Service
        jest.spyOn(storageService, 'getSignedUrl').mockImplementation(async (key: string) => {
            if (key.startsWith('http')) return key;
            return `https://signed.r2.dev/${key}?token=mocked_token`;
        });

        // Setup Test Org
        testOrg = await Organization.create({
            name: 'Verify Org',
            slug: 'verify-org',
            status: 'active'
        });

        // Setup Test Users
        driver = await User.create({ 
            email: 'driver@verify.com', 
            name: 'Verification Driver', 
            role: 'driver',
            organizationId: testOrg._id,
            onboardingCompleted: true,
            emailVerified: true,
            isActive: true,
            isApproved: true
        });
        driverToken = tokenService.generateAccessToken(driver);

        admin = await User.create({
            email: 'admin@verify.com',
            name: 'Verification Admin',
            role: 'admin',
            organizationId: testOrg._id,
            onboardingCompleted: true,
            emailVerified: true,
            isActive: true,
            isApproved: true
        });
        adminToken = tokenService.generateAccessToken(admin);

        // Setup Private Asset Records
        await DriverProfile.create({
            userId: driver._id,
            organizationId: testOrg._id,
            documents: [
                {
                    type: 'drivers_license',
                    label: 'License',
                    fileUrl: 'private/driver-documents/license.jpg',
                    fileKey: 'private/driver-documents/license.jpg',
                    fileName: 'license.jpg',
                    fileSize: 1024,
                    mimeType: 'image/jpeg'
                }
            ]
        });

        const load = await Load.create({
            organizationId: testOrg._id.toString(),
            loadNumber: 'VERIFY-123',
            status: 'Delivered',
            createdBy: admin._id,
            pickupLocation: { city: 'SLC', state: 'UT', zip: '84101', address: '123' },
            deliveryLocation: { city: 'Provo', state: 'UT', zip: '84601', address: '456' },
            proofOfDelivery: { imageUrl: 'private/proofs/delivery.jpg' }
        });
        loadId = load._id as mongoose.Types.ObjectId;

        const conv = await SupraSpaceConversation.create({
            type: 'direct',
            members: [driver._id, admin._id],
            createdBy: admin._id,
            isActive: true
        });
        conversationId = conv._id as mongoose.Types.ObjectId;

        await SupraSpaceMessage.create({
            conversationId: conv._id,
            sender: driver._id,
            type: 'file',
            attachments: [
                {
                    url: 'private/chat/secret.pdf',
                    originalName: 'secret.pdf',
                    mimeType: 'application/pdf',
                    size: 512,
                    fileKey: 'private/chat/secret.pdf'
                }
            ]
        });
    }, 60000);

    afterAll(async () => {
        const testEmails = ['driver@verify.com', 'admin@verify.com'];
        const users = await User.find({ email: { $in: testEmails } });
        const userIds = users.map(u => u._id);

        await DriverProfile.deleteMany({ userId: { $in: userIds } });
        await Load.deleteMany({ organizationId: testOrg?._id.toString() });
        await SupraSpaceConversation.deleteMany({ _id: conversationId });
        await SupraSpaceMessage.deleteMany({ conversationId: conversationId });
        await User.deleteMany({ _id: { $in: userIds } });
        await Organization.deleteOne({ _id: testOrg?._id });

        jest.restoreAllMocks();
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    describe('Driver Profile Security', () => {
        it('should return a signed URL for private documents', async () => {
            const res = await request(app)
                .get('/api/driver-profile')
                .set('Authorization', `Bearer ${driverToken}`)
                .expect(200);

            const doc = res.body.data.documents.find((d: any) => d.type === 'drivers_license');
            expect(doc.fileUrl).toContain('mocked_token');
        });
    });

    describe('Load Proof Security', () => {
        it('should sign the proofOfDelivery URL for loads', async () => {
            const res = await request(app)
                .get(`/api/loads/${loadId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);

            expect(res.body.data.proofOfDelivery.imageUrl).toContain('mocked_token');
        });
    });

    describe('SupraSpace Message Security', () => {
        it('should sign attachment URLs in chat messages', async () => {
            const res = await request(app)
                .get(`/api/supraspace/conversations/${conversationId}/messages`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);

            const messages = res.body.data;
            expect(messages.length).toBeGreaterThan(0);
            const attachment = messages[0].attachments[0];
            expect(attachment.url).toContain('mocked_token');
        });
    });
});
