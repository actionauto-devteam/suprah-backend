
import mongoose from 'mongoose';
import { config } from 'dotenv';
import path from 'path';
import AuditLog from '../src/models/AuditLog.model';
import SyncLog from '../src/models/SyncLog.model';
import User from '../src/models/User.model';

// Load env
config({ path: path.join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto';

async function verifyAuditLogs() {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected.');

    try {
        // 1. Create a dummy AuditLog
        console.log('Creating test AuditLog...');
        const testLog = await AuditLog.create({
            entityType: 'System',
            entityId: new mongoose.Types.ObjectId(),
            action: 'UPDATE',
            reason: 'Test Audit Log Entry',
            performedBy: null, // System
            changes: { test: true }
        });
        console.log('✅ Created AuditLog:', testLog._id);

        // 2. Fetch AuditLogs (Simulate Controller)
        console.log('Fetching AuditLogs...');
        const logs = await AuditLog.find({ reason: 'Test Audit Log Entry' });
        console.log(`✅ Fetched ${logs.length} logs.`);
        if (logs.length === 0) throw new Error('Failed to fetch logs');

        // 3. Test Aggregation (Stats)
        console.log('Testing AuditLog Stats Aggregation...');
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const stats = await AuditLog.aggregate([
            { $match: { timestamp: { $gte: thirtyDaysAgo } } },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]);
        console.log('✅ Stats computed:', stats);

        // 4. Create SyncLog
        console.log('Creating test SyncLog...');
        await SyncLog.create({
            jobName: 'InventorySync',
            status: 'COMPLETED',
            startTime: new Date(),
            endTime: new Date(),
            vehiclesProcessed: 10,
            vehiclesAdded: 2,
            vehiclesUpdated: 5,
            vehiclesDeleted: 0
        });
        console.log('✅ Created SyncLog');

        // 5. Fetch SyncLogs
        const syncLogs = await SyncLog.find().limit(1);
        console.log(`✅ Fetched ${syncLogs.length} SyncLogs.`);

    } catch (error) {
        console.error('❌ Verification Failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected.');
    }
}

verifyAuditLogs();
