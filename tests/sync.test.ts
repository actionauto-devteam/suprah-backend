import syncService from '../src/services/sync.service';
import ftpService from '../src/services/ftp.service';
import Vehicle from '../src/models/Vehicle.model';
import SyncLog from '../src/models/SyncLog.model';
import AuditLog from '../src/models/AuditLog.model';
import mongoose from 'mongoose';
import { Readable } from 'stream';

// Mock ftpService
jest.mock('../src/services/ftp.service');
const mockedFtpService = ftpService as jest.Mocked<any>;

describe('SyncService (Streaming)', () => {
    beforeEach(async () => {
        // Ensure we are connected to the test database
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/action-auto-test');
        }
        // Clean up only test vehicles and logs
        const testVins = ['VIN123', 'OLD_VIN'];
        await Vehicle.deleteMany({ vin: { $in: testVins } });
        await SyncLog.deleteMany({}); // SyncLogs are less risky but we should still be careful
        await AuditLog.deleteMany({ entityId: { $in: (await Vehicle.find({ vin: { $in: testVins } })).map(v => v._id) } });
    });

    /**
     * Helper to create a TAB-separated stream for testing DealersCloud format
     */
    const createMockStream = (data: any[]) => {
        const header = Object.keys(data[0]).join('\t');
        const rows = data.map(obj => Object.values(obj).join('\t')).join('\n');
        const content = `${header}\n${rows}`;
        return Readable.from([content]);
    };

    const mockCsvData = [
        {
            year: '2023',
            make: 'Toyota',
            model: 'Camry',
            trim: 'LE',
            vin: 'VIN123',
            'stock number': 'STK001'
        }
    ];

    test('should add new vehicle from streaming feed', async () => {
        mockedFtpService.getInventoryStream.mockResolvedValue(createMockStream(mockCsvData));

        const result = await syncService.syncInventory();

        expect(result.added).toBe(1);
        expect(result.processed).toBe(1);

        const vehicle = await Vehicle.findOne({ vin: 'VIN123' });
        expect(vehicle).toBeDefined();
        expect(vehicle?.make).toBe('Toyota');

        const audit = await AuditLog.findOne({ entityId: vehicle?._id, action: 'CREATE' });
        expect(audit).toBeDefined();
    });

    test('should update existing vehicle if data changed', async () => {
        // 1. Seed existing
        await Vehicle.create({
            vin: 'VIN123',
            year: 2023,
            make: 'Toyota',
            modelName: 'Camry',
            exteriorColor: 'Blue', // Key is 'exterior color' in model mapping
            organizationId: '698f474596361c239f73c608',
            isDeleted: false
        });

        const updatedData = [{
            ...mockCsvData[0],
            'exterior color': 'Silver'
        }];

        mockedFtpService.getInventoryStream.mockResolvedValue(createMockStream(updatedData));

        const result = await syncService.syncInventory();

        expect(result.updated).toBe(1);

        const updated = await Vehicle.findOne({ vin: 'VIN123' });
        expect(updated?.exteriorColor).toBe('Silver');

        const audit = await AuditLog.findOne({ action: 'UPDATE' });
        expect(audit?.changes).toBeDefined();
    });

    test('should soft-delete (mark as Sold) vehicle missing from feed', async () => {
        // 1. Seed existing
        await Vehicle.create({
            vin: 'OLD_VIN',
            year: 2020,
            make: 'Ford',
            modelName: 'F-150',
            status: 'Ready for Sale',
            organizationId: '698f474596361c239f73c608',
            isDeleted: false
        });

        mockedFtpService.getInventoryStream.mockResolvedValue(createMockStream(mockCsvData)); // Only VIN123 is here

        const result = await syncService.syncInventory();

        expect(result.deleted).toBe(1);

        const deleted = await Vehicle.findOne({ vin: 'OLD_VIN' });
        expect(deleted?.status).toBe('Sold');

        const audit = await AuditLog.findOne({ action: 'UPDATE', reason: /no longer present/ });
        expect(audit).toBeDefined();
    });
});
