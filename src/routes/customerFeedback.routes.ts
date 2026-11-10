import express from 'express';
import { customerFeedbackLimiter } from '../middleware/rate-limit.middleware';
import { getPublicFeedbackHandler, submitPublicFeedbackHandler } from '../controllers/customerFeedback.controller';

const router = express.Router();

router.get('/:token', customerFeedbackLimiter, getPublicFeedbackHandler);
router.post('/:token', customerFeedbackLimiter, submitPublicFeedbackHandler);

export default router;
