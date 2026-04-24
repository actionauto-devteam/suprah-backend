import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { addComment, getComments, deleteComment } from '../controllers/feedComment.controller';

const router = Router();

router.use(crmAuth());

router.post('/:postId/comments',              addComment);
router.get('/:postId/comments',               getComments);
router.delete('/:postId/comments/:commentId', deleteComment);

export default router;