import multer from 'multer';
import path from 'path';
import { Request } from 'express';
import { ApiError } from '../utils/ApiError';

// Use memory storage for Cloudflare R2 streaming
const storage = multer.memoryStorage();

const imageFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only image files (jpg, jpeg, png, webp) are allowed') as any, false);
  }
};

const avatarFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimeTypes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only image files (jpg, jpeg, png, webp) are allowed for avatars') as any, false);
  }
};

// ========================================
// Exported Middlewares
// ========================================

export const uploadProofImage = multer({
  storage: storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('proof');

export const uploadAvatarImage = multer({
  storage: storage,
  fileFilter: avatarFileFilter,
  limits: { fileSize: 1 * 1024 * 1024 }, // 1 MB max for avatars
}).single('avatar');
