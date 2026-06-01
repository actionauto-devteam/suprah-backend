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
import auth from '../middleware/auth.middleware';   
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

// ─── Customer-facing routes ───────────────────────────────────────────────────
// Protected by the standard auth() middleware — the exact same one used in
// aftermarket.route.ts. It populates req.user and req.orgId so the controller
// can call resolveCustomerOrg(req) without any additional setup.

router.get('/init',     auth(), initConcernConversation);
router.get('/messages', auth(), customerGetMessages);
router.post('/messages', auth(), customerSendMessage);
router.post('/upload',  auth(), uploadLimiter, uploadFiles, customerUploadAttachment);

// ─── CRM staff routes ─────────────────────────────────────────────────────────
// Protected by crmAuth() — same as supraspace.route.ts.

router.get('/crm/conversations',                           crmAuth(), crmListConcernConversations);
router.get('/crm/conversations/:conversationId/messages',  crmAuth(), crmGetConcernMessages);
router.post('/crm/conversations/:conversationId/reply',    crmAuth(), crmReplyConcern);
router.patch('/crm/conversations/:conversationId/resolve', crmAuth(), crmResolveConcern);

export default router;