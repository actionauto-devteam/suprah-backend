import express from 'express';
import walletController from '../controllers/wallet.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// All wallet routes require authentication
router.use(auth());

// Get Wallet Dashboard (Balance, Metrics, Transactions)
router.get('/', walletController.getWalletDashboard);

// Link a new user to a referrer code
router.post('/link-referral', walletController.linkReferral);

// Request to withdraw funds
router.post('/withdraw', walletController.requestWithdrawal);

export default router;
