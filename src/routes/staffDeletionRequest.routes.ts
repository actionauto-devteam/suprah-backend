import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import auth from '../middleware/auth.middleware';
import { ApiError } from '../utils/ApiError';
import { SUPPORT_EMAIL } from '../utils/userMessages';
import controller from '../controllers/staffDeletionRequest.controller';

const router = express.Router();

// Each new request notifies the dealership's admins, so sending, cancelling
// and sending again can't flood them (2026-11-12).
export const staffDeletionRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => req.user?._id?.toString() ?? ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
        success: false,
        message: `You've sent several deletion requests in the last hour. Wait a while, then try again. If this keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`,
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
});

router.use(auth());

router.get('/mine', controller.mine);
router.post('/', staffDeletionRequestLimiter, controller.create);
router.delete('/mine', controller.cancel);
router.get('/', controller.list);
router.post('/:id/approve', controller.approve);
router.post('/:id/reject', controller.reject);

export default router;
