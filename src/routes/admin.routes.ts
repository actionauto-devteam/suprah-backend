import express from "express";
import adminController from "../controllers/admin.controller";
import adminReferralController from "../controllers/admin.referral.controller";
import auth from "../middleware/auth.middleware";
import { requireSuperAdmin } from "../middleware/rbac.middleware";

const router = express.Router();

// All routes require authentication and super_admin role
router.use(auth());
router.use(requireSuperAdmin);

// --- DASHBOARD & STATS ---
router.get("/organizations", adminController.getAllOrganizations);
router.get("/users", adminController.getAllUsers);
router.get("/stats", adminController.getSystemStats); // DB Counts
router.get("/financials", adminController.getFinancialStats);

// --- MONITORING & SYSTEM (PHASE 2) ---
router.get("/system/stats", adminController.getProcessStats); // CPU/RAM
router.get("/system/logs", adminController.getSystemLogs);
router.get("/system/logs/stats", adminController.getLogStats);
router.post("/system/logs/clear", adminController.clearSystemLogs);

// --- LOGS & AUDIT ---
router.get("/audit-logs", adminController.getAuditLogs);
router.get("/audit-logs/stats", adminController.getAuditLogStats);
router.get("/sync-logs", adminController.getSyncLogs);
router.get("/sync-logs/stats", adminController.getSyncStats);

// --- USER MANAGEMENT ACTIONS ---
router.post("/users/:id/suspend", adminController.suspendUser);
router.post("/users/:id/activate", adminController.activateUser);
router.put("/users/:id/role", adminController.updateUserRole);
router.delete("/users/:id", adminController.deleteUser);

// --- ORGANIZATION MANAGEMENT ACTIONS ---
router.put("/organizations/:id/status", adminController.suspendOrganization);
router.put("/organizations/:id/activate", adminController.activateOrganization);
router.put("/organizations/:id/suspend", adminController.suspendOrganization);
router.put(
  "/organizations/:id/subscription",
  adminController.updateOrganizationSubscription,
);

// --- REFERRAL ENGINE & DIGITAL WALLET CONTROLS ---
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
