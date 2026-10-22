import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/crmLocation.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.getLocations);
router.get('/suggestions', ctrl.getLocationSuggestions);
router.post('/', ctrl.createLocationHandler);
router.get('/:id', ctrl.getLocation);
router.patch('/:id', ctrl.updateLocationHandler);
router.post('/:id/archive', ctrl.archiveLocationHandler);
router.post('/:id/restore', ctrl.restoreLocationHandler);

export default router;
