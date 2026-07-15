import multer from 'multer';
import path from 'path';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 10;

const allowedExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.pdf',
  '.docx',
  '.doc',
  '.txt',
  '.csv',
  '.xlsx',
  '.xls',
]);

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

export const leadReplyUpload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_ATTACHMENT_COUNT,
  },

  fileFilter: (
    _req,
    file,
    callback,
  ) => {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    const hasAllowedExtension =
      allowedExtensions.has(extension);

    const hasAllowedMimeType =
      allowedMimeTypes.has(file.mimetype);

    if (
      !hasAllowedExtension ||
      !hasAllowedMimeType
    ) {
      callback(
        new Error(
          `Unsupported attachment type: ${file.originalname}`,
        ),
      );
      return;
    }

    callback(null, true);
  },
});

export const uploadLeadReplyAttachments =
  leadReplyUpload.array(
    'attachments',
    MAX_ATTACHMENT_COUNT,
  );