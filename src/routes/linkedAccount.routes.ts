import express from "express";
import linkedAccountController from "../controllers/linkedAccount.controller";
import auth from "../middleware/auth.middleware";

const router = express.Router();

router.get("/:provider/callback", linkedAccountController.handleCallback);

router.use(auth());

router.get("/:provider/connect", linkedAccountController.initiateConnect);
router.get("/status", linkedAccountController.getStatus);
router.post("/sync", linkedAccountController.syncBalances);
router.get("/transactions", linkedAccountController.getTransactions);
router.post("/transfer", linkedAccountController.createTransfer);
router.post("/disconnect", linkedAccountController.disconnect);

export default router;