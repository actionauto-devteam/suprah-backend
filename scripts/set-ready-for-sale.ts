
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import Vehicle from '../src/models/Vehicle.model';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

async function updateVehicles() {
    try {
        console.log('📦 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI as string);
        console.log('✅ MongoDB connected');

        console.log('🔄 Updating vehicles...');

        // Update all vehicles to 'Ready for Sale' and ensure they are not deleted
        const result = await Vehicle.updateMany(
            {}, // Match all documents
            {
                $set: {
                    status: 'Ready for Sale',
                    isDeleted: false // Also un-delete them just in case
                }
            }
        );

        console.log(`✅ Success! Updated ${result.modifiedCount} vehicles.`);
        console.log('🎉 All vehicles are now "Ready for Sale"');

    } catch (error) {
        console.error('❌ Error updating vehicles:', error);
    } finally {
        await mongoose.disconnect();
        process.exit();
    }
}

updateVehicles();
