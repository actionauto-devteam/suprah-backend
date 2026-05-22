import express from 'express';
import aftermarketController from '../controllers/aftermarket.controller';
import crmAuth from '../middleware/crmAuth.middleware';
import aftermarketUpload from '../middleware/aftermarketUpload.middleware';

const router = express.Router();

// All Finance Line routes require an authenticated CRM user.
// (Admin-only enforcement happens inside the controller so we can return
//  a clean 403 message rather than a generic middleware rejection.)
router.use(crmAuth());

router.get('/', aftermarketController.getProductsForCrm);
router.post('/', aftermarketUpload, aftermarketController.createProduct);
router.patch('/:id', aftermarketUpload, aftermarketController.updateProduct);
router.delete('/:id', aftermarketController.deleteProduct);

export default router;