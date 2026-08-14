import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';
import { marketIqLimiter } from '../middleware/rate-limit.middleware';
import suprahRadarController from '../controllers/suprahRadar.controller';

const router = Router();

router.use(auth());
router.use(requireOrg);
router.use(marketIqLimiter);

router.get('/overview', suprahRadarController.getOverview);
router.get('/leaderboards', suprahRadarController.getLeaderboards);
router.get('/trends', suprahRadarController.getTrends);
router.get('/supply', suprahRadarController.getSupply);
router.get('/dealer-performance', suprahRadarController.getDealerPerformance);
router.get('/recommendations', suprahRadarController.getRecommendations);
router.get('/segments', suprahRadarController.getSegments);
router.get('/model-detail', suprahRadarController.getModelDetail);
router.get('/opportunities', suprahRadarController.getOpportunities);
router.get('/scope-options', suprahRadarController.getScopeOptions);
router.get('/compare', suprahRadarController.getComparison);
router.get('/export', suprahRadarController.exportMarket);

router.get('/watchlist', suprahRadarController.getWatchlist);
router.post('/watchlist', suprahRadarController.addWatch);
router.delete('/watchlist/:id', suprahRadarController.removeWatch);

router.get('/dealers', suprahRadarController.getDealers);
router.get('/dealers/:id', suprahRadarController.getDealerProfile);

export default router;
