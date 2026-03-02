import request from 'supertest';
import app from '../src/server';
import mongoose from 'mongoose';
import { OwnedVehicle } from '../src/models/OwnedVehicle.model';
import { ServiceRecord } from '../src/models/ServiceRecord.model';

jest.mock('../src/middleware/auth.middleware', () => {
    return () => (req: any, res: any, next: any) => {
        req.user = { _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439011') };
        next();
    };
});

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

describe('ServiceRecord API Logic', () => {
    const mockUserId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
    const mockVehicleId = new mongoose.Types.ObjectId('707f1f77bcf86cd799439033');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('POST /api/service/log - SECURITY: Should fail with 403 Forbidden if User A attempts to log service on User B\'s car', async () => {
        // Explicitly mock that no vehicle belongs to THIS user with that ID
        (OwnedVehicle.findOne as jest.Mock).mockResolvedValue(null);

        const res = await request(app)
            .post('/api/service/log')
            .send({
                vehicleId: mockVehicleId,
                serviceType: 'OIL_CHANGE',
                mileageAtService: 2000,
                locationName: 'Jiffy Lube'
            });

        expect(res.status).toBe(403);
        expect(res.body.message).toBe('You do not have permission to log service for this vehicle');
    });

    it('POST /api/service/log - Should automatically bump the car\'s currentMileage if the service mileage is higher', async () => {
        const mockSave = jest.fn();
        const fakeVehicleDoc = {
            _id: mockVehicleId,
            currentMileage: 5000,
            save: mockSave
        };
        (OwnedVehicle.findOne as jest.Mock).mockResolvedValue(fakeVehicleDoc);
        (ServiceRecord.create as jest.Mock).mockResolvedValue({ _id: 'fakeServiceId' });

        const res = await request(app)
            .post('/api/service/log')
            .send({
                vehicleId: mockVehicleId,
                serviceType: 'OIL_CHANGE',
                mileageAtService: 8000, // 8000 > 5000
                locationName: 'Jiffy Lube'
            });

        expect(res.status).toBe(201);
        // Ensure master mileage was updated to the new service mileage
        expect(fakeVehicleDoc.currentMileage).toBe(8000);
        expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('GET /api/service/history/:vehicleId - Should return an array of service records', async () => {
        (OwnedVehicle.findOne as jest.Mock).mockResolvedValue({ _id: mockVehicleId });

        const findMock = {
            sort: jest.fn().mockResolvedValue([
                { serviceType: 'OIL_CHANGE' },
                { serviceType: 'TIRES' }
            ])
        };
        (ServiceRecord.find as jest.Mock).mockReturnValue(findMock);

        const res = await request(app).get(`/api/service/history/${mockVehicleId}`);

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(2);
        expect(ServiceRecord.find).toHaveBeenCalledWith({ vehicleId: mockVehicleId.toString() });
    });
});
