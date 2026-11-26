import multer from 'multer';
import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { MAX_TEXT_FILES, MAX_TEXT_FILE_BYTES, TEXT_FILE_TYPES } from '../services/textMedia.service';

const TYPE_MESSAGE = 'Only photos (JPG, PNG, GIF, WEBP) and PDF files can be sent by text.';

const textFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TEXT_FILE_BYTES, files: MAX_TEXT_FILES },
  fileFilter: (_req, file, callback) => {
    if (TEXT_FILE_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      callback(null, true);
      return;
    }
    callback(new ApiError(400, TYPE_MESSAGE));
  },
}).array('files', MAX_TEXT_FILES);

export function uploadTextFiles(req: Request, res: Response, next: NextFunction) {
  textFileUpload(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Each file must be 5 MB or less.'
        : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE'
          ? `You can send up to ${MAX_TEXT_FILES} files in one text.`
          : 'The files could not be read. Please try again.';
      next(new ApiError(400, message));
      return;
    }
    next(error);
  });
}
