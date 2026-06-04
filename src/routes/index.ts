import express from "express";
import vehicleRoute from "./vehicle.route";
import dashboardRoute from "./dashboard.route";
import syncRoute from "./sync.route";
import quoteRoute from "./quote.routes";
import notificationRoute from "./notification.route";
import profileRoute from "./profile.route";
import appointmentRoute from "./appointment.route";
import appointmentDashboardRoute from "./appointmentDashboard.routes";
import userRoute from "./user.route";
import googleCalendarRoute from "./googleCalendar.routes";
import organizationRoute from "./organization.routes";
import invitationRoute from "./invitation.routes";
import driverTrackingRoute from "./driverTracking.routes";
import driverRequestRoute from "./driverRequest.routes";
import driverProfileRoute from "./driverProfile.routes";
import adminRoute from "./admin.routes";
import paymentRoute from "./payment.routes";
import driverPayoutRoute from "./driverPayout.routes";
import leadRoute from "./lead.route";
import orgLeadRoute from "./orgLead.route";
import crmRoute from "./crm.route";
import serviceRoute from "./service.route";
import ownedVehicleRoute from "./ownedVehicle.route";
import walletRoute from "./wallet.route";
import supraleoRoute from "./supraroute.route";
import crmBiometricRoute from "./crm-biometric.routes";
import supraSpaceRoute from "./supraspace.route";
import authRoute from "./auth.routes";
import crmTimeprofRoute from "./crmTimeproof.route";
import devToolsRoute from "./devTools.routes";
import pushRoute from "./push.route";
import loadRoute from "./load.routes";
import analyticsRoute from "./analytics.routes";
import activityRoute from "./activity.routes";
import customerRoute from "./customer.route";
import customerLeadRoute from "./customerLead.route";
import dayPulseRoute from "./dayPulse.routes";
import feedRoute from "./feed.route";
import feedReactionRoute from "./feedReaction.routes";
import feedCommentRoute from "./feedComment.routes";
import crmCalendarRoute from "./crmCalendar.routes";
import teamPulseRoute from "./teamPulse.routes";
import dealBoardRoute from "./dealBoard.routes";
import scheduleRoute from "./schedule.routes";
import wiseRoute from "./wise.routes";
import aftermarketRoute from "./aftermarket.route";
import crmAftermarketRoute from "./crmAftermarket.route";
import customerConcernRoute from "./customerConcern.route";
import customerCallRoute from "./customerCall.route";

const router = express.Router();

const defaultRoutes = [
  {
    path: "/vehicles",
    route: vehicleRoute,
  },
  {
    path: "/dashboard",
    route: dashboardRoute,
  },
  {
    path: "/sync",
    route: syncRoute,
  },
  {
    path: "/quotes",
    route: quoteRoute,
  },
  {
    path: "/notifications",
    route: notificationRoute,
  },
  {
    path: "/profile",
    route: profileRoute,
  },

  {
    path: "/appointments/dashboard",
    route: appointmentDashboardRoute,
  },
  {
    path: "/appointments",
    route: appointmentRoute,
  },
  {
    path: "/users",
    route: userRoute,
  },
  {
    path: "/google-calendar",
    route: googleCalendarRoute,
  },
  {
    path: "/organizations",
    route: organizationRoute,
  },
  {
    path: "/leads",
    route: leadRoute,
  },
  {
    path: "/crm",
    route: crmRoute,
  },
  {
    path: "/invitations",
    route: invitationRoute,
  },
  {
    path: "/crm/aftermarket",
    route: crmAftermarketRoute,
  },
  {
    path: "/aftermarket",
    route: aftermarketRoute,
  },
  {
    path: "/driver-tracking",
    route: driverTrackingRoute,
  },
  {
    path: "/admin",
    route: adminRoute,
  },
  {
    path: "/payments",
    route: paymentRoute,
  },
  {
    path: "/driver-requests",
    route: driverRequestRoute,
  },
  {
    path: "/service",
    route: serviceRoute,
  },
  {
    path: "/customer/vehicles",
    route: ownedVehicleRoute,
  },
  {
    path: "/customer/wallet",
    route: walletRoute,
  },
  {
    path: "/driver-payouts",
    route: driverPayoutRoute,
  },
  {
    path: "/supraleo",
    route: supraleoRoute,
  },
  {
    path: "/crm/timeproof",
    route: crmTimeprofRoute,
  },
  {
    path: "/supraspace",
    route: supraSpaceRoute,
  },
  {
    path: "/auth",
    route: authRoute,
  },
  {
    path: "/dev",
    route: devToolsRoute,
  },
  {
    path: "/push",
    route: pushRoute,
  },
  {
    path: "/loads",
    route: loadRoute,
  },
  {
    path: "/analytics",
    route: analyticsRoute,
  },
  {
    path: "/activity",
    route: activityRoute,
  },
  {
    path: "/customers",
    route: customerRoute,
  },
  {
    path: "/customer/leads",
    route: customerLeadRoute,
  },
  {
    path: "/crm/feeds/reactions",
    route: feedReactionRoute,
  },
  {
    path: "/crm/feeds",
    route: feedRoute,
  },
  {
    path: "/crm/feeds",
    route: feedCommentRoute,
  },
  {
    path: "/crm/biometric",
    route: crmBiometricRoute,
  },
  {
    path: "/crm/daypulse",
    route: dayPulseRoute,
  },
  {
    path: "/org-lead",
    route: orgLeadRoute,
  },
  {
    path: "/driver-profile",
    route: driverProfileRoute,
  },
  {
    path: "/crm/calendar",
    route: crmCalendarRoute,
  },
  {
    path: "/billing",
    route: wiseRoute,
  },
  {
    path: "/team-pulse",
    route: teamPulseRoute,
  },
  {
    path: "/customer-concern",
    route: customerConcernRoute,
  },
  {
    path: "/customer-call",
    route: customerCallRoute,
  },
  {
    path: "/deal-board",
    route: dealBoardRoute,
  },
  {
    path: "/schedules",
    route: scheduleRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;