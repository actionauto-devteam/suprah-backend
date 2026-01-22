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
 * - Accepting FTP connections from DealersCloud
 * - Receiving CSV file uploads
 * - Triggering automatic inventory sync
 */

async function startFtpWorker() {
    try {
        console.log('🚀 Starting FTP Worker...');

        // Connect to MongoDB
        console.log('📦 Connecting to MongoDB...');
        await mongoose.connect(config.mongoose.url);
        console.log('✅ MongoDB connected');

        // Start FTP Server
        console.log('📡 Starting FTP Server...');
        await actionFtpServer.start();
        console.log('✅ FTP Server is running');

        // Start file watcher for automatic processing
        console.log('👀 Starting file watcher...');
        const chokidar = require('chokidar');
        const ftpServerConfig = require('./config/ftp-server.config').ftpServerConfig;
        const syncService = require('./services/sync.service').default;
        const fs = require('fs/promises');

        const watcher = chokidar.watch(ftpServerConfig.uploadDir, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            ignoreInitial: true, // Don't process existing files on startup
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        watcher.on('add', async (filePath: string) => {
            if (filePath.endsWith('.csv')) {
                console.log(`📥 New file detected: ${filePath}`);
                try {
                    await syncService.processLocalFile(filePath);
                    console.log(`✅ File processed successfully: ${filePath}`);

                    // Delete file after processing
                    await fs.unlink(filePath);
                    console.log(`🗑️  File deleted: ${filePath}`);
                } catch (error) {
                    console.error(`❌ Error processing file ${filePath}:`, error);
                }
            }
        });

        console.log('✅ File watcher is running');

        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log('  FTP Worker Ready');
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
    await actionFtpServer.stop();
    await mongoose.connection.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('⚠️  SIGINT received, shutting down gracefully...');
    await actionFtpServer.stop();
    await mongoose.connection.close();
    process.exit(0);
});

// Start the worker
startFtpWorker();
