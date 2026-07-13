import mongoose from 'mongoose';
import { DashboardService } from '../dashboard.service';
import Shipment from '../../models/Shipment.model';
import DriverProfile from '../../models/DriverProfile.model';
import AnalyticsAggregate from '../../models/AnalyticsAggregate.model';

jest.mock('../../models/Shipment.model');
jest.mock('../../models/DriverProfile.model');
jest.mock('../../models/AnalyticsAggregate.model');
jest.mock('../../models/Quote.model');
jest.mock('../../models/Payment.model');
jest.mock('../../models/lead.model');
jest.mock('../../models/Appointment.model');
jest.mock('../../models/SupraSpaceConversation.model');
jest.mock('../../models/User.model');
jest.mock('../../models/Vehicle.model');
jest.mock('../../models/DriverLocation.model');

describe('DashboardService Intelligence Metrics', () => {
  const orgId = 'org123';

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getLogisticsStatus', () => {
    it('should calculate net margin for delivered shipments', async () => {
      const mockShipments = [
        {
          status: 'Delivered',
          preservedQuoteData: { rate: 1500 },
          carrierPayAmount: 1200
        },
        {
          status: 'Delivered',
          preservedQuoteData: { rate: 2000 },
          carrierPayAmount: 1600
        }
      ];

      (Shipment.find as jest.Mock).mockResolvedValue(mockShipments);

      const margin = await (DashboardService as any).getLogisticsMargin(orgId);

      expect(margin).toBe(700);
    });
  });

  describe('getComplianceAlerts', () => {
    it('should count drivers with expired compliance', async () => {
      (DriverProfile.countDocuments as jest.Mock).mockResolvedValue(3);

      const count = await (DashboardService as any).getComplianceAlerts(orgId);
      expect(count).toBe(3);
    });
  });

  describe('getSpeedToLead', () => {
    it('should average response time from analytics aggregates', async () => {
      const mockAggregates = [
        { kpis: { avgResponseTimeMin: 10 } },
        { kpis: { avgResponseTimeMin: 20 } }
      ];

      (AnalyticsAggregate.find as jest.Mock).mockResolvedValue(mockAggregates);

      const avg = await (DashboardService as any).getSpeedToLead(orgId);
      expect(avg).toBe(15);
    });

    it('should return 0 if no aggregates found', async () => {
      (AnalyticsAggregate.find as jest.Mock).mockResolvedValue([]);

      const avg = await (DashboardService as any).getSpeedToLead(orgId);
      expect(avg).toBe(0);
    });
  });
});
