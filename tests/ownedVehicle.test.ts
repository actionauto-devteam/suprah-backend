import request from 'supertest';
import app from '../src/server';
import mongoose from 'mongoose';
import { OwnedVehicle } from '../src/models/OwnedVehicle.model';
import { ServiceRecord } from '../src/models/ServiceRecord.model';

// Mock the Auth Middleware to inject a fake user Identity
jest.mock('../src/middleware/auth.middleware', () => {
    return () => (req: any, res: any, next: any) => {
        req.user = { _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439011') };
        next();
    };
});

// Mock the Models purely for testing controllers without hitting DB
jest.mock('../src/models/OwnedVehicle.model', () => ({
    OwnedVehicle: {
        findOne: jest.fn(),
        create: jest.fn(),
        find: jest.fn(),
    }
}));
jest.mock('../src/models/ServiceRecord.model', () => ({
    ServiceRecord: {
        findOne: jest.fn(),
        create: jest.fn(),
        find: jest.fn(),
    }
}));
jest.mock('../src/models/ServiceLocation.model', () => ({
    __esModule: true,
    default: {
        find: jest.fn().mockResolvedValue([]),
    }
}));

describe('OwnedVehicle API Logic', () => {
    const mockUserId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
    const mockVehicleId = new mongoose.Types.ObjectId('707f1f77bcf86cd799439033');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('POST /api/customer/vehicles - Should successfully create a new car', async () => {
        // Mock findOne returning null (No existing car with same VIN)
        (OwnedVehicle.findOne as jest.Mock).mockResolvedValue(null);
        // Mock actual creation
        (OwnedVehicle.create as jest.Mock).mockResolvedValue({
            _id: mockVehicleId,
            userId: mockUserId,
            vin: 'TESTVIN123',
            make: 'Honda',
            model: 'Civic',
            year: '2024'
        });

        const res = await request(app)
            .post('/api/customer/vehicles')
            .send({
                vin: 'TESTVIN123',
                make: 'Honda',
                model: 'Civic',
                year: '2024'
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.vin).toBe('TESTVIN123');
    });

    it('POST /api/customer/vehicles - Should reject duplicate VINs for the same user', async () => {
        // Mock findOne returning a truthy value (existing duplicate car)
        (OwnedVehicle.findOne as jest.Mock).mockResolvedValue({
            vin: 'TESTVIN123',
            userId: mockUserId
        });

        const res = await request(app)
            .post('/api/customer/vehicles')
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
        // Mock finding user vehicles
        const findMock = {
            sort: jest.fn().mockResolvedValue([
                { _id: mockVehicleId, make: 'Honda' }
            ])
        };
        (OwnedVehicle.find as jest.Mock).mockReturnValue(findMock);

        const res = await request(app).get('/api/customer/vehicles');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.length).toBe(1);
        expect(OwnedVehicle.find).toHaveBeenCalledWith({ userId: mockUserId, status: 'ACTIVE' });
    });

    it('PATCH /api/customer/vehicles/:id/mileage - Should correctly update the vehicle mileage', async () => {
        const mockSave = jest.fn();
        const fakeVehicleDoc = {
            _id: mockVehicleId,
            currentMileage: 1000,
            save: mockSave
        };
        (OwnedVehicle.findOne as jest.Mock).mockResolvedValue(fakeVehicleDoc);

        const res = await request(app)
            .patch(`/api/customer/vehicles/${mockVehicleId}/mileage`)
            .send({ currentMileage: 1500 });

        expect(res.status).toBe(200);
        expect(fakeVehicleDoc.currentMileage).toBe(1500);
        expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('PATCH /api/customer/vehicles/:id/mileage - Should prevent mileage from decreasing', async () => {
        const mockSave = jest.fn();
        const fakeVehicleDoc = {
            _id: mockVehicleId,
            currentMileage: 5000,
            save: mockSave
        };
        (OwnedVehicle.findOne as jest.Mock).mockResolvedValue(fakeVehicleDoc);

        const res = await request(app)
            .patch(`/api/customer/vehicles/${mockVehicleId}/mileage`)
            .send({ currentMileage: 4000 });

        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Mileage cannot be decreased');
        expect(mockSave).not.toHaveBeenCalled();
    });
});
