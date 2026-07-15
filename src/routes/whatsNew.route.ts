import express from 'express';
import multer from 'multer';
import whatsNewController from '../controllers/whatsNew.controller';
import crmAuth from '../middleware/crmAuth.middleware';

/* Media uploads for What's New posts — images and short product videos.
 * Memory storage + storageService (Cloudflare R2), same pattern as the
 * avatar upload in crm.route.ts. */
const ALLOWED_MEDIA_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — allows short demo videos
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_MEDIA_MIME.has(file.mimetype)),
});

const router = express.Router();

// Every route requires CRM auth. Reads are open to all authenticated users
// (global feed); write routes enforce admin + non-revoked in the controller.
router.use(crmAuth());

/* Static paths MUST be registered before '/:id' param routes. */
router.get('/unread-count', whatsNewController.getUnreadCount);
router.get('/permissions',  whatsNewController.getPermissions);
router.patch('/permissions', whatsNewController.updatePermission);
router.post('/media', mediaUpload.single('media'), whatsNewController.uploadMedia);

router.get('/',  whatsNewController.getReleases);
router.post('/', whatsNewController.createRelease);

router.post('/:id/read', whatsNewController.markReleaseRead);
router.patch('/:id',     whatsNewController.updateRelease);
router.delete('/:id',    whatsNewController.deleteRelease);

export default router;