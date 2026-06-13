import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
    getReviewListings,
    getReviewListing,
    approveListing,
    rejectListing,
} from '../controllers/auctionListingReview.controller';

const router = Router();

router.use(crmAuth());

router.get('/', getReviewListings);
router.get('/:id', getReviewListing);
router.post('/:id/approve', approveListing);
router.post('/:id/reject', rejectListing);

export default router;
