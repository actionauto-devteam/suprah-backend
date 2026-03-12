import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.join(__dirname, '../.env.local') });

async function diagnose() {
    await mongoose.connect(process.env.MONGODB_URI!);
    console.log('Connected to DB');

    const user = await mongoose.connection.db.collection('users').findOne({ name: /John Loyd Belen/i });
    if (!user) {
        console.log('User not found');
        return;
    }

    const orgId = user.organizationId;
    console.log(`User OrgId: ${orgId}`);

    const payments = await mongoose.connection.db.collection('payments').find({ organizationId: orgId }).toArray();
    console.log(`Total Payments: ${payments.length}`);

    const succeeded = payments.filter(p => p.status === 'succeeded');
    console.log(`Succeeded Payments: ${succeeded.length}`);

    if (succeeded.length > 0) {
        console.log('Sample Succeeded Payment:', {
            amount: succeeded[0].amount,
            status: succeeded[0].status,
            createdAt: succeeded[0].createdAt,
            organizationId: succeeded[0].organizationId
        });
    }

    // Run the same query logic as DashboardService
    const dateRange = new Date();
    dateRange.setFullYear(dateRange.getFullYear() - 1);

    const aggregationResult = await mongoose.connection.db.collection('payments').aggregate([
        {
            $match: {
                organizationId: orgId,
                status: 'succeeded',
                createdAt: { $gte: dateRange }
            }
        },
        {
            $group: {
                _id: { $month: '$createdAt' },
                revenue: { $sum: '$amount' },
                date: { $first: '$createdAt' }
            }
        }
    ]).toArray();

    console.log('Aggregation Result:', JSON.stringify(aggregationResult, null, 2));

    await mongoose.disconnect();
}

diagnose().catch(console.error);
