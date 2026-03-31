import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import supraLeoController from '../controllers/supraLeo.controller';

const router = express.Router();

// All routes require CRM authentication
router.use(crmAuth());

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', supraLeoController.getStatus);

// ── Chat (persistent AI conversation) ────────────────────────────────────────
router.post('/chat', supraLeoController.chat);
router.get('/chat/history', supraLeoController.getChatHistory);
router.delete('/chat/history', supraLeoController.clearChatHistory);

// ── Reminders & Context ───────────────────────────────────────────────────────
router.get('/reminders/:module', supraLeoController.getReminders);
router.get('/context/:module', supraLeoController.getModuleContext);

// ── TTS / Speech helpers ──────────────────────────────────────────────────────
router.get('/prepare-message/:leadId', supraLeoController.prepareMessage);
router.post('/prepare-thread-message', supraLeoController.prepareThreadMessage);

export default router;