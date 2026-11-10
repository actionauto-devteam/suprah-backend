import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  addDealOfferHandler,
  createDealHandler,
  deleteDealHandler,
  getDealHandler,
  listDealsHandler,
  searchDealLeadsHandler,
  updateDealHandler,
} from '../controllers/crmDeal.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', listDealsHandler);
router.get('/lead-search', searchDealLeadsHandler);
router.post('/', createDealHandler);
router.get('/:id', getDealHandler);
router.patch('/:id', updateDealHandler);
router.post('/:id/offers', addDealOfferHandler);
router.delete('/:id', deleteDealHandler);

export default router;
