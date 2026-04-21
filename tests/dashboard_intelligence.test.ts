import { DashboardService } from '../src/services/dashboard.service';
import Shipment from '../src/models/Shipment.model';
import DriverProfile from '../src/models/DriverProfile.model';
import AnalyticsAggregate from '../src/models/AnalyticsAggregate.model';

// Mock everything to avoid DB connection issues
const actualMongoose = jest.requireActual('mongoose');

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true),
    connection: {
      ...actual.connection,
      readyState: 1,
      name: 'test-db',
      db: { databaseName: 'test-db' }
    }
  };
});

jest.mock('../src/models/Shipment.model');
jest.mock('../src/models/DriverProfile.model');
jest.mock('../src/models/AnalyticsAggregate.model');
jest.mock('../src/models/Quote.model');
jest.mock('../src/models/Payment.model');
jest.mock('../src/models/lead.model');
jest.mock('../src/models/Appointment.model');
jest.mock('../src/models/SupraSpaceConversation.model');
jest.mock('../src/models/User.model');
jest.mock('../src/models/Vehicle.model');
jest.mock('../src/models/DriverLocation.model');

describe('Dashboard Intelligence Unit Tests (Mocked)', () => {
    const orgId = 'org123';

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('should calculate net margin correctly from mocks', async () => {
        const mockShipments = [
            { 
                preservedQuoteData: { rate: 2000 }, 
                carrierPayAmount: 1500 
            },
            { 
                preservedQuoteData: { rate: 1000 }, 
                carrierPayAmount: 850 
            }
        ];

        (Shipment.find as jest.Mock).mockReturnValue({
            select: jest.fn().mockResolvedValue(mockShipments)
        });

        const margin = await (DashboardService as any).getLogisticsMargin(orgId);
        // (2000-1500) + (1000-850) = 500 + 150 = 650
        expect(margin).toBe(650);
    });

    test('should count compliance alerts from mocks', async () => {
        (DriverProfile.countDocuments as jest.Mock).mockResolvedValue(4);

        const alerts = await (DashboardService as any).getComplianceAlerts(orgId);
        expect(alerts).toBe(4);
    });

    test('should calculate speed to lead from analytics mocks', async () => {
        const mockAggregates = [
            { kpis: { avgResponseTimeMin: 12 } },
            { kpis: { avgResponseTimeMin: 8 } }
        ];

        (AnalyticsAggregate.find as jest.Mock).mockReturnValue({
            sort: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                    select: jest.fn().mockResolvedValue(mockAggregates)
                })
            })
        });

        const speed = await (DashboardService as any).getSpeedToLead(orgId);
        // (12 + 8) / 2 = 10
        expect(speed).toBe(10);
    });
});
