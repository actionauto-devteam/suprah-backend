import { Router } from 'express';
import multer from 'multer';
import auth from '../middleware/auth.middleware';
import teamPulseController from '../controllers/teamPulse.controller';

const router = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 3 },
    fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        cb(null, allowed.includes(file.mimetype));
    },
});

router.use(auth());

router.get('/members', teamPulseController.getMembers);
router.patch('/members/:userId/employment-location', teamPulseController.setEmploymentLocationType);

router.get('/absences',                          teamPulseController.getAbsences);
router.post('/absences',                         teamPulseController.createAbsence);
router.patch('/absences/:id',                    teamPulseController.updateAbsence);
router.delete('/absences/:id',                   teamPulseController.deleteAbsence);
router.patch('/absences/:id/approve',            teamPulseController.approveAbsence);
router.patch('/absences/:id/reject',             teamPulseController.rejectAbsence);
router.post('/absences/:id/proof', upload.array('files', 3), teamPulseController.uploadAbsenceProof);

router.get('/board',                             teamPulseController.getBoardNotes);
router.post('/board',                            teamPulseController.createBoardNote);
router.patch('/board/reorder',                   teamPulseController.reorderBoardNotes);
router.patch('/board/:id',                       teamPulseController.updateBoardNote);
router.delete('/board/:id',                      teamPulseController.deleteBoardNote);
router.patch('/board/:id/pin',                   teamPulseController.togglePinNote);
router.patch('/board/:id/ack',                   teamPulseController.ackBoardNote);
router.post('/board/:id/attachments', upload.array('images', 3), teamPulseController.uploadBoardNoteAttachments);
router.get('/board/:id/reactions',               teamPulseController.getBoardNoteReactions);
router.post('/board/:id/reactions',              teamPulseController.toggleBoardNoteReaction);

router.get('/leaderboard',                       teamPulseController.getLeaderboard);
router.get('/performance',                       teamPulseController.getPerformanceStats);

router.post('/ping/:userId',                     teamPulseController.pingMember);

router.get('/activity-feed',                     teamPulseController.getActivityFeed);
router.post('/break/start',                      teamPulseController.startBreak);
router.post('/break/end',                        teamPulseController.endBreak);

export default router;
