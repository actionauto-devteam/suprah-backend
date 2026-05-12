import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import teamPulseController from '../controllers/teamPulse.controller';

const router = Router();

router.use(auth());

router.get('/members', teamPulseController.getMembers);

router.get('/absences',       teamPulseController.getAbsences);
router.post('/absences',      teamPulseController.createAbsence);
router.patch('/absences/:id', teamPulseController.updateAbsence);
router.delete('/absences/:id', teamPulseController.deleteAbsence);

router.get('/board',              teamPulseController.getBoardNotes);
router.post('/board',             teamPulseController.createBoardNote);
router.patch('/board/reorder',    teamPulseController.reorderBoardNotes);
router.patch('/board/:id',        teamPulseController.updateBoardNote);
router.delete('/board/:id',       teamPulseController.deleteBoardNote);
router.patch('/board/:id/pin',    teamPulseController.togglePinNote);

export default router;
