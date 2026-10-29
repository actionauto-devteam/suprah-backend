import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/leadIntake.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/control', ctrl.getIntakeControl);
router.put('/control', ctrl.updateIntakeControl);
router.get('/reviews', ctrl.getLeadReviews);
router.get('/reviews/count', ctrl.getLeadReviewCount);
router.post('/reviews/:inquiryId/resolve', ctrl.resolveReview);
router.get('/leads/:leadId/active-lead', ctrl.getActiveLead);
router.post('/leads/:leadId/link', ctrl.linkLead);
router.post('/leads/:leadId/fresh-lead', ctrl.startFreshLead);
router.get('/duplicates', ctrl.getDuplicateLeads);
router.post('/leads/:leadId/undo-combine', ctrl.undoCombine);

export default router;
