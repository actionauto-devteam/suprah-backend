import express from 'express';
import shopAssistantController from '../controllers/shopAssistant.controller';
// If you have a "soft auth" middleware that attaches req.user when a customer
// token is present but doesn't reject anonymous requests, plug it in here so
// member pricing kicks in for logged-in shoppers. Omit it and this still works anonymously.
// import { softCustomerAuth } from '../middleware/customerAuth.middleware';

const router = express.Router();

// router.use(softCustomerAuth());

router.post('/chat', shopAssistantController.chat);
router.get('/session', shopAssistantController.getSession);
router.delete('/session', shopAssistantController.resetSession);

export default router;