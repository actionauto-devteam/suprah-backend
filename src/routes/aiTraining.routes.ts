import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/aiTraining.controller';
import * as lab from '../controllers/aiTrainingLab.controller';
import { trainingLabCheckLimiter, trainingLabWriteLimiter } from '../middleware/trainingLabRateLimit';

const router = express.Router();

router.use(crmAuth());

router.get('/status', ctrl.getTrainingStatus);
router.patch('/settings', ctrl.updateTrainingSettings);
router.get('/proposals', ctrl.listTrainingProposals);
router.post('/proposals', ctrl.createTrainingRule);
router.post('/rules/preview', ctrl.previewTrainingRule);
router.get('/proposals/:id', ctrl.getTrainingProposal);
router.put('/proposals/:id', ctrl.saveTrainingRuleVersion);
router.post('/proposals/:id/submit', ctrl.submitTrainingRule);
router.post('/proposals/:id/withdraw', ctrl.withdrawTrainingProposal);
router.post('/proposals/:id/request-changes', ctrl.requestTrainingChanges);
router.post('/proposals/:id/approve', ctrl.approveTrainingProposal);
router.post('/proposals/:id/reject', ctrl.rejectTrainingProposal);
router.post('/proposals/:id/revise', ctrl.reviseTrainingProposal);
router.get('/evaluations', ctrl.listDraftEvaluations);
router.put('/evaluations/:draftId', ctrl.saveDraftEvaluationHandler);
router.get('/audit', ctrl.listTrainingAudit);
router.get('/lab/status', lab.getLabStatus);
router.get('/lab/scenarios', lab.listScenarios);
router.post('/lab/scenarios/check', trainingLabCheckLimiter, lab.checkScenario);
router.post('/lab/scenarios', trainingLabWriteLimiter, lab.createScenarioHandler);
router.get('/lab/scenarios/:id', lab.getScenario);
router.put('/lab/scenarios/:id', trainingLabWriteLimiter, lab.updateScenarioHandler);
router.post('/lab/scenarios/:id/archive', trainingLabWriteLimiter, lab.archiveScenarioHandler);
router.post('/lab/scenarios/:id/restore', trainingLabWriteLimiter, lab.restoreScenarioHandler);
router.post('/lab/runs', trainingLabWriteLimiter, lab.createRunHandler);
router.post('/lab/runs/batch', trainingLabWriteLimiter, lab.createBatchRunHandler);
router.get('/lab/runs', lab.listRuns);
router.get('/lab/runs/:id', lab.getRun);

export default router;
