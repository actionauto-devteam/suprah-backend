import express from 'express';
import auth from '../middleware/auth.middleware';
import orgLeadController from '../controllers/orgLead.controller';

const router = express.Router();

router.get('/callback', orgLeadController.handleCallback);

router.use(auth());

router.get('/auth', orgLeadController.initiateAuth);
router.get('/config', orgLeadController.getConfig);
router.patch('/config', orgLeadController.updateConfig);
router.post('/config/secret', orgLeadController.generateSecret);
router.post('/sync', orgLeadController.sync);
router.post('/disconnect', orgLeadController.disconnect);

export default router;
