import express from 'express';
import noteController from '../controllers/note.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

router.use(crmAuth());

// Static routes first.
router.get('/', noteController.getNotes);
router.put('/', noteController.putNote);
router.delete('/', noteController.deleteNote);

// Per-note routes (view / react / comment).
router.get('/:id', noteController.getNote);
router.post('/:id/react', noteController.reactNote);
router.post('/:id/comment', noteController.commentNote);

export default router;