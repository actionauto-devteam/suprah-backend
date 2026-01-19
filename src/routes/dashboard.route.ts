import express from 'express';
import dashboardController from '../controllers/dashboard.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.get('/metrics', auth(), dashboardController.getDashboardMetrics);

export default router;
