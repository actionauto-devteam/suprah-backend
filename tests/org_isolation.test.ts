import request from 'supertest';
import app from '../src/server';
import Quote from '../src/models/Quote.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Organization Data Isolation', () => {
    let orgA: any;
    let orgB: any;
    let userA: any;
    let userB: any;
    let tokenA: string;
    let tokenB: string;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        const testEmails = ['userA@example.com', 'userB@example.com'];
        await User.deleteMany({ email: { $in: testEmails } });
        await Organization.deleteMany({ slug: { $in: ['isol-org-a', 'isol-org-b'] } });

        // Create Orgs
        orgA = await Organization.create({ name: 'Isol Org A', slug: 'isol-org-a', status: 'active' });
        orgB = await Organization.create({ name: 'Isol Org B', slug: 'isol-org-b', status: 'active' });

        // Create Users
        userA = await User.create({
            email: 'userA@example.com',
            name: 'User A',
            role: 'admin',
            organizationId: orgA._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        userB = await User.create({
            email: 'userB@example.com',
            name: 'User B',
            role: 'admin',
            organizationId: orgB._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        tokenA = tokenService.generateAccessToken(userA);
        tokenB = tokenService.generateAccessToken(userB);
    }, 30000);

    afterAll(async () => {
        await User.deleteMany({ email: { $in: ['userA@example.com', 'userB@example.com'] } });
        await Organization.deleteMany({ _id: { $in: [orgA?._id, orgB?._id] } });
        await Quote.deleteMany({ organizationId: { $in: [orgA?._id.toString(), orgB?._id.toString()] } });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    it('should only return quotes belonging to the user\'s organization', async () => {
        // 1. Create a quote for Org A
        await Quote.create({
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
            phone: '1234567890',
            organizationId: orgA._id.toString(),
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
            organizationId: orgB._id.toString(),
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
        const resA = await request(app)
            .get('/api/quotes')
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);

        expect(resA.body.data.length).toBe(1);
        expect(resA.body.data[0].organizationId).toBe(orgA._id.toString());
        expect(resA.body.data[0].firstName).toBe('John');

        // 4. Request as Org B user
        const resB = await request(app)
            .get('/api/quotes')
            .set('Authorization', `Bearer ${tokenB}`)
            .expect(200);

        expect(resB.body.data.length).toBe(1);
        expect(resB.body.data[0].organizationId).toBe(orgB._id.toString());
        expect(resB.body.data[0].firstName).toBe('Jane');
    });

    it('should prevent access to a quote from a different organization', async () => {
        // 1. Create a quote for Org A
        const quoteA = await Quote.create({
            firstName: 'Private',
            lastName: 'Quote',
            email: 'private@example.com',
            phone: '0000000000',
            organizationId: orgA._id.toString(),
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
        const res = await request(app)
            .get(`/api/quotes/${quoteA._id}`)
            .set('Authorization', `Bearer ${tokenB}`)
            .expect(404);

        expect(res.body.message).toContain('not found');
    });

    it('should assign correct organizationId when creating a new quote', async () => {
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
            eta: { min: 5, max: 10 },
            units: 1
        };

        const res = await request(app)
            .post('/api/quotes')
            .set('Authorization', `Bearer ${tokenA}`)
            .send(newQuote)
            .expect(201);

        expect(res.body.data.organizationId).toBe(orgA._id.toString());

        const savedQuote = await Quote.findById(res.body.data._id);
        expect(savedQuote?.organizationId).toBe(orgA._id.toString());
    });
});
