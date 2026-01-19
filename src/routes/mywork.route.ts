import express from 'express';
import myWorkController from '../controllers/mywork.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.get('/', auth(), myWorkController.getMyWork);
router.patch('/:id/step', auth(), myWorkController.updateStep);
router.post('/:id/notes', auth(), myWorkController.addNote);

export default router;
