import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import User from '../src/models/User.model';
import Shipment from '../src/models/Shipment.model';

// Load env vars
dotenv.config();

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const MONGODB_URI = process.env.MONGODB_URI;

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ENDPOINT || !R2_BUCKET_NAME || !MONGODB_URI) {
    console.error('Missing required environment variables for migration.');
    process.exit(1);
}

const s3Client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

async function uploadFileToR2(localPath: string, bucketKey: string) {
    const fileBuffer = fs.readFileSync(localPath);
    const contentType = getContentType(localPath);

    const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: bucketKey,
        Body: fileBuffer,
        ContentType: contentType,
    });

    await s3Client.send(command);
    return `${R2_PUBLIC_URL}/${bucketKey}`;
}

function getContentType(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.png': return 'image/png';
        case '.webp': return 'image/webp';
        default: return 'application/octet-stream';
    }
}

async function migrate() {
    const isDryRun = process.env.DRY_RUN === 'true';
    console.log(isDryRun ? '🚀 DRY RUN MODE ENABLED' : '🔥 LIVE MIGRATION STARTED');

    try {
        await mongoose.connect(MONGODB_URI!);
        console.log('connected to MongoDB');

        // 1. Migrate Avatars
        console.log('\n--- Migrating User Avatars ---');
        const users = await User.find({ avatar: { $regex: /^\/uploads\/avatars\// } });
        console.log(`Found ${users.length} users with local avatars.`);

        for (const user of users) {
            const localPath = path.join(__dirname, '..', user.avatar!);
            const filename = user.avatar!.replace('/uploads/avatars/', '');
            const bucketKey = `avatars/${filename}`;

            if (fs.existsSync(localPath)) {
                console.log(`Uploading avatar for user ${user.email}: ${filename}`);
                if (!isDryRun) {
                    const r2Url = await uploadFileToR2(localPath, bucketKey);
                    user.avatar = r2Url;
                    await user.save();
                }
            } else {
                console.warn(`File not found locally: ${localPath}`);
            }
        }

        // 2. Migrate Shipment Proofs
        console.log('\n--- Migrating Shipment Proofs ---');
        const shipments = await Shipment.find({ 'proofOfDelivery.imageUrl': { $regex: /^\/uploads\/proof-of-delivery\// } });
        console.log(`Found ${shipments.length} shipments with local proofs.`);

        for (const shipment of shipments) {
            const localUrl = shipment.proofOfDelivery!.imageUrl!;
            const localPath = path.join(__dirname, '..', localUrl);

            // Extract filename and potential shipment folder
            // format: /uploads/proof-of-delivery/SHIPMENT_ID/FILENAME.jpg or /uploads/proof-of-delivery/FILENAME.jpg
            const parts = localUrl.split('/');
            const filename = parts[parts.length - 1];
            const bucketKey = `proofs/${filename}`;

            if (fs.existsSync(localPath)) {
                console.log(`Uploading proof for shipment ${shipment._id}: ${filename}`);
                if (!isDryRun) {
                    const r2Url = await uploadFileToR2(localPath, bucketKey);
                    shipment.proofOfDelivery!.imageUrl = r2Url;
                    await shipment.save();
                }
            } else {
                console.warn(`File not found locally: ${localPath}`);
            }
        }

        console.log('\n✅ Migration completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
