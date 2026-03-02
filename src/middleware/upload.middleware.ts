import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { ApiError } from '../utils/ApiError';

// ========================================
// Proof-of-Delivery Upload
// ========================================
const proofStorage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const shipmentId = req.params.id || 'unknown';
    const dir = path.join(__dirname, '../../uploads/proof-of-delivery', shipmentId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}${ext}`);
  },
});

const imageFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only image files (jpg, jpeg, png, webp) are allowed') as any, false);
  }
};

export const uploadProofImage = multer({
  storage: proofStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('proof');

// ========================================
// Avatar Upload
// ========================================
const avatarDir = path.join(__dirname, '../../uploads/avatars');
fs.mkdirSync(avatarDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req: Request, _file, cb) => {
    cb(null, avatarDir);
  },
  filename: (req: Request, file, cb) => {
    const userId = (req as any).user?._id || 'unknown';
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    // Use userId + timestamp to ensure unique & traceable filenames
    cb(null, `${userId}-${Date.now()}${ext}`);
  },
});

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

export const uploadAvatarImage = multer({
  storage: avatarStorage,
  fileFilter: avatarFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max for avatars
}).single('avatar');
