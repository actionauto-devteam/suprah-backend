import dotenv from 'dotenv';
import path from 'path';

// Ensure .env is loaded
dotenv.config({ path: path.join(__dirname, '../.env') });

export const ftpServerConfig = {
    // Port: 21 is standard FTP, but requires root privileges
    // We use 2121 for local dev, and map it to 21 in Docker
    port: parseInt(process.env.FTP_SERVER_PORT || '2121', 10),

    // PUBLIC IP of the VPS - CRITICAL for Passive Mode
    // This tells FTP clients where to connect for data transfers
    passiveUrl: process.env.FTP_PASSIVE_URL || '127.0.0.1',

    // Passive port range for data connections
    pasv_min: parseInt(process.env.FTP_PASV_MIN || '21000', 10),
    pasv_max: parseInt(process.env.FTP_PASV_MAX || '21010', 10),

    // Authentication credentials
    username: process.env.FTP_SERVER_USER || 'dealerscloud',
    password: process.env.FTP_SERVER_PASSWORD || 'changeme123',

    // Upload directory (relative to project root)
    uploadDir: process.env.FTP_UPLOAD_DIR || './ftp-uploads',
};
