import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

export const ftpServerConfig = {
    port: parseInt(process.env.FTP_SERVER_PORT || '2121', 10),

    passiveUrl: process.env.FTP_PASSIVE_URL || '127.0.0.1',

    pasv_min: parseInt(process.env.FTP_PASV_MIN || '21000', 10),
    pasv_max: parseInt(process.env.FTP_PASV_MAX || '21010', 10),

    username: process.env.FTP_SERVER_USER || 'dealerscloud',
    password: process.env.FTP_SERVER_PASSWORD || 'changeme123',

    uploadDir: process.env.FTP_UPLOAD_DIR || './ftp-uploads',
};
