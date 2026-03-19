import express from 'express';
import feedController from '../controllers/feed.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// All feed routes require CRM authentication
router.use(crmAuth());

router.get('/',    feedController.getPosts);
router.post('/',   feedController.createPost);
router.put('/:id', feedController.updatePost);
router.delete('/:id', feedController.deletePost);

export default router;