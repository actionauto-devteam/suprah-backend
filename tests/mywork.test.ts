import request from 'supertest';
import app from '../src/server';
import Vehicle from '../src/models/Vehicle.model';
import User from '../src/models/User.model';
import tokenService from '../src/services/token.service';
import mongoose from 'mongoose';

describe('My Work Routes - Targeted Isolation', () => {
    let user: any;
    let otherUser: any;
    let accessToken: string;
    let vehicleId: string;

    beforeAll(async () => {
        user = await User.create({
            email: 'tech.work@example.com',
            password: 'password123',
            name: 'Technician',
            role: 'user'
        });
        otherUser = await User.create({
            email: 'other.work@example.com',
            password: 'password123',
            name: 'Other Tech',
            role: 'user'
        });
        const tokens = await tokenService.generateAuthTokens(user);
        accessToken = tokens.access.token;
    });

    afterAll(async () => {
        // Targeted Cleanup
        await User.deleteMany({ email: { $in: ['tech.work@example.com', 'other.work@example.com'] } });
        await Vehicle.deleteMany({ assignedTo: { $in: [user._id, otherUser._id] } });
    });

    beforeEach(async () => {
        // Seed a vehicle assigned to user
        const vehicle = await Vehicle.create({
            vin: 'VIN_MYWORK_123', 
            year: 2023, 
            make: 'Ford', 
            modelName: 'F150',
            status: 'In Recon', 
            currentStep: 'Inspection',
            assignedTo: user._id
        });
        vehicleId = vehicle._id.toString();

        // Vehicle assigned to someone else
        await Vehicle.create({
            vin: 'VIN_OTHER_456', 
            year: 2023, 
            make: 'Chevy', 
            modelName: 'Silverado',
            status: 'In Recon', 
            currentStep: 'Inspection',
            assignedTo: otherUser._id
        });
    });

    afterEach(async () => {
        await Vehicle.deleteMany({ vin: { $in: ['VIN_MYWORK_123', 'VIN_OTHER_456'] } });
    });

    test('GET /api/my-work should return only assigned vehicles', async () => {
        const res = await request(app)
            .get('/api/my-work')
            .set('Authorization', `Bearer ${accessToken}`);
        
        expect(res.status).toBe(200);
        // We use find to keep it data-safe in case of other tests
        const myVehicle = res.body.data.find((v: any) => v.vin === 'VIN_MYWORK_123');
        expect(myVehicle).toBeDefined();
        
        const otherVehicle = res.body.data.find((v: any) => v.vin === 'VIN_OTHER_456');
        expect(otherVehicle).toBeUndefined();
    });

    test('PATCH /api/my-work/:id/step should update step', async () => {
        const res = await request(app)
            .patch(`/api/my-work/${vehicleId}/step`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({
                nextStep: 'Mechanical'
            });
        
        expect(res.status).toBe(200);
        expect(res.body.data.currentStep).toBe('Mechanical');
    });
});
