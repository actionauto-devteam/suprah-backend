import request from 'supertest';
import crypto from 'crypto';
import app from '../src/server';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Organization from '../src/models/Organization.model';
import { encrypt, decrypt } from '../src/utils/crypto';
import User from '../src/models/User.model';

describe('ADF Webhook Security (HMAC)', () => {
    let testOrg: any;
    let testUser: any;
    const webhookSecret = 'test-webhook-secret-123';
    let orgId: string;

    beforeAll(async () => {
        jest.setTimeout(60000);
        // 1. Setup Test Org
        testOrg = await Organization.create({
            name: 'Security Test Org',
            slug: 'sec-test-' + Date.now(),
            status: 'active'
        });
        orgId = testOrg._id.toString();

        // 2. Setup Test User
        testUser = await User.create({
            email: `sec-user-${Date.now()}@example.com`,
            password: 'Password123!',
            name: 'Security Tester',
            role: 'admin',
            organizationId: testOrg._id
        });

        // 3. Setup OrgLeadConfig with encrypted secret
        await OrgLeadConfig.create({
            organizationId: testOrg._id,
            connectedBy: testUser._id,
            gmailAddress: 'test-sec@gmail.com',
            accessToken: encrypt('dummy-at'),
            refreshToken: encrypt('dummy-rt'),
            expiryDate: Date.now() + 3600000,
            webhookSecret: encrypt(webhookSecret),
            isActive: true,
            gmailConnected: false
        });
    });

    afterAll(async () => {
        if (testOrg) {
            await OrgLeadConfig.deleteMany({ organizationId: testOrg._id });
        }
        if (testUser) {
            await User.deleteOne({ _id: testUser._id });
        }
        if (testOrg) {
            await Organization.deleteOne({ _id: testOrg._id });
        }
    });

    const getAdfXml = (first: string, last: string, email: string) => `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
    <prospect>
        <customer>
            <contact>
                <name part="first">${first}</name>
                <name part="last">${last}</name>
                <email>${email}</email>
            </contact>
        </customer>
    </prospect>
</adf>`;

    it('should reject request with missing signature (401)', async () => {
        const payload = getAdfXml('Missing', 'Sig', 'test@test.com');
        const res = await request(app)
            .post('/api/leads/adf')
            .query({ orgId })
            .set('Content-Type', 'application/xml')
            .send(payload)
            .expect(401);

        expect(res.body.message).toContain('MISSING_SIGNATURE');
    });

    it('should reject request with missing orgId (400)', async () => {
        const payload = getAdfXml('Missing', 'Org', 'test@test.com');
        const res = await request(app)
            .post('/api/leads/adf')
            .set('Content-Type', 'application/xml')
            .send(payload)
            .expect(400);

        expect(res.body.message).toContain('MISSING_ORG_ID');
    });

    it('should reject request with invalid signature (401)', async () => {
        const payload = getAdfXml('Invalid', 'Sig', 'test@test.com');
        const res = await request(app)
            .post('/api/leads/adf')
            .query({ orgId })
            .set('X-ADF-Signature', 'wrong-signature')
            .set('Content-Type', 'application/xml')
            .send(payload)
            .expect(401);

        expect(res.body.message).toContain('INVALID_SIGNATURE');
    });

    it('should accept request with valid HMAC signature and processing string', async () => {
        const adfXml = getAdfXml('Secure', 'HMAC', 'hmac@test.com');
        const signature = crypto.createHmac('sha256', webhookSecret)
            .update(adfXml)
            .digest('hex');

        const res = await request(app)
            .post('/api/leads/adf')
            .query({ orgId })
            .set('X-ADF-Signature', signature)
            .set('Content-Type', 'application/xml')
            .send(adfXml)
            .expect(200);

        expect(res.text).toContain('Lead processed successfully');
    });

    it('should accept valid complexity XML payload', async () => {
        const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
        <adf>
            <prospect>
                <requestdate>2023-10-25T12:00:00Z</requestdate>
                <customer>
                    <contact>
                        <name part="full">XML Complex Lead</name>
                        <email>complex@example.com</email>
                        <phone>123-456-7890</phone>
                    </contact>
                </customer>
                <vehicle>
                    <year>2024</year>
                    <make>Ford</make>
                    <model>F-150</model>
                </vehicle>
            </prospect>
        </adf>`;

        const signature = crypto.createHmac('sha256', webhookSecret)
            .update(xmlPayload)
            .digest('hex');

        const res = await request(app)
            .post('/api/leads/adf')
            .query({ orgId })
            .set('X-ADF-Signature', signature)
            .set('Content-Type', 'application/xml')
            .send(xmlPayload)
            .expect(200);

        expect(res.text).toContain('Lead processed successfully');
    });
});
