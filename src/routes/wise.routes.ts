import express from "express";
import * as wiseController from "../controllers/wiseController";
import auth from "../middleware/auth.middleware"; // Your auth middleware

const router = express.Router();

// All wallet routes require authentication
router.use(auth());

// OAuth flow
router.get("/connect", wiseController.initiateConnect);
router.get("/callback", wiseController.handleCallback);

// Account operations
router.get("/status", wiseController.getAccountStatus);
router.get("/balances", wiseController.getBalances);
router.get("/transactions", wiseController.getTransactions);
router.post("/transfer", wiseController.createTransfer);
router.post("/disconnect", wiseController.disconnect);

export default router;