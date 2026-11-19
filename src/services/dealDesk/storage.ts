/**
 * Deal document storage — wired to src/services/storage.service.ts.
 *
 * Deal documents (credit apps, IDs, pay stubs) are always:
 *   - in the PRIVATE R2 bucket (never the public one)
 *   - cloud-only: allowLocalFallback is OFF, so customer PII is never written
 *     to the API server's disk if R2 is down — the upload fails loudly instead
 *   - streamed back only through the authenticated Deal Desk API
 */
import crypto from 'crypto';
import { Readable } from 'stream';
import { storageService, BucketType } from '../storage.service';

/** Folder inside the private bucket for one deal. */
export function dealFolder(orgId: string, dealId: string): string {
  return `deal-desk/${orgId}/${dealId}`;
}

/** Safe, unique file name (letters, numbers, dot, dash, underscore only). */
export function dealFileName(originalName: string): string {
  const ext = (originalName.match(/\.[a-z0-9]{1,5}$/i)?.[0] || '').toLowerCase();
  const base = originalName.replace(/\.[^.]*$/, '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'file';
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${base}${ext}`;
}

/** Uploads to the private bucket and returns the R2 key to store on the deal. */
export async function putDealFile(orgId: string, dealId: string, file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<string> {
  return storageService.upload(
    { buffer: file.buffer, originalname: dealFileName(file.originalname), mimetype: file.mimetype },
    dealFolder(orgId, dealId),
    BucketType.PRIVATE,
    { allowLocalFallback: false, preserveFilename: true },
  );
}

export async function getDealFileStream(key: string): Promise<{ stream: Readable; contentType?: string } | null> {
  const res = await storageService.streamPrivateFile(key);
  return res ? { stream: res.stream, contentType: res.contentType } : null;
}

export async function getDealFileBuffer(key: string, maxBytes = 12 * 1024 * 1024): Promise<Buffer> {
  const res = await getDealFileStream(key);
  if (!res) throw new Error('Document not found in storage');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      res.stream.destroy();
      throw new Error('File too large for AI extraction');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export async function deleteDealFile(key: string): Promise<void> {
  await storageService.delete(key, BucketType.PRIVATE);
}
