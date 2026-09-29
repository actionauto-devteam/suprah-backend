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

// What each driver is paid, and their payout accounts, is for the
// organization's staff. Drivers use /my-payouts above.
const staffOnly = authorize(
  ['super_admin', 'admin', 'employee'],
  "Only your organization's staff can view driver payouts.",
);

router.get('/deliverable', staffOnly, driverPayoutController.getDeliverableLoads);
router.get('/pending-proofs', driverPayoutController.getPendingProofs);
router.get('/org-admins', staffOnly, driverPayoutController.getOrgAdmins);
router.get('/stats', staffOnly, driverPayoutController.getPayoutStats);
router
  .route('/')
  .get(staffOnly, driverPayoutController.getPayouts)
  .post(authorize(['admin', 'super_admin']), driverPayoutController.createPayout);

export default router;
