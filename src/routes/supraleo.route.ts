import express from 'express';
import supraleoController from '../controllers/supraLeo.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// All Supra Leo routes require authentication
router.use(auth());
router.use(requireOrg);

// AI status & capabilities
router.get('/status', supraleoController.getStatus);

// Message preparation for TTS
router.get('/prepare-message/:leadId', supraleoController.prepareMessage);
router.post('/prepare-thread-message', supraleoController.prepareThreadMessage);

export default router;