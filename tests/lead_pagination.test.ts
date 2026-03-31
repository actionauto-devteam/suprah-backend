import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';

describe('Lead Pagination & Search', () => {
    let testUser: any;
    let testOrg: any;
    let token: string;

    beforeAll(async () => {
        jest.setTimeout(30000); // Increase timeout for heavy seeding
        // 1. Setup Test Org
        testOrg = await Organization.create({
            name: 'Pagination Test Org',
            slug: 'pagi-test-' + Date.now(),
            status: 'active'
        });

        // 2. Setup Test User
        testUser = await User.create({
            email: `pagi-user-${Date.now()}@example.com`,
            password: 'Password123!',
            name: 'Pagi Tester',
            role: 'admin',
            organizationId: testOrg._id,
            organizationRole: 'admin',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true
        });

        // 3. Generate Token
        token = tokenService.generateAccessToken(testUser);

        // 4. Seed 60 leads
        const leads = Array.from({ length: 60 }).map((_, i) => ({
            firstName: `Lead ${i + 1}`,
            lastName: 'Test',
            email: `lead${i + 1}@example.com`,
            organizationId: testOrg._id,
            createdBy: testUser._id,
            source: i < 30 ? 'Email' : 'ADF',
            channel: 'email',
            vehicle: { make: 'Toyota', model: 'Camry', year: '2020' },
            comments: 'Test comment'
        }));
        await Lead.insertMany(leads);
    });

    afterAll(async () => {
        // Cleanup only test data
        if (testOrg) {
            await Lead.deleteMany({ organizationId: testOrg._id });
        }
        if (testUser) {
            await User.deleteOne({ _id: testUser._id });
        }
        if (testOrg) {
            await Organization.deleteOne({ _id: testOrg._id });
        }
    });

    it('should return first page with default limit (50)', async () => {
        const res = await request(app)
            .get('/api/leads')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.leads.length).toBe(50);
        expect(res.body.data.total).toBe(60);
        expect(res.body.data.page).toBe(1);
        expect(res.body.data.pages).toBe(2);
    });

    it('should return second page with 10 leads', async () => {
        const res = await request(app)
            .get('/api/leads?page=2')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.leads.length).toBe(10);
        expect(res.body.data.page).toBe(2);
    });

    it('should filter by search query (e.g. "Lead 1")', async () => {
        // "Lead 1" matches Lead 1, Lead 10, Lead 11... Lead 19
        const res = await request(app)
            .get('/api/leads?search=Lead 1')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        // Should return multiple leads (at least 1, 10-19)
        expect(res.body.data.leads.length).toBeGreaterThan(1);
        res.body.data.leads.forEach((l: any) => {
            expect(l.firstName.toLowerCase()).toContain('lead 1');
        });
    });

    it('should return empty results for a search that matches nothing', async () => {
        const res = await request(app)
            .get('/api/leads?search=ZXYWV999')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.leads.length).toBe(0);
        expect(res.body.data.total).toBe(0);
    });
});
