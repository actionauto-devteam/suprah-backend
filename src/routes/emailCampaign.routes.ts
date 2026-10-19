import express, { RequestHandler } from 'express';
import multer from 'multer';
import crmAuth from '../middleware/crmAuth.middleware';
import { validateUploadedImageContent } from '../middleware/upload.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';
import * as ctrl from '../controllers/emailCampaign.controller';

export const EMAIL_CAMPAIGN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_CAMPAIGN_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const campaignImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: EMAIL_CAMPAIGN_IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_CAMPAIGN_IMAGE_MIME.has(file.mimetype)),
});

const receiveCampaignImage: RequestHandler = (req, res, next) => {
  campaignImageUpload.single('image')(req, res, (err: any) => {
    if (!err) return next();
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, 'Images must be 5 MB or smaller'));
    return next(new ApiError(400, 'The image could not be read. Please try a different file.'));
  });
};

const router = express.Router();

router.use(crmAuth());

router.get('/audience-count', ctrl.getAudienceCount);
router.get('/', ctrl.listCampaigns);
router.post('/', ctrl.createCampaign);
router.post('/images', uploadLimiter, receiveCampaignImage, validateUploadedImageContent, ctrl.uploadCampaignImage);
router.post('/preview', ctrl.previewCampaign);
router.get('/:id', ctrl.getCampaign);
router.post('/:id/cancel', ctrl.cancelCampaign);
router.patch('/:id/reschedule', ctrl.rescheduleCampaign);

export default router;
