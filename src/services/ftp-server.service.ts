import { FtpSrv, FileSystem } from 'ftp-srv';
import bunyan from 'bunyan';
import path from 'path';
import fs from 'fs/promises';
import { ftpServerConfig } from '../config/ftp-server.config';
import syncService from './sync.service';

const log = bunyan.createLogger({ name: 'ftp-server' });

export class ActionFtpServer {
    private ftpServer: FtpSrv | null = null;

    /**
     * Initialize and start the FTP server
     */
    async start(): Promise<void> {
        try {
            // Ensure upload directory exists
            await fs.mkdir(ftpServerConfig.uploadDir, { recursive: true });

            this.ftpServer = new FtpSrv({
                url: `ftp://0.0.0.0:${ftpServerConfig.port}`,
                pasv_url: ftpServerConfig.passiveUrl,
                pasv_min: ftpServerConfig.pasv_min,
                pasv_max: ftpServerConfig.pasv_max,
                greeting: ['Welcome to ActionAuto FTP Server'],
                anonymous: false,
            });

            // Authentication handler
            this.ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
                log.info({ username }, 'Login attempt');

                if (username === ftpServerConfig.username && password === ftpServerConfig.password) {
                    log.info({ username }, 'Login successful');

                    // Set up file system for this connection
                    resolve({
                        fs: new FileSystem(connection, {
                            root: path.resolve(ftpServerConfig.uploadDir),
                            cwd: '/'
                        })
                    });
                } else {
                    log.warn({ username }, 'Login failed - invalid credentials');
                    reject(new Error('Invalid username or password'));
                }
            });

            // File upload handler
            // Note: STOR event exists in ftp-srv but not in TypeScript definitions
            (this.ftpServer as any).on('STOR', async (error: Error | null, filePath: string) => {
                if (error) {
                    log.error({ error }, 'File upload error');
                    return;
                }

                log.info({ filePath }, 'File uploaded successfully');

                // Check if it's a CSV file
                if (filePath && filePath.endsWith('.csv')) {
                    const fullPath = path.join(ftpServerConfig.uploadDir, path.basename(filePath));
                    log.info({ fullPath }, 'Processing uploaded CSV file');

                    try {
                        // Trigger sync service to process the file
                        await syncService.processLocalFile(fullPath);
                        log.info({ fullPath }, 'File processed successfully');

                        // Optional: Delete file after processing
                        await fs.unlink(fullPath);
                        log.info({ fullPath }, 'File deleted after processing');
                    } catch (err) {
                        log.error({ err, fullPath }, 'Error processing uploaded file');
                    }
                }
            });

            // Error handler
            this.ftpServer.on('client-error', ({ connection, context, error }) => {
                log.error({ error, context }, 'FTP Client Error');
            });

            // Start listening
            await this.ftpServer.listen();
            log.info(
                {
                    port: ftpServerConfig.port,
                    passiveUrl: ftpServerConfig.passiveUrl,
                    pasvRange: `${ftpServerConfig.pasv_min}-${ftpServerConfig.pasv_max}`,
                },
                'FTP Server started successfully'
            );
        } catch (error) {
            log.error({ error }, 'Failed to start FTP server');
            throw error;
        }
    }

    /**
     * Stop the FTP server gracefully
     */
    async stop(): Promise<void> {
        if (this.ftpServer) {
            await this.ftpServer.close();
            log.info('FTP Server stopped');
            this.ftpServer = null;
        }
    }
}

export default new ActionFtpServer();
