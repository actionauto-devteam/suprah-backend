import multer from 'multer';
import path from 'path';
import { Request, NextFunction, RequestHandler } from 'express';
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
  limits: { fileSize: 25 * 1024 * 1024 },
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

const startsWithBytes = (buffer: Buffer, bytes: number[]) =>
  buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

const hasAllowedMagicBytes = (file: Express.Multer.File): boolean => {
  const buffer = file.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;

  switch (file.mimetype) {
    case 'image/jpeg':
      return startsWithBytes(buffer, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    default:
      return false;
  }
};

const validateFilesByMagicBytes = (
  files: Express.Multer.File[],
  next: NextFunction,
) => {
  const invalid = files.find((file) => !hasAllowedMagicBytes(file));
  if (invalid) {
    return next(
      new ApiError(
        400,
        `The contents of ${invalid.originalname || 'the uploaded file'} do not match its declared file type`,
      ),
    );
  }
  return next();
};

export const validateUploadedImageContent: RequestHandler = (req, _res, next) => {
  const file = req.file;
  if (!file) return next();
  return validateFilesByMagicBytes([file], next);
};

export const validateDriverDocumentContent: RequestHandler = (req, _res, next) => {
  const file = req.file;
  if (!file) return next();
  return validateFilesByMagicBytes([file], next);
};

export const validateDriverStatusRequestAttachmentContent: RequestHandler = (
  req,
  _res,
  next,
) => {
  const files = (req.files || []) as Express.Multer.File[];
  if (!files.length) return next();
  return validateFilesByMagicBytes(files, next);
};