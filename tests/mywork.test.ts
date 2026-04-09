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
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        await User.deleteMany({ email: { $in: ['tech.work@example.com', 'other.work@example.com'] } });

        user = await User.create({
            email: 'tech.work@example.com',
            password: 'password123',
            name: 'Technician',
            role: 'user',
            emailVerified: true,
            onboardingCompleted: true
        });
        otherUser = await User.create({
            email: 'other.work@example.com',
            password: 'password123',
            name: 'Other Tech',
            role: 'user',
            emailVerified: true,
            onboardingCompleted: true
        });
        
        accessToken = tokenService.generateAccessToken(user);
    }, 30000);

    afterAll(async () => {
        // Targeted Cleanup
        await User.deleteMany({ email: { $in: ['tech.work@example.com', 'other.work@example.com'] } });
        await Vehicle.deleteMany({ assignedTo: { $in: [user?._id, otherUser?._id] } });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
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
