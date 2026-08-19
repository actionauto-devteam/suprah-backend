import express from 'express';
import multer from 'multer';
import mailController from '../controllers/mail.controller';
import crmAuth from '../middleware/crmAuth.middleware';

/**
 * Suprah Mail routes — mounted at /api/mail (see routes/index.ts).
 * Everything below the crmAuth() line requires a CRM session; the OAuth
 * callback is public because Google redirects the browser there (the request
 * is authenticated by the HMAC-signed state instead).
 */

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // Gmail's own hard cap per message
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 10 },
});

const router = express.Router();

// Public — Google redirect target (state-verified).
router.get('/oauth/callback', mailController.oauthCallback);

// Suprah One Desk mail data is private, dynamic account state. Do not let
// browser conditional requests turn a successful JSON GET into HTTP 304 with
// no response body. Axios treats 304 as a rejected request, which was causing
// Next.js development overlays even when the backend considered the request
// successfully handled.
router.use((req, res, next) => {
  res.setHeader(
    'Cache-Control',
    'private, no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];

  next();
});

router.use(crmAuth());

// Connection
router.get('/status',      mailController.getStatus);
router.get('/connect',     mailController.getConnectUrl);
router.post('/disconnect', mailController.disconnect);
router.post('/sync',       mailController.triggerSync);

// Inbox
router.get('/labels',                                mailController.getLabels);
router.get('/mailbox-summary',                       mailController.getMailboxSummary);
router.get('/messages',                              mailController.getMessages);
router.post('/messages/send', attachmentUpload.array('files', 10), mailController.sendMessage);
router.get('/messages/:id',                          mailController.getMessageDetail);
router.patch('/messages/:id',                        mailController.updateMessage);
router.get('/messages/:id/attachments/:attachmentId', mailController.downloadAttachment);
router.get('/threads/:id',                           mailController.getThreadDetail);

// Drafts
router.get('/drafts',                    mailController.getDrafts);
router.get('/drafts/:draftId',           mailController.getDraftDetail);
router.post('/drafts',   attachmentUpload.array('files', 10), mailController.createDraft);
router.patch('/drafts/:draftId', attachmentUpload.array('files', 10), mailController.updateDraft);
router.delete('/drafts/:draftId',        mailController.deleteDraft);
router.post('/drafts/:draftId/send',     mailController.sendDraft);

// Conversations (email-powered chat — direct + group)
router.get('/conversations',                  mailController.getConversations);
router.post('/conversations',                 mailController.createConversation);
router.post('/conversations/:id/participants', mailController.addParticipant);
router.delete('/conversations/:id/participants/:email', mailController.removeParticipant);
router.get('/conversations/:id/messages',     mailController.getConversationMessages);
router.post('/conversations/:id/messages', attachmentUpload.array('files', 10), mailController.sendConversationMessage);
router.post('/conversations/:id/read',        mailController.markConversationRead);
router.patch('/conversations/:id',            mailController.updateConversation);
router.get('/conversations/:id/attachments/:messageId/:index', mailController.downloadConversationAttachment);

export default router;