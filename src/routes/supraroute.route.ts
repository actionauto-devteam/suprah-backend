import express from 'express';
import multer from 'multer';
import crmAuth from '../middleware/crmAuth.middleware';
import supraLeoController from '../controllers/supraLeo.controller';

const router = express.Router();

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.use(crmAuth());

router.get('/status', supraLeoController.getStatus);

router.post('/chat', supraLeoController.chat);
router.get('/chat/history', supraLeoController.getChatHistory);
router.delete('/chat/history', supraLeoController.clearChatHistory);

router.post('/summarize', supraLeoController.summarizeConversation);
router.post('/draft', supraLeoController.draftReply);
router.post('/refine', supraLeoController.refineMessage);

router.get('/reminders/:module', supraLeoController.getReminders);
router.get('/context/:module', supraLeoController.getModuleContext);

router.post('/meeting-chat', supraLeoController.meetingChat);
router.post('/transcribe-chunk', audioUpload.single('audio'), supraLeoController.transcribeChunk);

router.get('/prepare-message/:leadId', supraLeoController.prepareMessage);
router.post('/prepare-thread-message', supraLeoController.prepareThreadMessage);

export default router;