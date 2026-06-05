import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import config from '../config';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync, createReadStream } from 'fs';

export enum BucketType {
    PUBLIC = 'public',
    PRIVATE = 'private',
    FTP = 'ftp'
}

interface UploadOptions {
    allowLocalFallback?: boolean;
}

class StorageService {
    private s3Client: S3Client | null = null;
    private isConfigured: boolean = false;

    constructor() {
        this.initialize();
    }

    private initialize() {
        const { accessKeyId, secretAccessKey, endpoint, buckets } = config.r2;

        if (!accessKeyId || !secretAccessKey || !endpoint || !buckets.public) {
            console.warn('[StorageService] R2 Credentials not fully configured. Cloud storage will be disabled.');
            return;
        }

        this.s3Client = new S3Client({
            region: 'auto',
            endpoint: endpoint,
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey,
            },
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });
        this.isConfigured = true;
    }

    private getBucketName(type: BucketType): string {
        switch (type) {
            case BucketType.PRIVATE:
                return config.r2.buckets.private;
            case BucketType.FTP:
                return config.r2.buckets.ftp;
            case BucketType.PUBLIC:
            default:
                return config.r2.buckets.public;
        }
    }

    /**
     * Uploads a file to Cloudflare R2
     * @param file The Multer file object or Buffer
     * @param folder The target folder (e.g., 'avatars', 'proofs')
     * @param type The bucket type (public, private, or ftp)
     * @returns The public URL (for public) or the key (for private/ftp)
     */
    async upload(
        file: Express.Multer.File | { buffer: Buffer; originalname: string; mimetype: string },
        folder: string,
        type: BucketType = BucketType.PUBLIC,
        options: UploadOptions = {}
    ): Promise<string> {
        const allowLocalFallback = options.allowLocalFallback ?? true;
        const extension = path.extname(file.originalname).toLowerCase();
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
        const key = `${folder}/${fileName}`;
        const bucketName = this.getBucketName(type);

        if (this.isConfigured && this.s3Client) {
            try {
                const command = new PutObjectCommand({
                    Bucket: bucketName,
                    Key: key,
                    Body: file.buffer,
                    ContentType: file.mimetype,
                });
                await this.s3Client.send(command);

                if (type === BucketType.PUBLIC) {
                    const finalUrl = `${config.r2.publicUrl}/${key}`;
                    console.log(`[StorageService] Generated Public URL: ${finalUrl}`);
                    return finalUrl;
                }
                return key; // For private/ftp, return the key
            } catch (error: any) {
                if (!allowLocalFallback) {
                    throw new Error(`R2 upload failed: ${error.message}`);
                }
                console.warn(`[StorageService] R2 upload to ${bucketName} failed, falling back to local:`, error.message);
            }
        }

        if (!allowLocalFallback) {
            throw new Error('[StorageService] Cloud storage is not configured; local fallback is disabled.');
        }

        return this.saveLocally(file.buffer, folder, fileName);
    }

    private async saveLocally(buffer: Buffer, folder: string, fileName: string): Promise<string> {
        const uploadDir = path.join(__dirname, '../../uploads', folder);
        if (!existsSync(uploadDir)) {
            mkdirSync(uploadDir, { recursive: true });
        }
        const filePath = path.join(uploadDir, fileName);
        await fs.writeFile(filePath, buffer);
        return `/uploads/${folder}/${fileName}`;
    }

    /**
     * Generates a signed URL for a private file
     * @param key The file key in the private bucket
     * @param expiresIn Expiration time in seconds (default 15 mins)
     */
    async getSignedUrl(key: string, expiresIn: number = 900): Promise<string | null> {
        if (!this.isConfigured || !this.s3Client || !key) return null;

        // If it's a local path, return it as is (internal dev)
        if (key.startsWith('/uploads/')) return key;

        try {
            const command = new GetObjectCommand({
                Bucket: config.r2.buckets.private,
                Key: key,
            });
            return await getSignedUrl(this.s3Client, command, { expiresIn });
        } catch (error) {
            console.error('[StorageService] Signed URL Error:', error);
            return null;
        }
    }

    /**
     * Deletes a file from Cloudflare R2 or local disk
     * @param pathOrUrl The full URL, local path, or key
     * @param type The bucket type where the file resides
     */
    async delete(pathOrUrl: string, type: BucketType = BucketType.PUBLIC): Promise<void> {
        if (!pathOrUrl) return;

        // 1. Handle Local Deletion
        if (pathOrUrl.startsWith('/uploads/')) {
            try {
                const fullPath = path.join(__dirname, '../../', pathOrUrl);
                if (existsSync(fullPath)) {
                    await fs.unlink(fullPath);
                }
            } catch (err) {
                console.error('[StorageService] Local Delete Error:', err);
            }
            return;
        }

        // 2. Handle R2 Deletion
        if (!this.isConfigured || !this.s3Client) return;

        let key = pathOrUrl;
        if (pathOrUrl.startsWith('http')) {
            const baseUrl = config.r2.publicUrl;
            if (pathOrUrl.startsWith(baseUrl)) {
                key = pathOrUrl.replace(`${baseUrl}/`, '');
            } else if (!pathOrUrl.includes('r2.cloudflarestorage.com')) {
                // If it's another domain and not a signed URL, skip
                return;
            } else {
                // Handle signed URL key extraction if needed, 
                // but usually we store keys for private files
                return;
            }
        }

        try {
            const command = new DeleteObjectCommand({
                Bucket: this.getBucketName(type),
                Key: key,
            });
            await this.s3Client.send(command);
        } catch (error: any) {
            console.error('[StorageService] R2 Delete Error:', error);
        }
    }

    /**
     * Lists all keys under a prefix in the given bucket. Used to enumerate
     * objects without a database index — e.g. all screenshots for a user/date.
     * Returns the keys as strings (no signed URLs — call getSignedProofUrl per key).
     */
    async list(prefix: string, type: BucketType = BucketType.PRIVATE): Promise<Array<{ key: string; lastModified?: Date }>> {
        if (!this.isConfigured || !this.s3Client) return [];

        const results: Array<{ key: string; lastModified?: Date }> = [];
        let continuationToken: string | undefined;

        do {
            const command = new ListObjectsV2Command({
                Bucket: this.getBucketName(type),
                Prefix: prefix,
                ContinuationToken: continuationToken,
            });
            const response = await this.s3Client.send(command);
            for (const obj of response.Contents ?? []) {
                if (obj.Key) {
                    results.push({ key: obj.Key, lastModified: obj.LastModified });
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        return results;
    }

    /**
     * Streams a private file — works for both local /uploads/ paths and R2 private keys.
     * Used by proxy endpoints to serve private images to authenticated clients.
     */
    async streamPrivateFile(key: string): Promise<{ stream: Readable; contentType: string } | null> {
        if (!key) return null;

        // Local fallback path
        if (key.startsWith('/uploads/')) {
            const fullPath = path.join(__dirname, '../../', key);
            if (!existsSync(fullPath)) return null;
            const ext = path.extname(key).toLowerCase();
            const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
            return { stream: createReadStream(fullPath) as unknown as Readable, contentType };
        }

        if (!this.isConfigured || !this.s3Client) return null;

        try {
            const command = new GetObjectCommand({
                Bucket: config.r2.buckets.private,
                Key: key,
            });
            const response = await this.s3Client.send(command);
            if (!response.Body) return null;
            return {
                stream: response.Body as Readable,
                contentType: response.ContentType || 'image/jpeg',
            };
        } catch (error) {
            console.error('[StorageService] streamPrivateFile error:', error);
            return null;
        }
    }

    /**
     * Extracts the R2 key from a full public URL
     * @param url The full R2 public URL
     * @returns The key (path) within the bucket
     */
    getKeyFromUrl(url: string): string | null {
        if (!url || !url.startsWith('http')) return null;
        const baseUrl = config.r2.publicUrl;
        if (url.startsWith(baseUrl)) {
            return url.replace(`${baseUrl}/`, '');
        }
        return null;
    }
}

export const storageService = new StorageService();
export default storageService;
