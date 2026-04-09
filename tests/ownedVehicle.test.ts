import request from 'supertest';
import app from '../src/server';
import mongoose from 'mongoose';
import { OwnedVehicle } from '../src/models/OwnedVehicle.model';
import User from '../src/models/User.model';
import tokenService from '../src/services/token.service';

describe('OwnedVehicle API Logic', () => {
    let testUser: any;
    let authToken: string;
    const testEmail = 'vehicle.owner@test.com';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        await User.deleteMany({ email: testEmail });
        await OwnedVehicle.deleteMany({ vin: 'TESTVIN123' });

        // Create User
        testUser = await User.create({
            email: testEmail,
            name: 'Vehicle Owner',
            role: 'customer',
            emailVerified: true,
            onboardingCompleted: true
        });

        authToken = tokenService.generateAccessToken(testUser);
    }, 30000);

    afterAll(async () => {
        await User.deleteMany({ email: testEmail });
        await OwnedVehicle.deleteMany({ userId: testUser?._id });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    beforeEach(async () => {
        await OwnedVehicle.deleteMany({ userId: testUser?._id });
    });

    it('POST /api/customer/vehicles - Should successfully create a new car', async () => {
        const res = await request(app)
            .post('/api/customer/vehicles')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                vin: 'TESTVIN123',
                make: 'Honda',
                model: 'Civic',
                year: '2024'
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.vin).toBe('TESTVIN123');

        const saved = await OwnedVehicle.findOne({ vin: 'TESTVIN123', userId: testUser._id });
        expect(saved).not.toBeNull();
    });

    it('POST /api/customer/vehicles - Should reject duplicate VINs for the same user', async () => {
        await OwnedVehicle.create({
            userId: testUser._id,
            vin: 'TESTVIN123',
            make: 'Honda',
            model: 'Civic',
            year: '2024'
        });

        const res = await request(app)
            .post('/api/customer/vehicles')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                vin: 'TESTVIN123',
                make: 'Honda',
                model: 'Civic',
                year: '2024'
            });

        expect(res.status).toBe(400);
        expect(res.body.message).toBe('You have already registered this vehicle');
    });

    it('GET /api/customer/vehicles - Should return user cars only', async () => {
        await OwnedVehicle.create({
            userId: testUser._id,
            vin: 'TESTVIN123',
            make: 'Honda',
            model: 'Civic',
            year: '2024'
        });

        const res = await request(app)
            .get('/api/customer/vehicles')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.length).toBe(1);
    });

    it('PATCH /api/customer/vehicles/:id/mileage - Should correctly update the vehicle mileage', async () => {
        const vehicle = await OwnedVehicle.create({
            userId: testUser._id,
            vin: 'TESTVIN123',
            make: 'Honda',
            model: 'Civic',
            year: '2024',
            currentMileage: 1000
        });

        const res = await request(app)
            .patch(`/api/customer/vehicles/${vehicle._id}/mileage`)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ currentMileage: 1500 });

        expect(res.status).toBe(200);
        
        const updated = await OwnedVehicle.findById(vehicle._id);
        expect(updated?.currentMileage).toBe(1500);
    });

    it('PATCH /api/customer/vehicles/:id/mileage - Should prevent mileage from decreasing', async () => {
        const vehicle = await OwnedVehicle.create({
            userId: testUser._id,
            vin: 'TESTVIN123',
            make: 'Honda',
            model: 'Civic',
            year: '2024',
            currentMileage: 5000
        });

        const res = await request(app)
            .patch(`/api/customer/vehicles/${vehicle._id}/mileage`)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ currentMileage: 4000 });

        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Mileage cannot be decreased');
    });
});
