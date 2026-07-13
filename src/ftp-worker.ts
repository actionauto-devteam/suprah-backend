import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import actionFtpServer from './services/ftp-server.service';
import config from './config';

dotenv.config({ path: path.join(__dirname, '../.env') });


async function startFtpWorker() {
    try {
        console.log('🚀 Starting Stateless FTP Worker...');

        console.log('📦 Connecting to MongoDB...');
        await mongoose.connect(config.mongoose.url);
        console.log('✅ MongoDB connected');

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

startFtpWorker();
