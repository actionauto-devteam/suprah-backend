import express from 'express';
import { renderUnsubscribeConfirm, confirmUnsubscribe } from '../controllers/emailUnsubscribe.controller';

const router = express.Router();

router.get('/', renderUnsubscribeConfirm);
router.post('/', confirmUnsubscribe);

export default router;
