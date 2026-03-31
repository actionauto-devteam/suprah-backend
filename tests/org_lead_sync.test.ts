import OrgGmailService from '../src/services/orgGmail.service';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Organization from '../src/models/Organization.model';
import Lead from '../src/models/lead.model';
import User from '../src/models/User.model';
import { google } from 'googleapis';
import { encrypt } from '../src/utils/crypto';

// Setup Mock for Gmail API
jest.mock('googleapis', () => ({
    google: {
        gmail: jest.fn().mockReturnValue({
            users: {
                messages: {
                    list: jest.fn().mockResolvedValue({ data: { messages: [{ id: 'msg123' }] } }),
                    get: jest.fn().mockResolvedValue({
                        data: {
                            id: 'msg123',
                            threadId: 'thread123',
                            payload: {
                                parts: [{
                                    mimeType: 'text/plain',
                                    body: { data: Buffer.from('ADF content here').toString('base64') }
                                }]
                            }
                        }
                    }),
                    batchModify: jest.fn().mockResolvedValue({})
                }
            }
        }),
        auth: {
            OAuth2: jest.fn().mockImplementation(() => ({
                generateAuthUrl: jest.fn().mockReturnValue('https://auth.url'),
                getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'at', refresh_token: 'rt' } }),
                setCredentials: jest.fn(),
                once: jest.fn()
            }))
        }
    }
}));

// Mock adfParser because we want to test the service-level coordination
jest.mock('../src/utils/adfParser', () => ({
    parseEmailBody: jest.fn().mockResolvedValue({
        parsedContent: 'Mocked Lead - Ford F-150 2022',
        channel: 'adf',
        adfData: {
            firstName: 'Mocked',
            lastName: 'Lead',
            email: 'mock@example.com',
            phone: '1234567890',
            vehicle: { make: 'Ford', model: 'F-150', year: '2022' },
            comments: '',
            source: '',
        }
    }),
    parseADF: jest.fn(),
    detectChannel: jest.fn().mockReturnValue('adf'),
    extractADFFromBody: jest.fn(),
}));

describe('Multi-Tenant Gmail Sync Service', () => {
    let testOrg: any;
    let testUser: any;

    beforeAll(async () => {
        jest.setTimeout(30000);
        // 1. Setup Test Org
        testOrg = await Organization.create({
            name: 'Sync Test Org',
            slug: 'sync-test-' + Date.now(),
            status: 'active'
        });

        // 2. Setup System User for createdBy
        testUser = await User.create({
            email: `sync-admin-${Date.now()}@example.com`,
            role: 'super_admin',
            organizationId: testOrg._id,
            password: 'Password123!',
            name: 'Sync Admin'
        });

        // 3. Setup Org-Specific Gmail Config
        await OrgLeadConfig.create({
            organizationId: testOrg._id,
            connectedBy: testUser._id,
            gmailConnected: true,
            isActive: true,
            accessToken: encrypt('at'),
            refreshToken: encrypt('rt'),
            expiryDate: Date.now() + 3600000,
            gmailAddress: 'test@gmail.com',
            leadSourceEmail: 'leads@provider.com',
            connectedAt: new Date(),
        });
    });

    afterAll(async () => {
        // Cleanup
        if (testOrg) {
            await OrgLeadConfig.deleteMany({ organizationId: testOrg._id });
        }
        if (testOrg) {
            await Organization.deleteOne({ _id: testOrg._id });
        }
        if (testUser) {
            await User.deleteOne({ _id: testUser._id });
        }
        if (testOrg) {
            await Lead.deleteMany({ organizationId: testOrg._id });
        }
    });

    it('should sync a lead from mocked Gmail API and scope it to the organization', async () => {
        const result = await OrgGmailService.syncLeadsForOrg(testOrg._id.toString());

        expect(result.synced).toBe(1);

        const lead = await Lead.findOne({ organizationId: testOrg._id });
        expect(lead).toBeDefined();
        expect(lead?.firstName).toBe('Mocked');
        expect(lead?.messageId).toBe('msg123');
        expect(lead?.source).toBe('Gmail Sync');
    });

    it('should skip sync if org Gmail is not connected', async () => {
        // Temporarily disconnect
        await OrgLeadConfig.updateOne({ organizationId: testOrg._id }, { $set: { gmailConnected: false } });

        const result = await OrgGmailService.syncLeadsForOrg(testOrg._id.toString());
        expect(result.synced).toBe(0);

        // Re-connect for potentially further tests
        await OrgLeadConfig.updateOne({ organizationId: testOrg._id }, { $set: { gmailConnected: true } });
    });

    it('should not save duplicate leads even if found in Gmail list again', async () => {
        // First sync already happened in first test
        const result = await OrgGmailService.syncLeadsForOrg(testOrg._id.toString());

        // Should be 0 synced because of threadId/messageId duplicate check
        expect(result.synced).toBe(0);
    });
});
