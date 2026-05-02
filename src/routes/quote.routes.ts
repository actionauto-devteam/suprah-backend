import express from 'express';
import quoteController from '../controllers/quote.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

router.use(auth());
router.use(requireOrg);

router
    .route('/')
    .post(quoteController.createQuote)
    .get(quoteController.getQuotes);

router
    .route('/:id')
    .get(quoteController.getQuoteById)
    .put(quoteController.updateQuote)
    .patch(quoteController.updateQuote)
    .delete(quoteController.deleteQuote);

router
    .route('/:id/status')
    .patch(quoteController.updateQuoteStatus);

router
    .route('/:id/convert-to-load')
    .post(quoteController.convertToLoad);

export default router;