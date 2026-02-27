import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { ApiError } from '../utils/ApiError';

const storage = multer.diskStorage({
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

const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only image files (jpg, jpeg, png, webp) are allowed') as any, false);
  }
};

export const uploadProofImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('proof');
