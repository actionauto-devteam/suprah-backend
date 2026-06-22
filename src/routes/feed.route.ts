import express, { RequestHandler } from 'express';
import multer from 'multer';
import feedController from '../controllers/feed.controller';
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';

const router = express.Router();

const MAX_FEED_ATTACHMENTS = 4;
const MAX_FEED_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FEED_ATTACHMENT_SIZE_BYTES,
    files: MAX_FEED_ATTACHMENTS,
  },
});

const parseAttachments: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();

  upload.array('files', MAX_FEED_ATTACHMENTS)(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, 'Each attachment must be 25 MB or smaller.'));
      if (err.code === 'LIMIT_FILE_COUNT') return next(new ApiError(400, `You can attach up to ${MAX_FEED_ATTACHMENTS} files.`));
      return next(new ApiError(400, err.message));
    }
    return next(new ApiError(400, err?.message || 'Failed to process attachments.'));
  });
};

// All feed routes require CRM authentication
router.use(crmAuth());

router.get('/',    feedController.getPosts);
router.post('/',   uploadLimiter, parseAttachments, feedController.createPost);
router.put('/:id', feedController.updatePost);
router.delete('/:id', feedController.deletePost);

export default router;
