import express from 'express';
import driverPayoutController from '../controllers/driverPayout.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';
import authorize from '../middleware/role.middleware';

const router = express.Router();

router.use(auth());

router.post('/connect/onboard', driverPayoutController.initiateDriverOnboarding);
router.get('/connect/status', driverPayoutController.getDriverConnectStatus);
router.get('/my-payouts', driverPayoutController.getMyPayouts);

router.use(requireOrg);

router.get('/deliverable', driverPayoutController.getDeliverableLoads);
router.get('/pending-proofs', driverPayoutController.getPendingProofs);
router.get('/org-admins', driverPayoutController.getOrgAdmins);
router.get('/stats', driverPayoutController.getPayoutStats);
router
  .route('/')
  .get(driverPayoutController.getPayouts)
  .post(authorize(['admin', 'super_admin']), driverPayoutController.createPayout);

export default router;
