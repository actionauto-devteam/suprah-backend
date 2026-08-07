import express from 'express';
import youtubeController from '../controllers/youtube.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

router.use(crmAuth());
router.get('/search', youtubeController.search);

export default router;