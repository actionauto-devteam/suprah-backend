import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/crmReports.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/overview', ctrl.getCrmReportsOverview);
router.get('/salespeople', ctrl.getCrmSalespeopleReport);

export default router;
