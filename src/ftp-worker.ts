import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import actionFtpServer from './services/ftp-server.service';
import config from './config';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

/**
 * FTP Worker - Standalone process for receiving inventory files via FTP
 * 
 * This worker runs independently from the main web server and handles:
 * - Accepting FTPS connections from DealersCloud
 * - Streaming CSV/TSV file uploads directly to Cloudflare R2
 * - Triggering automatic inventory sync from R2 streams
 */

async function startFtpWorker() {
    try {
        console.log('🚀 Starting Stateless FTP Worker...');

        // Connect to MongoDB
        console.log('📦 Connecting to MongoDB...');
        await mongoose.connect(config.mongoose.url);
        console.log('✅ MongoDB connected');

        // Start FTP Server (R2-backed)
        console.log('📡 Starting R2-Backed FTP Server...');
        await actionFtpServer.start();
        console.log('✅ FTP Server is running (Cloud-Native Mode)');

        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log('  FTP Worker Ready (Stateless & Encrypted)');
        console.log('═══════════════════════════════════════════════════════');
        console.log('');

    } catch (error) {
        console.error('❌ Failed to start FTP Worker:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('⚠️  SIGTERM received, shutting down gracefully...');
    if (actionFtpServer && actionFtpServer.stop) {
        await actionFtpServer.stop();
    }
    if (mongoose.connection) {
        await mongoose.connection.close();
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('⚠️  SIGINT received, shutting down gracefully...');
    if (actionFtpServer && actionFtpServer.stop) {
        await actionFtpServer.stop();
    }
    if (mongoose.connection) {
        await mongoose.connection.close();
    }
    process.exit(0);
});

// Start the worker
startFtpWorker();
