import multer from 'multer';

const storage = multer.memoryStorage();

const ALLOWED_FILE = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]);

const ALLOWED_MEDIA = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (file.fieldname === 'media') {
    if (ALLOWED_MEDIA.has(file.mimetype)) return cb(null, true);
    return cb(new Error('Media must be an image (jpg, png, webp, gif) or video (mp4, webm, mov).'));
  }
  if (file.fieldname === 'file') {
    if (ALLOWED_FILE.has(file.mimetype)) return cb(null, true);
    return cb(new Error('File attachment must be a PDF, Word, Excel, CSV, or text document.'));
  }
  return cb(new Error(`Unexpected field: ${file.fieldname}`));
};

export const aftermarketUpload = multer({
  storage,
  fileFilter,
  limits: {
    // Video can be large; cap at 100MB. Tune to your R2 plan.
    fileSize: 100 * 1024 * 1024,
  },
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'media', maxCount: 1 },
]);

export default aftermarketUpload;