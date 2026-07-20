import { Router } from "express";
import crmAuth from "../middleware/crmAuth.middleware";
import {
  getFeed,
  getMySchedule,
  createEvent,
  updateEvent,
  deleteEvent,
  generateMeetingLink,
} from "../controllers/calendar.controller";
import { getNotificationsSummary } from "../controllers/calendarNotifications.controller";

const router = Router();

// crmAuth is a factory — must be invoked. Accepts crm_token cookie or
// main-app Bearer token, attaching req.crmUser + req.orgId.
router.use(crmAuth());

router.get("/feed", getFeed);
router.get("/my-schedule", getMySchedule);

// ── Notification center (sidebar badge + in-calendar bell) ──
// Today's events, next-24h items, overdue tasks, approaching deadlines,
// and the computed badgeCount. Static path, declared before /events/:id.
router.get("/notifications-summary", getNotificationsSummary);

router.post("/events", createEvent);
router.patch("/events/:id", updateEvent);
router.delete("/events/:id", deleteEvent);
router.post("/events/:id/meeting-link", generateMeetingLink);

export default router;