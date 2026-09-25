import mongoose from 'mongoose';
import { Readable } from 'stream';

const BUCKET_NAME = 'crm-avatar-images';

function getBucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection is unavailable');
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
}

export function isCrmAvatarId(value: string): boolean {
  return mongoose.mongo.ObjectId.isValid(value);
}

export async function uploadCrmAvatar(file: Express.Multer.File): Promise<string> {
  const upload = getBucket().openUploadStream(file.originalname || 'avatar', {
    contentType: file.mimetype,
  });

  await new Promise<void>((resolve, reject) => {
    upload.once('finish', resolve);
    upload.once('error', reject);
    Readable.from(file.buffer).pipe(upload);
  });

  return upload.id.toHexString();
}

export async function streamCrmAvatar(id: string): Promise<{ stream: Readable; contentType: string } | null> {
  if (!isCrmAvatarId(id)) return null;
  const fileId = new mongoose.mongo.ObjectId(id);
  const bucket = getBucket();
  const file = await bucket.find({ _id: fileId }).next();
  if (!file) return null;
  return {
    stream: bucket.openDownloadStream(fileId) as unknown as Readable,
    contentType: file.contentType || 'application/octet-stream',
  };
}

export async function deleteCrmAvatar(id: string): Promise<void> {
  if (!isCrmAvatarId(id)) return;
  await getBucket().delete(new mongoose.mongo.ObjectId(id));
}
