import express, { RequestHandler } from 'express';
import multer from 'multer';
import supraSpaceController from '../controllers/supraspace.controller';
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';

const router = express.Router();
const SUPRA_SPACE_MAX_UPLOAD_FILES = 5;
const SUPRA_SPACE_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const SUPRA_SPACE_MAX_VIDEO_FILE_SIZE_BYTES = 40 * 1024 * 1024;
const SUPRA_SPACE_VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|avi|mkv|wmv|flv|3gp|mpeg|mpg|ogv)$/i;

// Multer — memory storage; files are uploaded directly to Cloudflare R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SUPRA_SPACE_MAX_VIDEO_FILE_SIZE_BYTES,
    files: SUPRA_SPACE_MAX_UPLOAD_FILES,
  },
});

const uploadFiles: RequestHandler = (req, res, next) => {
  upload.array('files', SUPRA_SPACE_MAX_UPLOAD_FILES)(req, res, (err: any) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(400, 'Each attachment must be 40 MB or smaller.'));
      }

      if (err.code === 'LIMIT_FILE_COUNT') {
        return next(new ApiError(400, `You can attach up to ${SUPRA_SPACE_MAX_UPLOAD_FILES} files.`));
      }

      return next(new ApiError(400, err.message));
    }

    return next(new ApiError(400, err?.message || 'Failed to process uploaded files.'));
  });
};

const validateUploadedFiles: RequestHandler = (req, _res, next) => {
  const files = (req.files || []) as Express.Multer.File[];

  for (const file of files) {
    const isVideo = file.mimetype?.startsWith('video/') || SUPRA_SPACE_VIDEO_EXTENSIONS.test(file.originalname);
    const maxBytes = isVideo ? SUPRA_SPACE_MAX_VIDEO_FILE_SIZE_BYTES : SUPRA_SPACE_MAX_FILE_SIZE_BYTES;

    if (file.size > maxBytes) {
      return next(new ApiError(400, `${file.originalname} exceeds ${isVideo ? '40 MB (video limit)' : '25 MB'}.`));
    }
  }

  return next();
};

// All routes require CRM auth
router.use(crmAuth());

// Users
router.get('/users', supraSpaceController.getCrmUsers);

// Conversations
router.get('/conversations', supraSpaceController.getConversations);
router.post('/conversations/direct', supraSpaceController.getOrCreateDirect);
router.post('/conversations/group', supraSpaceController.createGroup);
router.patch('/conversations/:id', supraSpaceController.updateConversation);

// Messages
router.get('/conversations/:id/messages', supraSpaceController.getMessages);
router.post('/conversations/:id/messages', supraSpaceController.sendMessage);

const uploadMiddlewareChain = [
  uploadLimiter,
  uploadFiles,
  validateUploadedFiles,
  supraSpaceController.uploadAttachment,
] as const;

router.post(
  '/conversations/:id/upload',
  ...uploadMiddlewareChain
);

// Legacy path support
router.post(
  '/:id/upload',
  ...uploadMiddlewareChain
);
router.delete('/messages/:messageId', supraSpaceController.deleteMessage);

export default router;