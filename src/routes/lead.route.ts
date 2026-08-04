import { Router } from "express";
import {
  receiveADF,
  getAllLeads,
  getLeadById,
  getUnansweredInquiryReminders,
  runUnansweredInquiryReminderCheck,
  updateLeadContact,
  updateLeadDetails,
  updateLead,
  createInquiry,
  markAsRead,
  markAsPending,
  replyToInquiry,
  bulkReplyToInquiries,
  syncCentralGmail,
  syncGmailInquiries,
  setAppointmentForLead,
  getThreadMessages,
  getCentralSyncStatus,
  addLeadNote,
} from "../controllers/lead.controller";
import crmAuth from "../middleware/crmAuth.middleware";
import {
  adfLimiter,
  syncLimiter,
  replyLimiter,
  bulkReplyLimiter,
} from "../middleware/rate-limit.middleware";
import { validateAdfSignature } from "../middleware/adfValidation.middleware";
import { uploadLeadReplyAttachments } from "../middleware/lead-reply-upload.middleware";

const router = Router();

router.post("/adf", adfLimiter, validateAdfSignature, receiveADF);

router.use(crmAuth());

router.post("/sync-central", syncLimiter, syncCentralGmail);
router.post("/sync-gmail", syncLimiter, syncGmailInquiries);

router.get("/sync-status", getCentralSyncStatus);

router.get("/reminders/unanswered", getUnansweredInquiryReminders);
router.post(
  "/reminders/unanswered/run",
  runUnansweredInquiryReminderCheck,
);

router.get("/", getAllLeads);
router.post("/", syncLimiter, createInquiry);

router.post(
  "/bulk-reply",
  bulkReplyLimiter,
  bulkReplyToInquiries,
);

router.get("/:id", getLeadById);
router.get("/:id/thread", getThreadMessages);
router.patch("/:id/read", markAsRead);
router.patch("/:id/pending", markAsPending);
router.post("/:id/appointment", setAppointmentForLead);

router.post(
  "/:id/reply",
  replyLimiter,
  uploadLeadReplyAttachments,
  replyToInquiry,
);

router.post("/:id/notes", addLeadNote);
router.patch("/:id/contact", updateLeadContact);
router.patch("/:id/details", updateLeadDetails);

router.patch("/:id", updateLead);

export default router;