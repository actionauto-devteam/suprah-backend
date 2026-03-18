import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';
import { ApiError } from '../utils/ApiError';
import path from 'path';

class StorageService {
    private s3Client: S3Client | null = null;
    private isConfigured: boolean = false;

    constructor() {
        this.initialize();
    }

    private initialize() {
        const { accessKeyId, secretAccessKey, endpoint, bucketName } = config.r2;

        if (!accessKeyId || !secretAccessKey || !endpoint || !bucketName) {
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
        });
        this.isConfigured = true;
    }

    /**
     * Uploads a file to Cloudflare R2
     * @param file The Multer file object
     * @param folder The target folder (e.g., 'avatars', 'proofs')
     * @returns The public URL of the uploaded file
     */
    async upload(file: Express.Multer.File, folder: string): Promise<string> {
        if (!this.isConfigured || !this.s3Client) {
            throw new ApiError(503, 'Cloud storage is not configured. Please contact the administrator.');
        }

        const extension = path.extname(file.originalname).toLowerCase();
        const fileName = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;

        try {
            const command = new PutObjectCommand({
                Bucket: config.r2.bucketName,
                Key: fileName,
                Body: file.buffer,
                ContentType: file.mimetype,
            });

            await this.s3Client.send(command);

            // Return the full public URL
            return `${config.r2.publicUrl}/${fileName}`;
        } catch (error: any) {
            console.error('[StorageService] Upload Error:', error);
            throw new ApiError(500, `Failed to upload file to cloud storage: ${error.message}`);
        }
    }

    /**
     * Deletes a file from Cloudflare R2
     * @param urlOrKey The full URL or just the key of the file to delete
     */
    async delete(urlOrKey: string): Promise<void> {
        if (!this.isConfigured || !this.s3Client || !urlOrKey) return;

        // Extract key if a full URL was provided
        let key = urlOrKey;
        if (urlOrKey.startsWith('http')) {
            const baseUrl = config.r2.publicUrl;
            if (urlOrKey.startsWith(baseUrl)) {
                key = urlOrKey.replace(`${baseUrl}/`, '');
            } else {
                // If it's another domain, it's not our file or it's incorrectly formatted
                return;
            }
        }

        try {
            const command = new DeleteObjectCommand({
                Bucket: config.r2.bucketName,
                Key: key,
            });

            await this.s3Client.send(command);
        } catch (error: any) {
            console.error('[StorageService] Delete Error:', error);
            // We don't throw here to prevent blocking the main operation if delete fails
        }
    }

    /**
     * Extracts the key from an R2 URL
     */
    getKeyFromUrl(url: string): string | null {
        const baseUrl = config.r2.publicUrl;
        if (url.startsWith(baseUrl)) {
            return url.replace(`${baseUrl}/`, '');
        }
        return null;
    }
}

export const storageService = new StorageService();
export default storageService;
