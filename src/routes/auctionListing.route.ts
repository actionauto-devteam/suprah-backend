import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import { uploadListingPhoto } from '../middleware/upload.middleware';
import {
    createListing,
    getListings,
    getListing,
    updateListing,
    submitListing,
    withdrawListing,
    deleteListing,
    uploadListingPhotoHandler,
    deleteListingPhoto,
} from '../controllers/auctionListing.controller';

const router = Router();

router.use(auth());

router.post('/', createListing);
router.get('/', getListings);
router.get('/:id', getListing);
router.put('/:id', updateListing);
router.post('/:id/submit', submitListing);
router.post('/:id/withdraw', withdrawListing);
router.delete('/:id', deleteListing);
router.post('/:id/photos/:slot', uploadListingPhoto, uploadListingPhotoHandler);
router.delete('/:id/photos/:slot', deleteListingPhoto);

export default router;
