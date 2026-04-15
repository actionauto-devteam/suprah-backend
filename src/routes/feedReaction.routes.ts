import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import reactionController from '../controllers/feedReaction.controller';

const router = Router();

// All reaction routes require authentication
router.use(crmAuth());

// Toggle (add / remove / switch) a reaction
router.post('/', reactionController.toggleReaction);

// Fetch reactions for a single target
router.get('/', reactionController.getReactions);

// Fetch reactions for multiple targets in one shot (used on feed page load)
router.post('/bulk', reactionController.getBulkReactions);

export default router;