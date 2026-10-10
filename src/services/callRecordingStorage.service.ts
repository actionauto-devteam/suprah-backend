import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { isLocalUiAcceptanceMode } from '../utils/aiOutboundSafety';

function client() {
  if (isLocalUiAcceptanceMode()) throw new Error('[LOCAL_UI_ACCEPTANCE_MODE] Blocked access to call-recording storage (R2).');

  const config = require('../config').default as typeof import('../config').default;
  const { endpoint, accessKeyId, secretAccessKey, buckets } = config.r2;
  if (!endpoint || !accessKeyId || !secretAccessKey || !buckets.private) throw new Error('Private recording storage is unavailable');
  if (buckets.private === buckets.public) throw new Error('Recordings require a separate private bucket');
  return { s3: new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }), bucket: buckets.private };
}

export function validateRecordingUrl(value: string): URL {
  const url = new URL(value);
  const allowed = url.hostname === 's3.amazonaws.com' || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) || /^[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) throw new Error('Untrusted provider recording URL');
  return url;
}

export async function importRecordingFile(url: string, key: string) {
  if (isLocalUiAcceptanceMode()) throw new Error('[LOCAL_UI_ACCEPTANCE_MODE] Blocked call-recording import.');

  validateRecordingUrl(url);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error(`Recording download failed (${response.status})`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body as any) {
    bytes += chunk.length;
    if (bytes > 128 * 1024 * 1024) throw new Error('Recording file exceeds 128 MB');
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  if (!body.length) throw new Error('Empty recording file');
  const { s3, bucket } = client();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'audio/mpeg', CacheControl: 'no-store' }));
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentLength !== bytes) throw new Error('Recording upload verification failed');
  return { bytes, checksum: createHash('sha256').update(body).digest('hex') };
}

export async function streamRecordingFile(key: string, range?: string) {
  if (!key.startsWith('call-recordings/')) throw new Error('Invalid recording key');
  if (range && !/^bytes=\d+-\d*$/.test(range)) throw new Error('Invalid byte range');
  const { s3, bucket } = client();
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
  return { stream: response.Body as Readable, length: response.ContentLength, range: response.ContentRange, type: response.ContentType || 'audio/mpeg' };
}

export async function deleteRecordingFile(key: string) {
  if (!key.startsWith('call-recordings/')) throw new Error('Invalid recording key');
  const { s3, bucket } = client();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
