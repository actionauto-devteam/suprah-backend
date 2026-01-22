import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import syncService from './services/sync.service';
import config from './config';

dotenv.config({ path: path.join(__dirname, '../.env') });

async function testProcessFile() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(config.mongoose.url);
        console.log('✅ Connected');

        const filePath = path.join(__dirname, '../ftp-uploads/test-inventory.csv');
        console.log(`📄 Processing file: ${filePath}`);

        const result = await syncService.processLocalFile(filePath);

        console.log('✅ Processing complete!');
        console.log('Result:', result);

        await mongoose.connection.close();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

testProcessFile();
