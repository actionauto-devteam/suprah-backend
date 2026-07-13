import express from 'express';
import walletController from '../controllers/wallet.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

router.get('/', walletController.getWalletDashboard);

router.post('/link-referral', walletController.linkReferral);

router.post('/withdraw', walletController.requestWithdrawal);

export default router;
