import express from 'express';
<<<<<<< HEAD
import supraleoController from '../controllers/supra.Leo.controller';
=======
import supraleoController from '../controllers/supraleo.controller';
>>>>>>> bdb5ed52768b8b4dcefdacb9fcd48ff7e4084da3
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// All Supra Leo routes require authentication
router.use(auth());
router.use(requireOrg);

// AI status & capabilities
router.get('/status', supraleoController.getStatus);

// Message preparation for TTS!!
router.get('/prepare-message/:leadId', supraleoController.prepareMessage);
router.post('/prepare-thread-message', supraleoController.prepareThreadMessage);

export default router;