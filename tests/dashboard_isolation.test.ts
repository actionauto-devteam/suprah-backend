import mongoose from 'mongoose';
import { DashboardService } from '../src/services/dashboard.service';
import User from '../src/models/User.model';
import Quote from '../src/models/Quote.model';
import Vehicle from '../src/models/Vehicle.model';
import Payment from '../src/models/Payment.model';
import Lead from '../src/models/lead.model';
import SupraSpaceConversation from '../src/models/SupraSpaceConversation.model';
import Appointment from '../src/models/Appointment.model';
import Shipment from '../src/models/Shipment.model';
import DriverLocation from '../src/models/DriverLocation.model';

// Mock all models
jest.mock('../src/models/User.model');
jest.mock('../src/models/Quote.model');
jest.mock('../src/models/Vehicle.model');
jest.mock('../src/models/Payment.model');
jest.mock('../src/models/lead.model');
jest.mock('../src/models/SupraSpaceConversation.model');
jest.mock('../src/models/Appointment.model');
jest.mock('../src/models/Shipment.model');
jest.mock('../src/models/DriverLocation.model');

describe('DashboardService Isolation', () => {
    const org1 = new mongoose.Types.ObjectId().toString();
    const org2 = new mongoose.Types.ObjectId().toString();
    const user1 = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should query metrics only for the specified organization', async () => {
        // Mock User.find for employees
        (User.find as jest.Mock).mockReturnValue({
            select: jest.fn().mockResolvedValue([{ _id: user1, name: 'Test User' }])
        });

        // Mock aggregations and counts
        (Quote.aggregate as jest.Mock).mockResolvedValue([{
            potentialRevenue: [{ total: 1000 }],
            monthlyQuotes: [{ count: 5 }]
        }]);

        (Vehicle.countDocuments as jest.Mock).mockResolvedValue(10);
        (Payment.aggregate as jest.Mock).mockResolvedValue([]);
        (Payment.find as jest.Mock).mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([])
        });

        // Leaderboard mocks
        (Lead.countDocuments as jest.Mock).mockResolvedValue(0);
        (SupraSpaceConversation.countDocuments as jest.Mock).mockResolvedValue(0);
        (Appointment.countDocuments as jest.Mock).mockResolvedValue(0);
        (Shipment.countDocuments as jest.Mock).mockResolvedValue(0);

        // Logistics mocks
        (User.countDocuments as jest.Mock).mockResolvedValue(20); // total drivers
        (DriverLocation.countDocuments as jest.Mock).mockResolvedValue(5); // active drivers
        (User.aggregate as jest.Mock).mockResolvedValue([]);
        (Shipment.aggregate as jest.Mock).mockResolvedValue([]);

        await DashboardService.getDashboardMetrics(org1);

        // Verify Quote.aggregate was called with org1
        expect(Quote.aggregate).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({
                $match: expect.objectContaining({
                    $or: expect.arrayContaining([
                        { organizationId: org1 },
                        { organizationId: expect.any(Object) }
                    ])
                })
            })
        ]));

        // Verify Vehicle.countDocuments was called with org1
        expect(Vehicle.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
            $or: expect.arrayContaining([
                { organizationId: org1 },
                { organizationId: expect.any(Object) }
            ])
        }));

        // Verify SupraSpaceConversation.countDocuments was called with org1
        expect(SupraSpaceConversation.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
            $or: expect.arrayContaining([
                { organizationId: org1 },
                { organizationId: expect.any(Object) }
            ])
        }));

        // Verify DriverLocation.countDocuments was called for active drivers
        expect(DriverLocation.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
            $or: expect.arrayContaining([
                { organizationId: org1 },
                { organizationId: expect.any(Object) }
            ]),
            status: { $ne: 'offline' },
            lastSeenAt: expect.any(Object)
        }));

        // Verify User.countDocuments was called for total drivers
        expect(User.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
            $or: expect.arrayContaining([
                { organizationId: org1 },
                { organizationId: expect.any(Object) }
            ]),
            role: 'driver'
        }));
    });
});
