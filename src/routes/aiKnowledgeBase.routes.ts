import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { knowledgeBaseWriteLimiter } from '../middleware/knowledgeBaseRateLimit';
import * as ctrl from '../controllers/aiKnowledgeBase.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/status', ctrl.getKnowledgeBaseStatus);
router.patch('/settings', knowledgeBaseWriteLimiter, ctrl.updateKnowledgeBaseSettings);
router.get('/audit', ctrl.getAudit);
router.get('/locations', ctrl.listLocations);
router.get('/entries', ctrl.listEntries);
router.post('/entries', knowledgeBaseWriteLimiter, ctrl.createEntry);
router.get('/entries/:id', ctrl.getEntry);
router.put('/entries/:id', knowledgeBaseWriteLimiter, ctrl.saveEntryVersion);
router.get('/entries/:id/versions', ctrl.listEntryVersions);
router.get('/entries/:id/versions/:version', ctrl.getEntryVersion);
router.get('/entries/:id/audit', ctrl.getEntryAudit);
router.post('/entries/:id/submit', knowledgeBaseWriteLimiter, ctrl.submitEntry);
router.post('/entries/:id/request-changes', knowledgeBaseWriteLimiter, ctrl.requestEntryChanges);
router.post('/entries/:id/approve', knowledgeBaseWriteLimiter, ctrl.approveEntry);
router.post('/entries/:id/reject', knowledgeBaseWriteLimiter, ctrl.rejectEntry);
router.post('/entries/:id/disable', knowledgeBaseWriteLimiter, ctrl.disableEntry);
router.post('/entries/:id/enable', knowledgeBaseWriteLimiter, ctrl.enableEntry);
router.post('/entries/:id/archive', knowledgeBaseWriteLimiter, ctrl.archiveEntry);
router.post('/entries/:id/restore', knowledgeBaseWriteLimiter, ctrl.restoreEntry);
router.get('/verified-details', ctrl.listDetails);
router.post('/verified-details', knowledgeBaseWriteLimiter, ctrl.proposeDetail);
router.get('/verified-details/:id', ctrl.getDetail);
router.put('/verified-details/:id', knowledgeBaseWriteLimiter, ctrl.updateDetail);
router.post('/verified-details/:id/approve', knowledgeBaseWriteLimiter, ctrl.approveDetail);
router.post('/verified-details/:id/reapprove', knowledgeBaseWriteLimiter, ctrl.reapproveDetail);
router.post('/verified-details/:id/revoke', knowledgeBaseWriteLimiter, ctrl.revokeDetail);
router.post('/verified-details/:id/archive', knowledgeBaseWriteLimiter, ctrl.archiveDetail);

export default router;
