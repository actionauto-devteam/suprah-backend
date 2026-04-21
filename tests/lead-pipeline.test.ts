import mongoose from 'mongoose';
import connectDB, { disconnectDB } from '../src/config/db';
import { generateInquiryADF } from '../src/utils/adfGenerator';
import { parseADF } from '../src/utils/adfParser';
import LeadService from '../src/services/lead.service';
import FinanceApplication from '../src/models/FinanceApplication.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Vehicle from '../src/models/Vehicle.model';
import NotificationService from '../src/services/notification.service';

// Mock NotificationService to test transaction rollback
jest.mock('../src/services/notification.service');

describe('ActionAuto Lead Pipeline Integration', () => {
    const TEST_ORG_ID = new mongoose.Types.ObjectId('deadbeefdeadbeefdeadbeef');
    const TEST_VEHICLE_ID = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        await connectDB();
        await OrgLeadConfig.deleteMany({ organizationId: TEST_ORG_ID });
        await FinanceApplication.deleteMany({ organizationId: TEST_ORG_ID });
        await Vehicle.deleteMany({ _id: TEST_VEHICLE_ID });
    });

    afterAll(async () => {
        await OrgLeadConfig.deleteMany({ organizationId: TEST_ORG_ID });
        await FinanceApplication.deleteMany({ organizationId: TEST_ORG_ID });
        await Vehicle.deleteMany({ _id: TEST_VEHICLE_ID });
        await disconnectDB();
    });

    describe('ADF Generator/Parser Parity', () => {
        test('should generate and parse ADF XML perfectly', async () => {
            const mockInquiry = {
                firstName: 'John',
                lastName: 'Doe',
                email: 'john@example.com',
                phone: '555-0199',
                comments: 'Is this available?',
                vehicle: {
                    year: 2024,
                    make: 'Tesla',
                    model: 'Model 3',
                    vin: 'MOCKVIN123',
                    stockNumber: 'S789',
                    price: 45000
                }
            };

            const adf = generateInquiryADF(mockInquiry as any);
            const parsed = await parseADF(adf);

            expect(parsed).not.toBeNull();
            expect(parsed?.firstName).toBe(mockInquiry.firstName);
            expect(parsed?.lastName).toBe(mockInquiry.lastName);
            expect(parsed?.email).toBe(mockInquiry.email);
            expect(parsed?.phone).toBe(mockInquiry.phone);
            expect(parsed?.comments).toBe(mockInquiry.comments);
            expect(parsed?.vehicle.vin).toBe(mockInquiry.vehicle.vin);
            expect(parsed?.vehicle.stock).toBe(mockInquiry.vehicle.stockNumber);
        });
    });

    describe('Finance Application ACID Transactions', () => {
        test('should rollback FinanceApplication save if Notification fails', async () => {
            // 1. Setup Data
            await Vehicle.create({
                _id: TEST_VEHICLE_ID,
                vin: 'FINANCE_TEST_VIN',
                year: 2024,
                make: 'BMW',
                modelName: 'M3',
                stockNumber: 'F001',
                price: 75000,
                organizationId: TEST_ORG_ID,
                status: 'Ready for Sale',
                isDeleted: false
            });

            const mockApp = {
                vehicleId: TEST_VEHICLE_ID.toString(),
                personalInfo: {
                    firstName: 'Alice',
                    lastName: 'Transaction',
                    email: 'alice@rollback.com',
                    phone: '555-0001',
                    dob: '1990-01-01',
                    ssn: '123-45-6789',
                    address: {
                        street: '123 ACID St',
                        city: 'Rollback',
                        state: 'UT',
                        zip: '84000'
                    }
                },
                employmentInfo: {
                    employer: 'Rollback Inc',
                    jobTitle: 'Chaos Monkey',
                    income: '100000',
                    incomeFrequency: 'Yearly' as any,
                    yearsAtJob: '2'
                }
            };

            // 2. Mock Notification failure
            (NotificationService.broadcastNotification as jest.Mock).mockImplementationOnce(() => {
                throw new Error('Notification Service Down - Trigger Rollback');
            });

            // 3. Execute (should fail)
            const mockUser = { _id: new mongoose.Types.ObjectId(), organizationId: TEST_ORG_ID };

            await expect(
                LeadService.processFinanceApp({
                    organizationId: TEST_ORG_ID,
                    customerId: mockUser._id.toString(),
                    ...mockApp as any
                })
            ).rejects.toThrow('Notification Service Down - Trigger Rollback');

            // 4. Verify Rollback: App should NOT exist in DB
            const appInDb = await FinanceApplication.findOne({ 'personalInfo.firstName': 'Alice' });
            expect(appInDb).toBeNull();
        });

        test('should successfully save and encrypt finance app on success', async () => {
            const mockApp = {
                vehicleId: TEST_VEHICLE_ID.toString(),
                personalInfo: {
                    firstName: 'Bob',
                    lastName: 'Secure',
                    email: 'bob@secure.com',
                    phone: '555-0002',
                    dob: '1985-05-05',
                    ssn: '999-88-7777',
                    address: {
                        street: '456 Crypto Ave',
                        city: 'Vault',
                        state: 'UT',
                        zip: '84001'
                    }
                },
                employmentInfo: {
                    employer: 'SecureCorp',
                    jobTitle: 'Guardian',
                    income: '120000',
                    incomeFrequency: 'Yearly' as any,
                    yearsAtJob: '5'
                }
            };

            // 1. Mock Notification success
            (NotificationService.broadcastNotification as jest.Mock).mockResolvedValueOnce(true);

            // 2. Execute
            const mockUser = { _id: new mongoose.Types.ObjectId(), organizationId: TEST_ORG_ID };
            await LeadService.processFinanceApp({
                organizationId: TEST_ORG_ID,
                customerId: mockUser._id.toString(),
                ...mockApp as any
            });

            // 3. Verify Persistence
            const app = await FinanceApplication.findOne({ 'personalInfo.firstName': 'Bob' });
            expect(app).not.toBeNull();

            // 4. Verify Encryption Logic
            // The document in the database is encrypted, but our model method provides decryption.
            expect(app?.getDecryptedSsn()).toBe(mockApp.personalInfo.ssn);
        });
    });
});
