import express from 'express';
import multer from 'multer';
import supraSpaceController from '../controllers/supraspace.controller';
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';

const router = express.Router();

// Multer — memory storage; files are uploaded directly to Cloudflare R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB per file
    files: 5,                    // max 5 files per request
  },
  fileFilter: (_req, file, cb) => {
    // Allow images and common document types
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/csv',
      'application/zip',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  },
});

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
  upload.array('files', 5),
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