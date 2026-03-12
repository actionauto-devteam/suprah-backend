import mongoose from 'mongoose';
import { DashboardService } from '../src/services/dashboard.service';
import User from '../src/models/User.model';
import Shipment from '../src/models/Shipment.model';
import Quote from '../src/models/Quote.model';
import Payment from '../src/models/Payment.model';
import Lead from '../src/models/lead.model';

describe('Dashboard Metrics Service (Safe In-Place Test)', () => {
    const TEST_ORG_ID = new mongoose.Types.ObjectId();
    let testUserId: mongoose.Types.ObjectId;

    beforeAll(async () => {
        // Ensure connection (uses MONGODB_URI from .env)
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGODB_URI || '');
        }

        // Create a test user
        const user = await User.create({
            name: 'Test Rep',
            email: `test_${Date.now()}@example.com`,
            password: 'password123',
            role: 'employee',
            organizationId: TEST_ORG_ID
        });
        testUserId = user._id as mongoose.Types.ObjectId;
    });

    afterAll(async () => {
        // Targeted cleanup of ONLY our test data
        await Promise.all([
            User.deleteMany({ organizationId: TEST_ORG_ID }),
            Shipment.deleteMany({ organizationId: TEST_ORG_ID }),
            Quote.deleteMany({ organizationId: TEST_ORG_ID }),
            Payment.deleteMany({ organizationId: TEST_ORG_ID }),
            Lead.deleteMany({ organizationId: TEST_ORG_ID })
        ]);
        // await mongoose.connection.close(); // Not closing to let other tests run if needed
    });

    it('should aggregate metrics correctly for a new organization', async () => {
        const orgIdStr = TEST_ORG_ID.toString();

        // 1. Create seed data for this specific test org
        await Promise.all([
            // Create a pending quote (potential revenue)
            Quote.create({
                firstName: 'John',
                lastName: 'Doe',
                email: 'john@example.com',
                phone: '1234567890',
                fromZip: '90210',
                toZip: '10001',
                fromAddress: 'LA',
                toAddress: 'NY',
                miles: 2500,
                rate: 1500,
                eta: { min: 3, max: 5 },
                status: 'pending',
                organizationId: orgIdStr
            }),
            // Create a succeeded payment (revenue trajectory)
            Payment.create({
                organizationId: orgIdStr,
                customerId: 'john@example.com',
                customerName: 'John Doe',
                customerEmail: 'john@example.com',
                amount: 1500,
                currency: 'usd',
                status: 'succeeded',
                description: 'Service Payment',
                createdBy: testUserId
            }),
            // Create a shipment (leaderboard win)
            Shipment.create({
                quoteId: new mongoose.Types.ObjectId(),
                organizationId: orgIdStr,
                status: 'In-Route',
                origin: 'LA',
                destination: 'NY',
                requestedPickupDate: new Date(),
                trackingNumber: 'TEST-123',
                createdBy: testUserId
            })
        ]);

        // 2. Clear cache by using a unique orgId (already done)
        const metrics = await DashboardService.getDashboardMetrics(orgIdStr, '1Y');

        // 3. Verifications
        expect(metrics.stats.potentialRevenue).toBe(1500);
        expect(metrics.revenueTrajectory).toContainEqual(expect.objectContaining({ revenue: 1500 }));

        const repEntry = metrics.leaderboard.find(r => r.name === 'Test Rep');
        expect(repEntry).toBeDefined();
        expect(repEntry?.shipments).toBe(1);
    });
});
