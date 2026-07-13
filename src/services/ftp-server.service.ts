import { FtpSrv } from 'ftp-srv';
import path from 'path';
import fs from 'fs/promises';
import { ftpServerConfig } from '../config/ftp-server.config';
import config from '../config';
import syncService from './sync.service';
import { R2FileSystem } from './r2-ftp-fs.service';
import { existsSync } from 'fs';
import logger from '../utils/logger';

const log = logger.child({ module: 'ftp-server' });

export class ActionFtpServer {
    private ftpServer: FtpSrv | null = null;

    async start(): Promise<void> {
        try {
            console.log('🔍 DEBUG: FTP Initialization started');
            console.log('🔍 DEBUG: certPath:', config.ftpServer.tlsCertPath);
            console.log('🔍 DEBUG: keyPath:', config.ftpServer.tlsKeyPath);
            console.log('🔍 DEBUG: forceTls:', config.ftpServer.forceTls);
            console.log('🔍 DEBUG: env:', config.env);

            let tls: any = false;

            if (config.ftpServer.forceTls) {
                if (config.ftpServer.tlsCertPath && config.ftpServer.tlsKeyPath) {
                    try {
                        const certExists = existsSync(config.ftpServer.tlsCertPath);
                        const keyExists = existsSync(config.ftpServer.tlsKeyPath);
                        console.log('🔍 DEBUG: Cert Exists:', certExists);
                        console.log('🔍 DEBUG: Key Exists:', keyExists);

                        if (certExists && keyExists) {
                            tls = {
                                cert: await fs.readFile(config.ftpServer.tlsCertPath),
                                key: await fs.readFile(config.ftpServer.tlsKeyPath),
                                minVersion: 'TLSv1.2',
                                maxVersion: 'TLSv1.2',
                            };
                            log.info('FTP TLS encryption enabled');
                        } else if (config.env === 'production') {
                            log.fatal('CRITICAL: FTP TLS requested for production but certificates are missing!');
                            throw new Error('FTP TLS certificates required but not found');
                        } else {
                            log.warn('FTP TLS certificates not found, falling back to plaintext');
                        }
                    } catch (err) {
                        log.error({ err }, 'Failed to load FTP TLS certificates');
                        if (config.env === 'production') throw err;
                    }
                } else if (config.env === 'production') {
                    log.fatal('CRITICAL: FTP TLS forced but no certificate paths configured!');
                    throw new Error('FTP TLS configuration missing for production');
                }
            } else {
                log.warn(
                    'FTP_FORCE_TLS=false — running PLAINTEXT FTP (no encryption). ' +
                    'Restrict the firewall to the uploader IP and use a strong password.',
                );
            }

            this.ftpServer = new FtpSrv({
                url: `ftp://0.0.0.0:${ftpServerConfig.port}`,
                pasv_url: ftpServerConfig.passiveUrl,
                pasv_min: ftpServerConfig.pasv_min,
                pasv_max: ftpServerConfig.pasv_max,
                greeting: ['Welcome to ActionAuto FTP Server'],
                anonymous: false,
                tls: tls,
            });

            // Authentication handler
            this.ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
                log.info({ username }, 'Login attempt');

                if (username === ftpServerConfig.username && password === ftpServerConfig.password) {
                    log.info({ username }, 'Login successful');

                    // Set up cloud file system for this connection
                    resolve({
                        fs: new R2FileSystem(connection, {
                            root: '/',
                            cwd: '/'
                        }) as any
                    });
                } else {
                    log.warn({ username }, 'Login failed - invalid credentials');
                    reject(new Error('Invalid username or password'));
                }
            });

            // File upload handler
            (this.ftpServer as any).on('STOR', async (error: Error | null, filePath: string) => {
                if (error) {
                    log.error({ error }, 'File upload error');
                    return;
                }

                log.info({ filePath }, 'File uploaded successfully to R2');

                const isInventory = filePath && (filePath.endsWith('.csv') || filePath.endsWith('.txt'));
                
                if (isInventory) {
                    const key = filePath.startsWith('/') ? filePath.slice(1) : filePath;
                    log.info({ key }, 'Processing uploaded inventory from R2');

                    try {
                        await syncService.processR2File(key);
                        log.info({ key }, 'Inventory processed successfully from cloud storage');
                    } catch (err) {
                        log.error({ err, key }, 'Error processing inventory from R2');
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
                    tls: tls !== false,
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