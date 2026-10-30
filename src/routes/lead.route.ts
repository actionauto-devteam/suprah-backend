import { Router } from "express";
import {
  receiveADF,
  getAllLeads,
  getLeadStatusCounts,
  getLeadLocationCounts,
  getLeadById,
  getUnansweredInquiryReminders,
  runUnansweredInquiryReminderCheck,
  updateLeadContact,
  updateLeadDetails,
  assignLead,
  updateLead,
  createInquiry,
  markAsRead,
  markAsPending,
  replyToInquiry,
  bulkReplyToInquiries,
  syncCentralGmail,
  syncGmailInquiries,
  setAppointmentForLead,
  getAppointmentsForLead,
  getThreadMessages,
  getCentralSyncStatus,
  addLeadNote,
  pauseEmailAi,
  resumeEmailAi,
} from "../controllers/lead.controller";
import { getLeadAiSummary, regenerateLeadAiSummary } from "../controllers/leadAiSummary.controller";
import { getLeadConversation, getLeadEarlierConversation } from "../controllers/leadConversation.controller";
import { generateLeadAiDraftHandler, getLeadReplyOptionsHandler } from "../controllers/leadComposer.controller";
import { staffAiDraftLimiter } from "../middleware/trainingLabRateLimit";
import { getLeadVehiclePreviewHandler } from "../controllers/leadVehiclePreview.controller";
import { getLicensePossibleMatchesHandler } from "../controllers/licensePossibleMatch.controller";
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

router.get("/status-counts", getLeadStatusCounts);
router.get("/location-counts", getLeadLocationCounts);
router.get("/possible-matches", getLicensePossibleMatchesHandler);

router.post(
  "/bulk-reply",
  bulkReplyLimiter,
  bulkReplyToInquiries,
);

router.get("/:id", getLeadById);
router.get("/:id/thread", getThreadMessages);
router.get("/:id/conversation", getLeadConversation);
router.get("/:id/conversation/earlier/:earlierId", getLeadEarlierConversation);
router.get("/:id/reply-options", getLeadReplyOptionsHandler);
router.get("/:id/vehicle-preview", getLeadVehiclePreviewHandler);
router.post("/:id/ai-draft", staffAiDraftLimiter, generateLeadAiDraftHandler);
router.get("/:id/ai-summary", getLeadAiSummary);
router.post("/:id/ai-summary/regenerate", regenerateLeadAiSummary);
router.patch("/:id/read", markAsRead);
router.patch("/:id/pending", markAsPending);
router.post("/:id/appointment", setAppointmentForLead);
router.get("/:id/appointments", getAppointmentsForLead);

router.post(
  "/:id/reply",
  replyLimiter,
  uploadLeadReplyAttachments,
  replyToInquiry,
);

router.post("/:id/notes", addLeadNote);
router.post("/:id/ai-pause", pauseEmailAi);
router.post("/:id/ai-resume", resumeEmailAi);
router.patch("/:id/contact", updateLeadContact);
router.patch("/:id/details", updateLeadDetails);
router.patch("/:id/assign", assignLead);

router.patch("/:id", updateLead);

export default router;