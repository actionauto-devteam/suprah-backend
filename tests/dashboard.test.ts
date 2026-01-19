import request from 'supertest';
import app from '../src/server';
import Vehicle from '../src/models/Vehicle.model';
import User from '../src/models/User.model';
import mongoose from 'mongoose';
import tokenService from '../src/services/token.service';

describe('Dashboard Routes', () => {
    let user: any;
    let accessToken: string;

    beforeAll(async () => {
        // Generate a user and token
        user = await User.create({
            email: 'admin@example.com',
            password: 'password123',
            role: 'admin',
            name: 'Admin User'
        });

        // We need to bypass the actual login and just get a token, 
        // but auth middleware verifies it against the DB.
        // tokenService.generateAuthTokens returns { access: { token: ... }, ... }
        const tokens = await tokenService.generateAuthTokens(user);
        accessToken = tokens.access.token;
    });

    afterAll(async () => {
        await User.deleteMany({});
        await Vehicle.deleteMany({});
    });

    test('GET /api/dashboard/metrics should return metrics', async () => {
        // Seed some vehicles
        await Vehicle.create({
            vin: 'VIN123', year: 2021, make: 'Toyota', modelName: 'Camry',
            status: 'In Recon', currentStep: 'Inspection'
        });
        await Vehicle.create({
            vin: 'VIN456', year: 2022, make: 'Honda', modelName: 'Civic',
            status: 'Ready for Sale', currentStep: 'Ready'
        });

        const res = await request(app)
            .get('/api/dashboard/metrics')
            .set('Authorization', `Bearer ${accessToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.inventoryOverview).toBeDefined();
        expect(res.body.data.inventoryOverview.totalActive).toBe(2);
        expect(res.body.data.inventoryOverview.inRecon).toBe(1);
        expect(res.body.data.reconStatus.Inspection).toBe(1);
    });
});
