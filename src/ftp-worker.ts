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
        const path = require('path');

        const uploadDir = ftpServerConfig.uploadDir;
        const processedDir = path.join(uploadDir, 'processed');

        // Ensure processed directory exists
        try {
            await fs.mkdir(processedDir, { recursive: true });
        } catch (error) {
            console.error('⚠️ Could not create processed directory:', error);
        }

        const watcher = chokidar.watch(uploadDir, {
            ignored: [
                /(^|[\/\\])\../, // ignore dotfiles
                processedDir // ignore processed directory to prevent loops
            ],
            persistent: true,
            ignoreInitial: true, // Don't process existing files on startup
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        watcher.on('add', async (filePath: string) => {
            // Only process CSV files that are NOT in the processed directory
            if (filePath.endsWith('.csv') && !filePath.includes('processed')) {
                console.log(`📥 New file detected: ${filePath}`);
                try {
                    await syncService.processLocalFile(filePath);
                    console.log(`✅ File processed successfully: ${filePath}`);

                    // Move file to processed directory with timestamp
                    const fileName = path.basename(filePath, '.csv');
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const newFileName = `${fileName}_${timestamp}.csv`;
                    const newPath = path.join(processedDir, newFileName);

                    await fs.rename(filePath, newPath);
                    console.log(`📂 File moved to: ${newPath}`);
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
