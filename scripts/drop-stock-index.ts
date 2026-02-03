import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

async function repair() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-backend');

        console.log('Dropping stockNumber_1 index...');
        const collection = mongoose.connection.collection('vehicles');
        await collection.dropIndex('stockNumber_1');

        console.log('✅ Index dropped successfully');
        process.exit(0);
    } catch (error: any) {
        if (error.codeName === 'IndexNotFound') {
            console.log('✅ Index does not exist, nothing to drop.');
            process.exit(0);
        }
        console.error('❌ Error dropping index:', error.message);
        process.exit(1);
    }
}

repair();
