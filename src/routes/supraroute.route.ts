import express from 'express';
import multer from 'multer';
import crmAuth from '../middleware/crmAuth.middleware';
import supraLeoController from '../controllers/supraLeo.controller';

const router = express.Router();

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// All routes require CRM authentication
router.use(crmAuth());

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', supraLeoController.getStatus);

// ── Chat (persistent AI conversation) ────────────────────────────────────────
router.post('/chat', supraLeoController.chat);
router.get('/chat/history', supraLeoController.getChatHistory);
router.delete('/chat/history', supraLeoController.clearChatHistory);

// ── Suprah Space AI (summarize + draft reply + refine) ────────────────────────
router.post('/summarize', supraLeoController.summarizeConversation);
router.post('/draft', supraLeoController.draftReply);
router.post('/refine', supraLeoController.refineMessage);

// ── Reminders & Context ───────────────────────────────────────────────────────
router.get('/reminders/:module', supraLeoController.getReminders);
router.get('/context/:module', supraLeoController.getModuleContext);

// ── Meeting / call AI chat (transcript-aware) ─────────────────────────────────
router.post('/meeting-chat', supraLeoController.meetingChat);
router.post('/transcribe-chunk', audioUpload.single('audio'), supraLeoController.transcribeChunk);

// ── TTS / Speech helpers ──────────────────────────────────────────────────────
router.get('/prepare-message/:leadId', supraLeoController.prepareMessage);
router.post('/prepare-thread-message', supraLeoController.prepareThreadMessage);

export default router;