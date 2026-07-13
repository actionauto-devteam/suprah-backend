import { Router } from "express";
import {
  getFeed,
  getMySchedule,
  createEvent,
  updateEvent,
  deleteEvent,
  generateMeetingLink,
} from "../controllers/calendar.controller";

// TODO(integration): import your existing auth middleware.
// import { crmAuth } from "../middleware/crmAuth.middleware";

const router = Router();

// router.use(crmAuth); // TODO(integration): uncomment

router.get("/feed", getFeed);
router.get("/my-schedule", getMySchedule);
router.post("/events", createEvent);
router.patch("/events/:id", updateEvent);
router.delete("/events/:id", deleteEvent);
router.post("/events/:id/meeting-link", generateMeetingLink);

export default router;

/**
 * Mount in server.ts / app.ts:
 *
 *   import calendarRoutes from "./routes/calendar.routes";
 *   app.use("/api/calendar", calendarRoutes);
 *
 * And in your socket bootstrap:
 *
 *   import { setCalendarIO } from "./services/calendarSocket.service";
 *   setCalendarIO(io);
 *
 * Finally, in your existing Appointment controller, add these one-liners
 * after each mutation so appointment changes fan out to Suprah Calendar:
 *
 *   emitCalendarChange("calendar:created", dealershipId, { source: "appointment", item: mappedAppointment });
 *   emitCalendarChange("calendar:updated", dealershipId, { source: "appointment", item: mappedAppointment });
 *   emitCalendarChange("calendar:deleted", dealershipId, { source: "appointment", id: String(appointment._id) });
 */
