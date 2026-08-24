import express from "express";
import adminController from "../controllers/admin.controller";
import adminReferralController from "../controllers/admin.referral.controller";
import driverAdminController from "../controllers/driverAdmin.controller";
import {
  listDealershipInquiries,
  getDealershipInquiry,
  sendDealershipSetupLink,
  dismissDealershipInquiry,
} from "../controllers/dealershipInquiry.controller";
import { adminAdjustPoints } from "../controllers/membership.controller";
import auth from "../middleware/auth.middleware";
import { requireSuperAdmin } from "../middleware/rbac.middleware";

const router = express.Router();

router.use(auth());
router.use(requireSuperAdmin);

router.get("/organizations", adminController.getAllOrganizations);
router.get("/users", adminController.getAllUsers);
router.get("/stats", adminController.getSystemStats);
router.get("/financials", adminController.getFinancialStats);

router.get("/system/stats", adminController.getProcessStats);
router.get("/system/logs", adminController.getSystemLogs);
router.get("/system/logs/stats", adminController.getLogStats);
router.post("/system/logs/clear", adminController.clearSystemLogs);

router.get("/audit-logs", adminController.getAuditLogs);
router.get("/audit-logs/stats", adminController.getAuditLogStats);
router.get("/sync-logs", adminController.getSyncLogs);
router.get("/sync-logs/stats", adminController.getSyncStats);

router.post("/users/:id/suspend", adminController.suspendUser);
router.post("/users/:id/activate", adminController.activateUser);
router.put("/users/:id/role", adminController.updateUserRole);
router.put("/users/:id/organization", adminController.updateUserOrganization);
router.delete("/users/:id", adminController.deleteUser);

router.put("/organizations/:id/status", adminController.suspendOrganization);
router.put("/organizations/:id/activate", adminController.activateOrganization);
router.put("/organizations/:id/suspend", adminController.suspendOrganization);
router.put(
  "/organizations/:id/subscription",
  adminController.updateOrganizationSubscription,
);

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

router.post("/membership/adjust-points", adminAdjustPoints);

// Dealership inquiries — public email capture reviewed here, superadmin
// triggers the private setup link.
router.get("/dealership-inquiries", listDealershipInquiries);
router.get("/dealership-inquiries/:id", getDealershipInquiry);
router.post("/dealership-inquiries/:id/send-link", sendDealershipSetupLink);
router.post("/dealership-inquiries/:id/dismiss", dismissDealershipInquiry);

// Drivers are a shared platform-wide pool — administered here, not per org.
router.post("/drivers/invite-link", driverAdminController.generateDriverInviteLink);
router.post("/drivers/invite-link/bulk", driverAdminController.bulkGenerateDriverInviteLinks);
router.get("/drivers", driverAdminController.getAllDrivers);
router.get("/drivers/:driverId", driverAdminController.getDriverById);
router.patch("/drivers/:driverId/approve", driverAdminController.approveDriverProfile);
router.patch("/drivers/:driverId/documents/:documentId/verify", driverAdminController.verifyDocument);
router.patch("/drivers/:driverId/documents/:documentId/reject", driverAdminController.rejectDocument);

export default router;
