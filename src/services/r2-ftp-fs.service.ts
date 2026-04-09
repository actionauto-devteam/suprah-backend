import { FileSystem } from 'ftp-srv';
import { 
    S3Client, 
    ListObjectsV2Command, 
    PutObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand, 
    HeadObjectCommand 
} from '@aws-sdk/client-s3';
import config from '../config';
import { PassThrough, Readable } from 'stream';
import path from 'path';

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
        });
    }

    /**
     * Helper to resolve path for R2
     */
    private getR2Key(fileName: string): string {
        const joined = path.posix.join(this.currentPath, fileName);
        // Remove leading slash for S3 keys
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

        // Handle subdirectories (CommonPrefixes)
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

        // Handle files (Contents)
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
            // If it's not a file, it might be a directory
            return {
                name: path.posix.basename(key),
                isDirectory: () => true,
                size: 0,
                mtime: new Date(),
            };
        }
    }

    /**
     * Handles STOR command
     */
    write(fileName: string, { append = false } = {}): any {
        if (append) {
            throw new Error('Append is not supported in R2 FileSystem');
        }

        const key = this.getR2Key(fileName);
        const passThrough = new PassThrough();

        // Start upload to R2 in background
        const upload = async () => {
            try {
                const command = new PutObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                    Body: passThrough,
                });
                await this.s3Client.send(command);
            } catch (err) {
                console.error(`[R2FileSystem] Upload Error for ${key}:`, err);
                passThrough.destroy(err as Error);
            }
        };

        upload();

        return passThrough;
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
