import express from 'express';
import aftermarketController from '../controllers/aftermarket.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// All customer aftermarket routes are protected by the standard user auth
// middleware (the same one service.route.ts uses), which also populates req.orgId.
router.use(auth());

// Browse
router.get('/', aftermarketController.getProductsForCustomer);

// Orders (declare BEFORE '/:id' so 'orders' isn't captured as an id param)
router.get('/orders/mine', aftermarketController.getMyOrders);
router.post('/checkout', aftermarketController.checkout);

// Single product
router.get('/:id', aftermarketController.getProductById);

export default router;