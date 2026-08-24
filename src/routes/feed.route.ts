import express, { RequestHandler } from 'express';
import multer from 'multer';
import feedController from '../controllers/feed.controller';
import { addComment, getComments, deleteComment } from '../controllers/feedComment.controller';
import feedNotificationController from '../controllers/feedNotification.controller';
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
  if (!req.is("multipart/form-data")) return next();
  upload.any()(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(400, 'Each attachment must be 25 MB or smaller.'));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return next(new ApiError(400, `You can attach up to ${MAX_FEED_ATTACHMENTS} files.`));
        }
        return next(new ApiError(400, err.message));
      }
      return next(new ApiError(400, err?.message || 'Failed to process attachments.'));
    }

    const allFiles = (req.files as Express.Multer.File[] | undefined) || [];
    const feedFiles = allFiles.filter((f) => f.fieldname === 'files');

    if (feedFiles.length > MAX_FEED_ATTACHMENTS) {
      return next(new ApiError(400, `You can attach up to ${MAX_FEED_ATTACHMENTS} files.`));
    }

    req.files = feedFiles;
    return next();
  });
};

// The upload limiter is meant to throttle file uploads, not every post/comment.
// It must run AFTER parseAttachments so it can see whether files were actually
// attached — otherwise every text-only post/comment burns from the same
// 5-per-10-minutes budget as real uploads.
const limitIfAttachments: RequestHandler = (req, res, next) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (files.length === 0) return next();
  return uploadLimiter(req, res, next);
};

// All feed routes require CRM authentication
router.use(crmAuth());

// ── Notifications, read-state & mentions (STATIC — must stay before /:id) ──
router.get('/notifications/unread-count', feedNotificationController.getUnreadCount);
router.get('/activity', feedNotificationController.listActivity);
router.get('/notifications', feedNotificationController.listNotifications);
router.patch('/notifications/read', feedNotificationController.markNotificationsRead);
router.get('/read-state', feedNotificationController.getReadState);
router.post('/read-state', feedNotificationController.advanceReadState);
router.post('/read-state/posts', feedNotificationController.markPostsRead);
router.get('/mention-candidates', feedNotificationController.getMentionCandidates);

// ── Posts ──
router.get('/', feedController.getPosts);
router.post('/', parseAttachments, limitIfAttachments, feedController.createPost);
router.put('/:id', feedController.updatePost);
router.delete('/:id', feedController.deletePost);

// ── Comments (merged in — same URLs as before: /crm/feeds/:postId/comments) ──
router.post('/:postId/comments', parseAttachments, limitIfAttachments, addComment);
router.get('/:postId/comments', getComments);
router.delete('/:postId/comments/:commentId', deleteComment);

export default router;