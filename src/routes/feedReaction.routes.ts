import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import reactionController from '../controllers/feedReaction.controller';

const router = Router();

router.use(crmAuth());

router.post('/', reactionController.toggleReaction);

router.get('/', reactionController.getReactions);

router.post('/bulk', reactionController.getBulkReactions);

export default router;