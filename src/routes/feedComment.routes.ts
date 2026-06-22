import { Router, RequestHandler } from 'express';
import multer from 'multer';
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';
import { addComment, getComments, deleteComment } from '../controllers/feedComment.controller';

const router = Router();

const MAX_COMMENT_ATTACHMENTS = 4;
const MAX_COMMENT_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_COMMENT_ATTACHMENT_SIZE_BYTES,
    files: MAX_COMMENT_ATTACHMENTS,
  },
});

const parseAttachments: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();

  upload.array('files', MAX_COMMENT_ATTACHMENTS)(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, 'Each attachment must be 25 MB or smaller.'));
      if (err.code === 'LIMIT_FILE_COUNT') return next(new ApiError(400, `You can attach up to ${MAX_COMMENT_ATTACHMENTS} files.`));
      return next(new ApiError(400, err.message));
    }
    return next(new ApiError(400, err?.message || 'Failed to process attachments.'));
  });
};

router.use(crmAuth());

router.post('/:postId/comments',              uploadLimiter, parseAttachments, addComment);
router.get('/:postId/comments',               getComments);
router.delete('/:postId/comments/:commentId', deleteComment);

export default router;
