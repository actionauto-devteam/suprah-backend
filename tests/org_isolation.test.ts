import request from 'supertest';
import app from '../src/server';
import Quote from '../src/models/Quote.model';
import User from '../src/models/User.model';
import { clerkClient } from '@clerk/clerk-sdk-node';
import mongoose from 'mongoose';

const mockedClerk = clerkClient as jest.Mocked<any>;

describe('Organization Data Isolation', () => {
    const orgA = 'org_A_id';
    const orgB = 'org_B_id';
    const userA_id = 'user_A_id';
    const userB_id = 'user_B_id';

    beforeAll(async () => {
        // Ensure users exist in DB for JIT bypass or to match mocked IDs
        await User.create({
            clerkId: userA_id,
            email: 'userA@example.com',
            name: 'User A',
            role: 'user'
        });
        await User.create({
            clerkId: userB_id,
            email: 'userB@example.com',
            name: 'User B',
            role: 'user'
        });
    });

    beforeEach(async () => {
        const dbName = mongoose.connection.name;
        if (dbName && dbName.includes('test')) {
            await Quote.deleteMany({});
        }
    });

    afterAll(async () => {
        const dbName = mongoose.connection.name;
        if (dbName && dbName.includes('test')) {
            await User.deleteMany({ clerkId: { $in: [userA_id, userB_id] } });
            await Quote.deleteMany({});
        }
    });

    it('should only return quotes belonging to the user\'s organization', async () => {
        // 1. Create a quote for Org A
        await Quote.create({
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
            phone: '1234567890',
            organizationId: orgA,
            fromZip: '12345',
            toZip: '54321',
            fromAddress: 'Start A',
            toAddress: 'End A',
            miles: 100,
            rate: 500,
            eta: { min: 2, max: 5 },
            status: 'pending'
        });

        // 2. Create a quote for Org B
        await Quote.create({
            firstName: 'Jane',
            lastName: 'Smith',
            email: 'jane@example.com',
            phone: '0987654321',
            organizationId: orgB,
            fromZip: '11111',
            toZip: '22222',
            fromAddress: 'Start B',
            toAddress: 'End B',
            miles: 200,
            rate: 1000,
            eta: { min: 3, max: 7 },
            status: 'pending'
        });

        // 3. Request as Org A user
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const resA = await request(app)
            .get('/api/quotes')
            .set('Authorization', 'Bearer token_A')
            .expect(200);

        expect(resA.body.data.length).toBe(1);
        expect(resA.body.data[0].organizationId).toBe(orgA);
        expect(resA.body.data[0].firstName).toBe('John');

        // 4. Request as Org B user
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userB_id,
            sid: 'sess_B',
            org_id: orgB,
            org_role: 'org:member'
        });

        const resB = await request(app)
            .get('/api/quotes')
            .set('Authorization', 'Bearer token_B')
            .expect(200);

        expect(resB.body.data.length).toBe(1);
        expect(resB.body.data[0].organizationId).toBe(orgB);
        expect(resB.body.data[0].firstName).toBe('Jane');
    });

    it('should prevent access to a quote from a different organization', async () => {
        // 1. Create a quote for Org A
        const quoteA = await Quote.create({
            firstName: 'Private',
            lastName: 'Quote',
            email: 'private@example.com',
            phone: '0000000000',
            organizationId: orgA,
            fromZip: '12345',
            toZip: '54321',
            fromAddress: 'Secret',
            toAddress: 'Location',
            miles: 50,
            rate: 200,
            eta: { min: 1, max: 2 },
            status: 'pending'
        });

        // 2. Attempt to fetch it as Org B user
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userB_id,
            sid: 'sess_B',
            org_id: orgB,
            org_role: 'org:member'
        });

        const res = await request(app)
            .get(`/api/quotes/${quoteA._id}`)
            .set('Authorization', 'Bearer token_B')
            .expect(404); // Should return 404 because controller uses findOne({ _id, organizationId })

        expect(res.body.message).toContain('not found');
    });

    it('should assign correct organizationId when creating a new quote', async () => {
        mockedClerk.verifyToken.mockResolvedValueOnce({
            sub: userA_id,
            sid: 'sess_A',
            org_id: orgA,
            org_role: 'org:member'
        });

        const newQuote = {
            firstName: 'New',
            lastName: 'Customer',
            email: 'new@example.com',
            phone: '5555555555',
            fromZip: '90210',
            toZip: '10001',
            fromAddress: 'Beverly Hills',
            toAddress: 'NYC',
            miles: 3000,
            rate: 1500,
            eta: { min: 5, max: 10 }
        };

        const res = await request(app)
            .post('/api/quotes')
            .set('Authorization', 'Bearer token_A')
            .send(newQuote)
            .expect(201);

        expect(res.body.data.organizationId).toBe(orgA);

        const savedQuote = await Quote.findById(res.body.data._id);
        expect(savedQuote?.organizationId).toBe(orgA);
    });
});
