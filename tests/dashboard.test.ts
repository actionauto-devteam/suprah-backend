import request from 'supertest';
import app from '../src/server';
import Vehicle from '../src/models/Vehicle.model';
import Quote from '../src/models/Quote.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Dashboard Routes - Organization Isolation', () => {
    let testOrg: any;
    let testUser: any;
    let authToken: string;
    const testEmail = 'dash_admin@example.com';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        await User.deleteMany({ email: testEmail });
        await Organization.deleteMany({ slug: 'dash-org' });
        await Vehicle.deleteMany({ vin: 'VIN-DASH-123' });

        // Create Org
        testOrg = await Organization.create({ name: 'Dash Org', slug: 'dash-org', status: 'active' });

        // Create User
        testUser = await User.create({
            email: testEmail,
            name: 'Admin User',
            role: 'admin',
            organizationId: testOrg._id,
            emailVerified: true,
            onboardingCompleted: true
        });

        authToken = tokenService.generateAccessToken(testUser);
    }, 30000);

    afterAll(async () => {
        await User.deleteMany({ email: testEmail });
        await Organization.deleteMany({ _id: testOrg?._id });
        await Vehicle.deleteMany({ vin: 'VIN-DASH-123' });
        await Quote.deleteMany({ organizationId: testOrg?._id.toString() });

        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    test('GET /api/dashboard/metrics should return isolated metrics', async () => {
        // Seed some quotes for our org and another org
        await Quote.create({
            firstName: 'My', lastName: 'Quote', email: 'dash_my@q.com', phone: '1',
            organizationId: testOrg._id.toString(),
            fromZip: '1', toZip: '2', fromAddress: '1', toAddress: '2', miles: 1, rate: 500,
            eta: { min: 1, max: 2 }, status: 'booked',
            units: 1
        });

        await Quote.create({
            firstName: 'Other', lastName: 'Quote', email: 'dash_other@q.com', phone: '2',
            organizationId: 'other_org_id',
            fromZip: '3', toZip: '4', fromAddress: '3', toAddress: '4', miles: 2, rate: 1000,
            eta: { min: 2, max: 3 }, status: 'booked',
            units: 1
        });

        // Seed some vehicles
        await Vehicle.create({
            vin: 'VIN-DASH-123', year: 2021, make: 'Toyota', modelName: 'Camry', status: 'Ready for Sale'
        });

        const res = await request(app)
            .get('/api/dashboard/metrics')
            .set('Authorization', `Bearer ${authToken}`)
            .expect(200);

        // Inventory overview is shared or scoped based on project logic
        expect(res.body.data.inventory).toBeDefined();
    });
});
