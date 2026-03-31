import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Organization from '../src/models/Organization.model';
import { encrypt } from '../src/utils/crypto';

// Load .env
dotenv.config({ path: path.join(__dirname, '../.env') });

const migrate = async () => {
    try {
        console.log('🚀 Starting Central Gmail Migration...');

        await mongoose.connect(process.env.MONGODB_URI!);
        console.log('✅ Connected to MongoDB');

        // 1. Find the primary organization
        // We'll look for 'action-auto-test' or just the first one if it's a single-tenant layout right now
        let org = await Organization.findOne({ slug: 'action-auto-test' });
        if (!org) {
            org = await Organization.findOne();
        }

        if (!org) {
            console.error('❌ No organization found in Database. Please create an organization first.');
            process.exit(1);
        }

        console.log(`📦 Target Organization: ${org.name} (${org._id})`);

        // 2. Read tokens from ENV
        const gmailAddress = process.env.CENTRAL_INGESTION_EMAIL;
        const accessToken = process.env.CENTRAL_GMAIL_ACCESS_TOKEN;
        const refreshToken = process.env.CENTRAL_GMAIL_REFRESH_TOKEN;
        const expiryDate = Number(process.env.CENTRAL_GMAIL_EXPIRY_DATE);

        if (!gmailAddress || !accessToken || !refreshToken) {
            console.error('❌ Missing CENTRAL_GMAIL_* environment variables.');
            process.exit(1);
        }

        // 3. Create or Update OrgLeadConfig
        const config = await OrgLeadConfig.findOneAndUpdate(
            { organizationId: org._id },
            {
                $set: {
                    gmailAddress,
                    accessToken: encrypt(accessToken),
                    refreshToken: encrypt(refreshToken),
                    expiryDate,
                    gmailConnected: true,
                    leadSourceEmail: 'leads@dealerscloud.com',
                    isActive: true,
                    connectedAt: new Date(),
                }
            },
            { upsert: true, new: true }
        );

        console.log('✅ Migration Successful!');
        console.log('Config ID:', config._id);
        console.log('Org ID:', org._id);
        console.log('\n--- NEXT STEPS ---');
        console.log('1. You can now safely remove CENTRAL_GMAIL_* variables from .env');
        console.log('2. The hourly scheduler will now pick up this organization automatically.');

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration Failed:', error);
        process.exit(1);
    }
};

migrate();
