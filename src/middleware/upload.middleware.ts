import multer from 'multer';
import path from 'path';
import { Request } from 'express';
import { ApiError } from '../utils/ApiError';

const storage = multer.memoryStorage();

const imageFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png'];
  const allowedExts = ['.jpg', '.jpeg', '.png', '.img'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimeTypes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only image files (jpg, jpeg, png) are allowed') as any, false);
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


export const uploadProofImage = multer({
  storage: storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 },
}).single('proof');

export const uploadAvatarImage = multer({
  storage: storage,
  fileFilter: avatarFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('avatar');

export const uploadVehicleImage = multer({
  storage: storage,
  fileFilter: avatarFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 },
}).single('image');

export const uploadListingPhoto = multer({
  storage: storage,
  fileFilter: avatarFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 },
}).single('photo');

const driverDocumentFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
  ];
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimeTypes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only images (jpg, png, webp) and PDF files are allowed') as any, false);
  }
};

export const uploadDriverDocument = multer({
  storage: storage,
  fileFilter: driverDocumentFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('document');

export const uploadScreenshot = multer({
  storage: storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('screenshot');

// Optional evidence for Driver Dispatch Status change requests.
// Kept separate from permanent compliance documents so request evidence has
// its own lifecycle and can safely allow multiple files without changing the
// existing /driver-profile/documents behavior.
export const uploadDriverStatusRequestAttachments = multer({
  storage: storage,
  fileFilter: driverDocumentFilter,
  limits: {
    files: 5,
    fileSize: 10 * 1024 * 1024,
  },
}).array('attachments', 5);