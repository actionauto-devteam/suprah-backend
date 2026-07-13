import { FileSystem } from 'ftp-srv';
import { 
    S3Client, 
    ListObjectsV2Command, 
    PutObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand, 
    HeadObjectCommand 
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import config from '../config';
import { PassThrough, Readable, Transform } from 'stream';
import path from 'path';
import syncService from './sync.service';

export class R2FileSystem extends FileSystem {
    private s3Client: S3Client;
    private bucket: string;
    private currentPath: string = '/';

    constructor(connection: any, options: { root: string; cwd: string }) {
        super(connection, options);
        this.bucket = config.r2.buckets.ftp;
        this.s3Client = new S3Client({
            region: 'auto',
            endpoint: config.r2.endpoint,
            credentials: {
                accessKeyId: config.r2.accessKeyId,
                secretAccessKey: config.r2.secretAccessKey,
            },
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });
    }

    private getR2Key(fileName: string): string {
        const joined = path.posix.join(this.currentPath, fileName);
        return joined.startsWith('/') ? joined.slice(1) : joined;
    }

    currentDirectory(): string {
        return this.currentPath;
    }

    async chdir(newPath: string): Promise<string> {
        this.currentPath = path.posix.resolve(this.currentPath, newPath);
        return this.currentPath;
    }

    async list(targetPath: string = '.'): Promise<any[]> {
        const resolvedPath = path.posix.resolve(this.currentPath, targetPath);
        const prefix = resolvedPath === '/' ? '' : (resolvedPath.endsWith('/') ? resolvedPath.slice(1) : resolvedPath.slice(1) + '/');

        const command = new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            Delimiter: '/',
        });

        const response = await this.s3Client.send(command);
        const files: any[] = [];

        if (response.CommonPrefixes) {
            for (const cp of response.CommonPrefixes) {
                if (cp.Prefix) {
                    files.push({
                        name: path.posix.basename(cp.Prefix.endsWith('/') ? cp.Prefix.slice(0, -1) : cp.Prefix),
                        isDirectory: () => true,
                        size: 0,
                        mtime: new Date(),
                    });
                }
            }
        }

        if (response.Contents) {
            for (const item of response.Contents) {
                if (item.Key && item.Key !== prefix) {
                    files.push({
                        name: path.posix.basename(item.Key),
                        isDirectory: () => false,
                        size: item.Size || 0,
                        mtime: item.LastModified || new Date(),
                    });
                }
            }
        }

        return files;
    }

    async get(fileName: string): Promise<any> {
        const key = this.getR2Key(fileName);
        try {
            const command = new HeadObjectCommand({
                Bucket: this.bucket,
                Key: key,
            });
            const response = await this.s3Client.send(command);
            return {
                name: path.posix.basename(key),
                isDirectory: () => false,
                size: response.ContentLength || 0,
                mtime: response.LastModified || new Date(),
            };
        } catch (error) {
            return {
                name: path.posix.basename(key),
                isDirectory: () => true,
                size: 0,
                mtime: new Date(),
            };
        }
    }

    write(fileName: string, { append = false } = {}): any {
        if (append) {
            throw new Error('Append is not supported in R2 FileSystem');
        }

        const key = this.getR2Key(fileName);
        
        const uploadSink = new PassThrough();
        
        const parallelUploads3 = new Upload({
            client: this.s3Client,
            params: {
                Bucket: this.bucket,
                Key: key,
                Body: uploadSink,
            },
            queueSize: 1, 
            partSize: 5 * 1024 * 1024,
        });

        const uploadPromise = parallelUploads3.done();

        parallelUploads3.on('httpUploadProgress', (progress) => {
            if (progress.loaded) {
                console.log(`[R2FileSystem] ⏳ Uploading ${key}: ${progress.loaded} bytes sent`);
            }
        });

        const bridge = new Transform({
            transform(chunk, encoding, callback) {
                // Pipe data into the R2 upload sink. 
                // This will now drain properly because the uploadPromise is active.
                const canAcceptMore = uploadSink.write(chunk, encoding);
                if (canAcceptMore) {
                    callback();
                } else {
                    uploadSink.once('drain', callback);
                }
            },
            async flush(callback) {
                try {
                    console.log(`[R2FileSystem] 🏁 FTP data received for ${key}. Finalizing R2 upload...`);
                    
                    // 1. Mark the sink as finished so the SDK knows no more data is coming
                    uploadSink.end();
                    
                    // 2. Wait for the SDK to confirm the final handshake with R2
                    await uploadPromise;
                    
                    console.log(`[R2FileSystem] ✅ Successfully uploaded: ${key}`);

                    // 3. Trigger inventory sync for any inventory file.
                    //    Trigger on EXTENSION (.txt/.csv) rather than a filename
                    //    substring — DealersCloud uploads names like "DealerCloud.txt"
                    //    which do NOT contain the string "dealerscloud", so the old
                    //    name-match check silently skipped the sync.
                    const lowerKey = key.toLowerCase();
                    if (lowerKey.endsWith('.txt') || lowerKey.endsWith('.csv')) {
                        console.log(`[R2FileSystem] 🔄 Triggering Inventory Sync for: ${key}`);
                        syncService.processR2File(key).catch(err => {
                            console.error(`[R2FileSystem] ❌ Sync Error for ${key}:`, err);
                        });
                    } else {
                        console.log(`[R2FileSystem] ⏭  Skipping sync (not a .txt/.csv inventory file): ${key}`);
                    }

                    // 4. Resolve the FTP command
                    callback();
                } catch (err: any) {
                    console.error(`[R2FileSystem] ❌ Synchronized Upload Error:`, err);
                    callback(err);
                }
            }
        });

        // Safety: ensure errors on the sink propagate to the bridge
        uploadSink.on('error', (err) => {
            bridge.destroy(err);
        });

        return bridge;
    }

    /**
     * Handles RETR command
     */
    async read(fileName: string): Promise<Readable> {
        const key = this.getR2Key(fileName);
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });

        const response = await this.s3Client.send(command);
        return response.Body as Readable;
    }

    async delete(fileName: string): Promise<void> {
        const key = this.getR2Key(fileName);
        const command = new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });
        await this.s3Client.send(command);
    }

    async mkdir(dirPath: string): Promise<string> {
        // S3 doesn't have real directories, just keys
        return path.posix.resolve(this.currentPath, dirPath);
    }

    async rename(from: string, to: string): Promise<void> {
        throw new Error('Rename is not supported in R2 FileSystem (use copy/delete)');
    }
}