import request from 'supertest';
import app from '../src/server';
import mongoose from 'mongoose';
import { OwnedVehicle } from '../src/models/OwnedVehicle.model';
import { ServiceRecord } from '../src/models/ServiceRecord.model';
import User from '../src/models/User.model';
import tokenService from '../src/services/token.service';

describe('ServiceRecord API Logic', () => {
    let testUserA: any;
    let testUserB: any;
    let authA: string;
    let authB: string;
    const emailA = 'userA.service@test.com';
    const emailB = 'userB.service@test.com';

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/actionauto_test');
        }

        // Clean up previous test data
        await User.deleteMany({ email: { $in: [emailA, emailB] } });

        // Create Users
        testUserA = await User.create({
            email: emailA,
            name: 'User A',
            role: 'customer',
            emailVerified: true,
            onboardingCompleted: true
        });
        authA = tokenService.generateAccessToken(testUserA);

        testUserB = await User.create({
            email: emailB,
            name: 'User B',
            role: 'customer',
            emailVerified: true,
            onboardingCompleted: true
        });
        authB = tokenService.generateAccessToken(testUserB);
    }, 30000);

    afterAll(async () => {
        const users = await User.find({ email: { $in: [emailA, emailB] } });
        const userIds = users.map(u => u._id);
        
        await OwnedVehicle.deleteMany({ userId: { $in: userIds } });
        await ServiceRecord.deleteMany({ vehicleId: { $in: await getVehicleIds(userIds) } });
        await User.deleteMany({ _id: { $in: userIds } });
        
        if (mongoose.connection.db?.databaseName === 'actionauto_test') {
            await mongoose.disconnect();
        }
    });

    async function getVehicleIds(userIds: any[]) {
        const vehicles = await OwnedVehicle.find({ userId: { $in: userIds } });
        return vehicles.map(v => v._id);
    }

    beforeEach(async () => {
        const vehicles = await OwnedVehicle.find({ userId: { $in: [testUserA._id, testUserB._id] } });
        const vIds = vehicles.map(v => v._id);
        await ServiceRecord.deleteMany({ vehicleId: { $in: vIds } });
        await OwnedVehicle.deleteMany({ userId: { $in: [testUserA._id, testUserB._id] } });
    });

    it('POST /api/service/log - SECURITY: Should fail with 403 Forbidden if User A attempts to log service on User B\'s car', async () => {
        const carB = await OwnedVehicle.create({
            userId: testUserB._id,
            vin: 'VIN-B-123',
            make: 'Honda',
            model: 'Civic',
            year: '2020',
            currentMileage: 1000
        });

        const res = await request(app)
            .post('/api/service/log')
            .set('Authorization', `Bearer ${authA}`)
            .send({
                vehicleId: carB._id.toString(),
                serviceType: 'OIL_CHANGE',
                mileageAtService: 2000,
                locationName: 'Jiffy Lube'
            });

        expect(res.status).toBe(403);
        expect(res.body.message).toBe('You do not have permission to log service for this vehicle');
    });

    it('POST /api/service/log - Should automatically bump the car\'s currentMileage if the service mileage is higher', async () => {
        const carA = await OwnedVehicle.create({
            userId: testUserA._id,
            vin: 'VIN-A-123',
            make: 'Toyota',
            model: 'Corolla',
            year: '2021',
            currentMileage: 5000
        });

        const res = await request(app)
            .post('/api/service/log')
            .set('Authorization', `Bearer ${authA}`)
            .send({
                vehicleId: carA._id.toString(),
                serviceType: 'OIL_CHANGE',
                mileageAtService: 8000,
                locationName: 'Jiffy Lube'
            });

        expect(res.status).toBe(201);
        
        const updated = await OwnedVehicle.findById(carA._id);
        expect(updated?.currentMileage).toBe(8000);
    });

    it('GET /api/service/history/:vehicleId - Should return an array of service records', async () => {
        const carA = await OwnedVehicle.create({
            userId: testUserA._id,
            vin: 'VIN-A-TEST',
            make: 'Toyota',
            model: 'Corolla',
            year: '2021',
            currentMileage: 5000
        });

        await ServiceRecord.create({
            vehicleId: carA._id,
            serviceType: 'OIL_CHANGE',
            mileageAtService: 4000,
            locationName: 'Lube A',
            date: new Date()
        });

        const res = await request(app)
            .get(`/api/service/history/${carA._id}`)
            .set('Authorization', `Bearer ${authA}`);

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
    });
});
