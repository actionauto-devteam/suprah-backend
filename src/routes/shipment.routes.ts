import express from 'express';
import shipmentController from '../controllers/shipment.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

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

export default router;