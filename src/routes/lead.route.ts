import { Router } from "express";
import {
  receiveADF,
  getAllLeads,
  getLeadStatusCounts,
  getLeadLocationCounts,
  getLeadTypeCounts,
  getAssignedNewCount,
  getNeedsReplyCount,
  getLeadById,
  getUnansweredInquiryReminders,
  runUnansweredInquiryReminderCheck,
  updateLeadContact,
  updateLeadDetails,
  assignLead,
  updateLead,
  createInquiry,
  markAsRead,
  markLeadOpened,
  markNoReplyNeeded,
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
  getLeadHandlersHandler,
} from "../controllers/lead.controller";
import { getLeadAiSummary, regenerateLeadAiSummary } from "../controllers/leadAiSummary.controller";
import { getLeadConversation, getLeadEarlierConversation } from "../controllers/leadConversation.controller";
import { generateLeadAiDraftHandler, getLeadReplyOptionsHandler } from "../controllers/leadComposer.controller";
import { staffAiDraftLimiter } from "../middleware/trainingLabRateLimit";
import { getLeadVehiclePreviewHandler } from "../controllers/leadVehiclePreview.controller";
import { searchLeadVehiclesHandler } from "../controllers/leadVehiclePick.controller";
import { getLicensePossibleMatchesHandler } from "../controllers/licensePossibleMatch.controller";
import { completeLeadMentionsHandler, getLeadMentionCountHandler, listLeadMentionsHandler } from "../controllers/leadMention.controller";
import crmAuth from "../middleware/crmAuth.middleware";
import {
  adfLimiter,
  syncLimiter,
  replyLimiter,
  bulkReplyLimiter,
} from "../middleware/rate-limit.middleware";
import { validateAdfSignature } from "../middleware/adfValidation.middleware";
import { uploadLeadReplyAttachments } from "../middleware/lead-reply-upload.middleware";
import { downloadLeadEmailAttachment } from "../controllers/leadEmailAttachment.controller";

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
router.get("/lead-type-counts", getLeadTypeCounts);
router.get("/assigned-new-count", getAssignedNewCount);
router.get("/vehicle-search", searchLeadVehiclesHandler);
router.get("/needs-reply-count", getNeedsReplyCount);
router.get("/mentions", listLeadMentionsHandler);
router.get("/mentions/count", getLeadMentionCountHandler);
router.post("/mentions/complete", completeLeadMentionsHandler);
router.get("/possible-matches", getLicensePossibleMatchesHandler);

router.post(
  "/bulk-reply",
  bulkReplyLimiter,
  bulkReplyToInquiries,
);

router.get("/:id", getLeadById);
router.get("/:id/thread", getThreadMessages);
router.get("/:id/email-attachments/:gmailId/:index", downloadLeadEmailAttachment);
router.get("/:id/conversation", getLeadConversation);
router.get("/:id/conversation/earlier/:earlierId", getLeadEarlierConversation);
router.get("/:id/reply-options", getLeadReplyOptionsHandler);
router.get("/:id/vehicle-preview", getLeadVehiclePreviewHandler);
router.post("/:id/ai-draft", staffAiDraftLimiter, generateLeadAiDraftHandler);
router.get("/:id/ai-summary", getLeadAiSummary);
router.post("/:id/ai-summary/regenerate", regenerateLeadAiSummary);
router.patch("/:id/read", markAsRead);
router.patch("/:id/opened", markLeadOpened);
router.patch("/:id/no-reply-needed", markNoReplyNeeded);
router.patch("/:id/pending", markAsPending);
router.post("/:id/appointment", setAppointmentForLead);
router.get("/:id/appointments", getAppointmentsForLead);
router.get("/:id/handlers", getLeadHandlersHandler);

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