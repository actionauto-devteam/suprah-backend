/**
 * Deal Desk routes — mounted at /api/crm/deal-desk (see routes/index.ts).
 * Must be registered ABOVE "/crm" so crm.route's dynamic routes don't
 * shadow it (same rule as /crm/communications, /crm/contacts, …).
 */
import express from 'express';
import multer from 'multer';
import crmAuth from '../middleware/crmAuth.middleware';
import { ApiError } from '../utils/ApiError';
import * as c from '../controllers/dealDesk.controller';
import { bootDealDesk } from '../services/dealDesk/boot';

bootDealDesk();

const ALLOWED_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, 'Upload a PDF or a photo (JPG, PNG, WEBP, HEIC).') as any);
  },
});

const router = express.Router();
router.use(crmAuth());

router.get('/me', c.getBootstrap);
router.get('/metrics', c.getMetrics);

router.get('/deals', c.listDeals);
router.post('/deals', c.createDeal);
router.get('/deals/:id', c.getDeal);
router.patch('/deals/:id', c.updateDeal);
router.post('/deals/:id/submit', c.submitDeal);
router.post('/deals/:id/pickup', c.pickupDeal);
router.post('/deals/:id/return', c.returnToQueue);
router.post('/deals/:id/analyze', c.analyzeDealHandler);
router.post('/deals/:id/request-info', c.requestInfo);
router.post('/deals/:id/approve', c.approveDeal);
router.post('/deals/:id/offer/accept', c.acceptOfferHandler);
router.post('/deals/:id/offer/decline', c.declineOfferHandler);
router.post('/deals/:id/release', c.releaseHandler);
router.post('/deals/:id/stage', c.changeStage);
router.post('/deals/:id/reveal-ssn', c.revealSsn);

router.post('/deals/:id/documents', upload.single('file'), c.uploadDocument);
router.get('/deals/:id/documents/:docId', c.getDocument);
router.delete('/deals/:id/documents/:docId', c.deleteDocument);

router.get('/deals/:id/messages', c.listMessages);
router.post('/deals/:id/messages', c.postMessage);

router.get('/fm', c.getPresence);
router.post('/fm/availability', c.updateAvailability);

router.get('/settings', c.getSettingsHandler);
router.put('/settings', c.updateSettingsHandler);
router.get('/people', c.listPeople);

router.get('/lenders', c.listLenders);
router.post('/lenders', c.createLender);
router.put('/lenders/:lenderId', c.updateLender);
router.delete('/lenders/:lenderId', c.deleteLender);

export default router;
