import { storageService, BucketType } from '../src/services/storage.service';
import config from '../src/config';
import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

describe('Storage Service (R2 Multi-Bucket)', () => {
    const testFile = {
        buffer: Buffer.from('test-content-' + Date.now()),
        originalname: 'test-unit.txt',
        mimetype: 'text/plain'
    };

    // Increase timeout for R2 network calls
    jest.setTimeout(30000);

    it('should upload to public bucket and return a public URL', async () => {
        // Only run if R2 is configured
        if (!(storageService as any).isConfigured) {
            console.warn('Skipping R2 Public Test: R2 not configured');
            return;
        }

        const url = await storageService.upload(testFile, 'test-public', BucketType.PUBLIC);
        expect(url).toContain(config.r2.publicUrl);
        expect(url).toContain('test-public');
        
        // Cleanup
        await storageService.delete(url, BucketType.PUBLIC);
    });

    it('should upload to private bucket and return a key', async () => {
        if (!(storageService as any).isConfigured) {
             console.warn('Skipping R2 Private Test: R2 not configured');
             return;
        }

        const key = await storageService.upload(testFile, 'test-private', BucketType.PRIVATE);
        expect(key).not.toContain('http');
        expect(key).toContain('test-private');
        
        // Generate signed URL
        const signedUrl = await storageService.getSignedUrl(key);
        expect(signedUrl).toContain('http');
        // Signed URLs for R2 often contain the bucket name or endpoint
        expect(signedUrl).toContain(config.r2.buckets.private);

        // Cleanup
        await storageService.delete(key, BucketType.PRIVATE);
    });

    it('should fall back to local storage if R2 is disabled', async () => {
        const originalStatus = (storageService as any).isConfigured;
        (storageService as any).isConfigured = false;
        
        try {
            const localPath = await storageService.upload(testFile, 'test-local');
            expect(localPath).toContain('/uploads/test-local/');
            
            const fullPath = path.join(__dirname, '../', localPath);
            expect(existsSync(fullPath)).toBe(true);

            // Cleanup local file
            await storageService.delete(localPath);
            expect(existsSync(fullPath)).toBe(false);
        } finally {
            (storageService as any).isConfigured = originalStatus;
        }
    });

    it('should handle deletion of legacy local files correctly', async () => {
        // Create a fake local file
        const folder = 'test-legacy';
        const fileName = 'legacy-file.txt';
        const uploadDir = path.join(__dirname, '../uploads', folder);
        if (!existsSync(uploadDir)) {
            await fs.mkdir(uploadDir, { recursive: true });
        }
        const localPath = `/uploads/${folder}/${fileName}`;
        const fullPath = path.join(__dirname, '../', localPath);
        await fs.writeFile(fullPath, 'legacy-content');

        expect(existsSync(fullPath)).toBe(true);

        // Delete using storage service
        await storageService.delete(localPath);
        
        expect(existsSync(fullPath)).toBe(false);
    });
});
