import express from 'express';
import quoteController from '../controllers/quote.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

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

export default router;