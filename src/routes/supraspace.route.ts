import express, { RequestHandler } from 'express';
import multer from 'multer';
import supraSpaceController from '../controllers/supraspace.controller';
import crmAuth from '../middleware/crmAuth.middleware';
import mainAuth from '../middleware/auth.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';

const router = express.Router();

const SUPRA_SPACE_MAX_UPLOAD_FILES = 5;
const SUPRA_SPACE_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const SUPRA_SPACE_MAX_VIDEO_FILE_SIZE_BYTES = 40 * 1024 * 1024;
const SUPRA_SPACE_VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|avi|mkv|wmv|flv|3gp|mpeg|mpg|ogv)$/i;

// ─── Multer: general file upload ─────────────────────────────────────────────

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
      if (err.code === 'LIMIT_FILE_SIZE')
        return next(new ApiError(400, 'Each attachment must be 40 MB or smaller.'));
      if (err.code === 'LIMIT_FILE_COUNT')
        return next(new ApiError(400, `You can attach up to ${SUPRA_SPACE_MAX_UPLOAD_FILES} files.`));
      return next(new ApiError(400, err.message));
    }
    return next(new ApiError(400, err?.message || 'Failed to process uploaded files.'));
  });
};

// ─── Multer: channel avatar (single image, field name 'avatar') ──────────────

const uploadAvatarImage: RequestHandler = (req, res, next) => {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  }).single('avatar')(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(400, 'Channel photo must be 8 MB or smaller.'));
    }
    return next(new ApiError(400, err?.message || 'Failed to process the image.'));
  });
};

// ─── Per-file size validation (video vs. non-video) ──────────────────────────

const validateUploadedFiles: RequestHandler = (req, _res, next) => {
  const files = (req.files || []) as Express.Multer.File[];
  for (const file of files) {
    const isVideo =
      file.mimetype?.startsWith('video/') ||
      SUPRA_SPACE_VIDEO_EXTENSIONS.test(file.originalname);
    const maxBytes = isVideo
      ? SUPRA_SPACE_MAX_VIDEO_FILE_SIZE_BYTES
      : SUPRA_SPACE_MAX_FILE_SIZE_BYTES;
    if (file.size > maxBytes) {
      return next(
        new ApiError(
          400,
          `${file.originalname} exceeds ${isVideo ? '40 MB (video limit)' : '25 MB'}.`
        )
      );
    }
  }
  return next();
};

// ─── Auth gate (all SupraSpace routes require CRM login) ─────────────────────

router.use(crmAuth());

// ─── Users / presence ────────────────────────────────────────────────────────

router.get('/users',  supraSpaceController.getCrmUsers);
router.get('/active', supraSpaceController.getActiveUsers);

// ─── Global message search ───────────────────────────────────────────────────

router.get('/search', supraSpaceController.searchMessages);

// ─── Conversations ────────────────────────────────────────────────────────────

router.get('/conversations',                supraSpaceController.getConversations);
router.post('/conversations/direct',        supraSpaceController.getOrCreateDirect);
router.post('/conversations/group',         supraSpaceController.createGroup);
router.patch('/conversations/:id',          supraSpaceController.updateConversation);
router.post('/conversations/:id/avatar',    uploadAvatarImage, supraSpaceController.updateAvatar);
router.delete('/conversations/:id',         supraSpaceController.deleteConversation);
router.post('/conversations/:id/archive',   supraSpaceController.archiveConversation);
router.post('/conversations/:id/pin',       supraSpaceController.pinConversation);
router.patch('/conversations/:id/theme',    supraSpaceController.setTheme);

// ─── Messages ─────────────────────────────────────────────────────────────────

router.get('/conversations/:id/messages',   supraSpaceController.getMessages);
router.get('/conversations/:id/search',     supraSpaceController.searchInConversation);
router.post('/conversations/:id/messages',  supraSpaceController.sendMessage);
router.post('/messages/:messageId/react',   supraSpaceController.reactToMessage);
router.patch('/messages/:messageId',        supraSpaceController.editMessage);
router.delete('/messages/:messageId',       supraSpaceController.deleteMessage);

// ─── Polls & events ───────────────────────────────────────────────────────────

router.post('/conversations/:id/poll',          supraSpaceController.createPoll);
router.post('/messages/:messageId/poll/vote',   supraSpaceController.votePoll);
router.post('/conversations/:id/event',         supraSpaceController.createEvent);
router.post('/messages/:messageId/event/rsvp',  supraSpaceController.rsvpEvent);

// ─── Spaces ───────────────────────────────────────────────────────────────────

router.get('/spaces',                              supraSpaceController.getSpaces);
router.post('/spaces',                             supraSpaceController.createSpace);
router.patch('/spaces/:id',                        supraSpaceController.updateSpace);
router.delete('/spaces/:id',                       supraSpaceController.deleteSpace);
router.patch('/conversations/:id/space',           supraSpaceController.moveConversationToSpace);

// ─── Video conferencing ───────────────────────────────────────────────────────

router.post('/conversations/:id/video-token', supraSpaceController.generateVideoToken);

// ─── File / voice uploads ─────────────────────────────────────────────────────

const uploadMiddlewareChain = [
  uploadLimiter,
  uploadFiles,
  validateUploadedFiles,
  supraSpaceController.uploadAttachment,
] as const;

router.post('/conversations/:id/upload', ...uploadMiddlewareChain);
router.post('/:id/upload',               ...uploadMiddlewareChain); 

export default router;