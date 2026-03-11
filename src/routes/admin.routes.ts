import express from "express";
import adminController from "../controllers/admin.controller";
import adminReferralController from "../controllers/admin.referral.controller";
import auth from "../middleware/auth.middleware";
import { ApiError } from "../utils/ApiError";

const router = express.Router();

// Middleware to ensure user is Super Admin
const requireSuperAdmin = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (req.user?.role !== "super_admin") {
    return next(new ApiError(403, "Requires Super Admin privileges"));
  }
  next();
};

// All routes require authentication and super_admin role
router.use(auth());
router.use(requireSuperAdmin);

router.get("/organizations", adminController.getAllOrganizations);
router.get("/users", adminController.getAllUsers);
router.get("/stats", adminController.getSystemStats);
router.get("/financials", adminController.getFinancialStats);
router.get("/audit-logs", adminController.getAuditLogs);
router.get("/audit-logs/stats", adminController.getAuditLogStats);
router.get("/sync-logs", adminController.getSyncLogs);
router.get("/sync-logs/stats", adminController.getSyncStats);

// User Management Actions
router.post("/users/:id/suspend", adminController.suspendUser);
router.post("/users/:id/activate", adminController.activateUser);
router.put("/users/:id/role", adminController.updateUserRole);
router.delete("/users/:id", adminController.deleteUser);

// Organization Management Actions
router.put("/organizations/:id/status", adminController.suspendOrganization); // Simplified to toggle logic or specific status
router.put("/organizations/:id/activate", adminController.activateOrganization); // Explicit activate
router.put("/organizations/:id/suspend", adminController.suspendOrganization); // Explicit suspend
router.put(
  "/organizations/:id/subscription",
  adminController.updateOrganizationSubscription,
);

// Referral Engine & Digital Wallet Controls
router.post(
  "/referrals/:referralId/issue-reward",
  adminReferralController.issueReward,
);
router.get(
  "/referrals/withdrawals",
  adminReferralController.getPendingWithdrawals,
);
router.get(
  "/referrals/withdrawals/:transactionId/audit",
  adminReferralController.getWithdrawalAudit,
);
router.post(
  "/referrals/withdrawals/:transactionId/approve",
  adminReferralController.approveWithdrawal,
);
router.post(
  "/referrals/withdrawals/:transactionId/reject",
  adminReferralController.rejectWithdrawal,
);

export default router;
