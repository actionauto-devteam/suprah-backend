import multer from 'multer';
import path from 'path';

export const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const allowedExtensions = new Set(['.csv']);
const allowedMimeTypes = new Set(['text/csv', 'application/vnd.ms-excel', 'application/csv', 'text/plain']);

const marketingContactImportUpload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_IMPORT_FILE_SIZE_BYTES,
    files: 1,
  },

  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(extension) || !allowedMimeTypes.has(file.mimetype)) {
      callback(new Error('Only .csv files are accepted for Marketing Contacts import'));
      return;
    }
    callback(null, true);
  },
});

export const uploadMarketingContactCsv = marketingContactImportUpload.single('file');
