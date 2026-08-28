import express from 'express';
import employeeOfMonthController from '../controllers/employeeOfMonth.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

router.use(crmAuth());

router.get('/', employeeOfMonthController.getCurrent);
router.get('/candidates', employeeOfMonthController.getCandidates);
router.put('/', employeeOfMonthController.setWinner);

export default router;
