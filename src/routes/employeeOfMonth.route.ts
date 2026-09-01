import express from 'express';
import employeeOfMonthController from '../controllers/employeeOfMonth.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

router.use(crmAuth());

router.get('/teams', employeeOfMonthController.listTeams);
router.post('/teams', employeeOfMonthController.createTeam);
router.put('/teams/:teamId', employeeOfMonthController.updateTeam);

router.get('/', employeeOfMonthController.getCurrent);
router.get('/candidates', employeeOfMonthController.getCandidates);
router.put('/', employeeOfMonthController.setWinner);
router.delete('/teams/:teamId/winner', employeeOfMonthController.clearWinner);

router.get('/history', employeeOfMonthController.getHistory);
router.delete('/history/:id', employeeOfMonthController.deleteHistoryEntry);
router.get('/stats', employeeOfMonthController.getStats);

router.get('/nominations', employeeOfMonthController.listNominations);
router.post('/nominations', employeeOfMonthController.createNomination);
router.delete('/nominations/:id', employeeOfMonthController.dismissNomination);

router.get('/winners/:winnerId/kudos', employeeOfMonthController.getKudos);
router.put('/winners/:winnerId/kudos', employeeOfMonthController.putKudos);
router.delete('/winners/:winnerId/kudos', employeeOfMonthController.deleteKudos);

export default router;
