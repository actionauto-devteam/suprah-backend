import express from 'express';
import PushController from '../controllers/push.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

router.post('/subscribe', PushController.subscribe);
router.delete('/subscribe', PushController.unsubscribe);
router.post('/broadcast', PushController.broadcast);

export default router;
