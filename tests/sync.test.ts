import syncService from '../src/services/sync.service';
import ftpService from '../src/services/ftp.service';
import Vehicle from '../src/models/Vehicle.model';
import SyncLog from '../src/models/SyncLog.model';
import AuditLog from '../src/models/AuditLog.model';
import mongoose from 'mongoose';

// Mock ftpService
jest.mock('../src/services/ftp.service');
const mockedFtpService = ftpService as jest.Mocked<any>;

describe('SyncService', () => {
    beforeEach(async () => {
        await Vehicle.deleteMany({});
        await SyncLog.deleteMany({});
        await AuditLog.deleteMany({});
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    const mockCsvData = [
        {
            Year: '2023',
            Make: 'Toyota',
            Model: 'Camry',
            Trim: 'LE',
            Color: 'Silver',
            VIN: 'VIN123',
            StockNumber: 'STK001'
        }
    ];

    test('should add new vehicle from feed', async () => {
        mockedFtpService.getInventoryStream.mockResolvedValue({});
        mockedFtpService.parseInventoryFile.mockResolvedValue(mockCsvData);

        const result = await syncService.syncInventory();

        expect(result.added).toBe(1);

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
            color: 'Blue', // Changed in feed below
            isDeleted: false
        });

        mockedFtpService.getInventoryStream.mockResolvedValue({});
        mockedFtpService.parseInventoryFile.mockResolvedValue(mockCsvData); // Color is 'Silver'

        const result = await syncService.syncInventory();

        expect(result.updated).toBe(1);

        const updated = await Vehicle.findOne({ vin: 'VIN123' });
        expect(updated?.color).toBe('Silver');

        const audit = await AuditLog.findOne({ action: 'UPDATE' });
        expect(audit?.changes).toBeDefined();
    });

    test('should soft-delete vehicle missing from feed', async () => {
        // 1. Seed existing
        await Vehicle.create({
            vin: 'OLD_VIN',
            year: 2020,
            make: 'Ford',
            modelName: 'F-150',
            isDeleted: false
        });

        mockedFtpService.getInventoryStream.mockResolvedValue({});
        mockedFtpService.parseInventoryFile.mockResolvedValue(mockCsvData); // Only VIN123 is here

        const result = await syncService.syncInventory();

        expect(result.deleted).toBe(1);

        const deleted = await Vehicle.findOne({ vin: 'OLD_VIN' });
        expect(deleted?.isDeleted).toBe(true);

        const audit = await AuditLog.findOne({ action: 'DELETE' });
        expect(audit).toBeDefined();
    });
});
