/**
 * Public Website Purchase Widget routes — mounted at /api/public/deal-desk.
 * No auth; per-IP rate limits; CORS limited to the dealer's configured sites.
 */
import express from 'express';
import {
  widgetCors,
  widgetLimiter,
  getWidgetConfig,
  estimatePayments,
  submitWebDeal,
} from '../controllers/dealDeskPublic.controller';

const router = express.Router({ mergeParams: true });

router.use('/:orgKey', widgetCors);
router.get('/:orgKey/config', widgetLimiter(60, 60_000), getWidgetConfig);
router.post('/:orgKey/estimate', widgetLimiter(60, 60_000), estimatePayments);
router.post('/:orgKey/deals', widgetLimiter(5, 10 * 60_000), submitWebDeal);

export default router;
