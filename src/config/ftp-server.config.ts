import dotenv from 'dotenv';
import path from 'path';

// Ensure .env is loaded
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const ftpConfig = {
    port: parseInt(process.env.FTP_PORT || '2121', 10), // 2121 is common for non-root users
    pasv_url: process.env.FTP_PASV_URL || '127.0.0.1', // The Public IP of the VPS
    pasv_min: 30000,
    pasv_max: 30100,
    user: process.env.FTP_USER || 'admin',
    pass: process.env.FTP_PASS || 'admin123',
    // Directory where uploads are temporarily stored before processing
    uploadDir: path.join(process.cwd(), 'temp_uploads'), 
};
