import express from 'express';
import shipmentController from '../controllers/shipment.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';
import { uploadProofImage } from '../middleware/upload.middleware';

const router = express.Router();

router.use(auth());

// Submit proof: driver auth only — no org context needed.
// The controller finds the shipment by ID and verifies driver assignment.
router
    .route('/:id/submit-proof')
    .post(uploadProofImage, shipmentController.submitProofOfDelivery);

router.use(requireOrg);

router
    .route('/')
    .post(shipmentController.createShipment)
    .get(shipmentController.getShipments);

router
    .route('/stats')
    .get(shipmentController.getShipmentStats);

router
    .route('/:id')
    .get(shipmentController.getShipmentById)
    .put(shipmentController.updateShipment)
    .patch(shipmentController.updateShipment)
    .delete(shipmentController.deleteShipment);

router
    .route('/:id/notes')
    .post(shipmentController.addShipmentNote);

router
    .route('/:id/confirm-delivery')
    .post(shipmentController.confirmDelivery);

export default router;
