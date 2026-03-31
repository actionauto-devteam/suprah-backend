import express from 'express';
import auth from '../middleware/auth.middleware';
import orgLeadController from '../controllers/orgLead.controller';

const router = express.Router();

/**
 * Public Callback (Google redirects here)
 * Note: auth() is not applied here because Google doesn't send our Bearer token.
 * Identification is handled via the 'state' parameter (orgId).
 */
router.get('/callback', orgLeadController.handleCallback);

// --- Protected Routes ---
router.use(auth());

router.get('/auth', orgLeadController.initiateAuth);
router.get('/config', orgLeadController.getConfig);
router.patch('/config', orgLeadController.updateConfig);
router.post('/config/secret', orgLeadController.generateSecret);
router.post('/sync', orgLeadController.sync);
router.post('/disconnect', orgLeadController.disconnect);

export default router;
