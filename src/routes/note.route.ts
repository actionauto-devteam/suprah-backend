import express from 'express';
import noteController from '../controllers/note.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

router.use(crmAuth());

router.get('/', noteController.getNotes);
router.put('/', noteController.putNote);
router.delete('/', noteController.deleteNote);

export default router;