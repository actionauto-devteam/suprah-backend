import express, { RequestHandler } from 'express';
import multer from 'multer';
import {
  initConcernConversation,
  customerSendMessage,
  customerUploadAttachment,
  customerGetMessages,
  crmListConcernConversations,
  crmGetConcernMessages,
  crmReplyConcern,
  crmResolveConcern,
} from '../controllers/customerConcern.controller';
import customerAuth from '../middleware/auth.middleware'; 
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';

const router = express.Router();

const MAX_FILES = 5;
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: MAX_FILES },
});

const uploadFiles: RequestHandler = (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return next(new ApiError(400, 'Each file must be 25 MB or smaller.'));
      if (err.code === 'LIMIT_FILE_COUNT')
        return next(new ApiError(400, `You can attach up to ${MAX_FILES} files.`));
      return next(new ApiError(400, err.message));
    }
    return next(new ApiError(400, err?.message || 'File processing failed.'));
  });
};

// ─── Customer-facing routes ─────────────────────────────────────────────────

router.get('/init', customerAuth(), initConcernConversation);
router.get('/messages', customerAuth(), customerGetMessages);
router.post('/messages', customerAuth(), customerSendMessage);
router.post(
  '/upload',
  customerAuth(),
  uploadLimiter,
  uploadFiles,
  customerUploadAttachment
);

// ─── CRM staff routes ───────────────────────────────────────────────────────

router.get('/crm/conversations', crmAuth(), crmListConcernConversations);
router.get('/crm/conversations/:conversationId/messages', crmAuth(), crmGetConcernMessages);
router.post('/crm/conversations/:conversationId/reply', crmAuth(), crmReplyConcern);
router.patch('/crm/conversations/:conversationId/resolve', crmAuth(), crmResolveConcern);

export default router;