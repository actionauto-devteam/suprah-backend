import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/crmAutomation.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.getAutomations);
router.get('/options', ctrl.getOptions);
router.get('/activity', ctrl.getActivity);
router.get('/syncs', ctrl.getSyncs);
router.post('/syncs', ctrl.postSync);
router.get('/syncs/:id', ctrl.getSync);
router.patch('/syncs/:id', ctrl.patchSync);
router.delete('/syncs/:id', ctrl.removeSync);
router.post('/', ctrl.postAutomation);
router.get('/:id', ctrl.getAutomation);
router.patch('/:id', ctrl.patchAutomation);
router.post('/:id/duplicate', ctrl.postDuplicate);
router.post('/:id/status', ctrl.postStatus);
router.patch('/:id/alerts', ctrl.patchAlerts);
router.delete('/:id', ctrl.removeAutomation);

export default router;
