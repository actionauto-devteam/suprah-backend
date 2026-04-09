import request from 'supertest';
import app from '../src/server';
import { storageService } from '../src/services/storage.service';
import User from '../src/models/User.model';
import DriverProfile from '../src/models/DriverProfile.model';
import Load from '../src/models/Load.model';
import SupraSpaceConversation from '../src/models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../src/models/SupraSpaceMessage.model';
import tokenService from '../src/services/token.service';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

// Full module mock to ensure absolute interception in all middlewares
jest.mock('../src/services/token.service', () => ({
    __esModule: true,
    default: {
        verifyAccessToken: jest.fn()
    }
}));

const mockedClerk = clerkClient as jest.Mocked<any>;
const mockedTokenService = tokenService as jest.Mocked<any>;

describe('Security Hardening Audit: Private Asset Access', () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    const driverId = 'verify_driver_clerk';
    const adminId = 'verify_admin_clerk';
    
    let dbDriverId: mongoose.Types.ObjectId;
    let dbAdminId: mongoose.Types.ObjectId;
    let loadId: mongoose.Types.ObjectId;
    let conversationId: mongoose.Types.ObjectId;

    beforeAll(async () => {
        // Mock Storage Service
        jest.spyOn(storageService, 'getSignedUrl').mockImplementation(async (key: string) => {
            if (key.startsWith('http')) return key;
            return `https://signed.r2.dev/${key}?token=mocked_token`;
        });
    });

    beforeEach(async () => {
        // Setup Test Users
        const driver = await User.create({ 
            clerkId: driverId, 
            email: 'driver@verify.com', 
            name: 'Verification Driver', 
            role: 'driver',
            organizationId: new mongoose.Types.ObjectId(orgId),
            onboardingCompleted: true,
            emailVerified: true,
            isActive: true,
            isApproved: true
        });
        dbDriverId = driver._id as mongoose.Types.ObjectId;

        const admin = await User.create({
            clerkId: adminId,
            email: 'admin@verify.com',
            name: 'Verification Admin',
            role: 'admin',
            organizationId: new mongoose.Types.ObjectId(orgId),
            onboardingCompleted: true,
            emailVerified: true,
            isActive: true,
            isApproved: true
        });
        dbAdminId = admin._id as mongoose.Types.ObjectId;

        // Configure Mocked Token Service for this specific iteration
        mockedTokenService.verifyAccessToken.mockImplementation((token: string) => {
            if (token === 'driver-token') {
                return { sub: dbDriverId.toString(), email: 'driver@verify.com', role: 'driver', orgId };
            }
            if (token === 'admin-token') {
                return { sub: dbAdminId.toString(), email: 'admin@verify.com', role: 'admin', orgId };
            }
            throw new Error('Invalid test token');
        });

        // Setup Private Asset Records
        await DriverProfile.create({
            userId: driver._id,
            organizationId: new mongoose.Types.ObjectId(orgId),
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
            organizationId: orgId,
            loadNumber: 'VERIFY-123',
            status: 'Delivered',
            createdBy: dbAdminId,
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
    });

    afterAll(async () => {
        jest.restoreAllMocks();
    });

    describe('Driver Profile Security', () => {
        it('should return a signed URL for private documents', async () => {
            mockedClerk.verifyToken.mockResolvedValueOnce({
                sub: driverId,
                sid: 'sess_1',
                org_id: orgId,
                org_role: 'driver'
            });

            const res = await request(app)
                .get('/api/driver-profile')
                .set('Authorization', `Bearer driver-token`)
                .expect(200);

            const privateDoc = res.body.data.documents.find((d: any) => d.label === 'License');
            expect(privateDoc.fileUrl).toContain('mocked_token');
        });
    });

    describe('Load Proof Security', () => {
        it('should sign the proofOfDelivery URL for loads', async () => {
            mockedClerk.verifyToken.mockResolvedValueOnce({
                sub: adminId,
                sid: 'sess_2',
                org_id: orgId,
                org_role: 'org:admin'
            });

            const res = await request(app)
                .get(`/api/loads/${loadId}`)
                .set('Authorization', `Bearer admin-token`)
                .expect(200);

            expect(res.body.data.proofOfDelivery.imageUrl).toContain('mocked_token');
        });
    });

    describe('SupraSpace Message Security', () => {
        it('should sign attachment URLs in chat messages', async () => {
            const res = await request(app)
                .get(`/api/supraspace/conversations/${conversationId}/messages`)
                .set('Authorization', `Bearer admin-token`)
                .expect(200);

            const messages = res.body.data;
            expect(messages.length).toBeGreaterThan(0);
            const attachment = messages[0].attachments[0];
            expect(attachment.url).toContain('mocked_token');
        });
    });
});
