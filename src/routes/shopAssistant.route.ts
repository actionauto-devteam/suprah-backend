import express from 'express';
import shopAssistantController from '../controllers/shopAssistant.controller';

const router = express.Router();


router.post('/chat', shopAssistantController.chat);
router.get('/session', shopAssistantController.getSession);
router.delete('/session', shopAssistantController.resetSession);

export default router;