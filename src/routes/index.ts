import express from "express";
import vehicleRoute from "./vehicle.route";
import dashboardRoute from "./dashboard.route";
import syncRoute from "./sync.route";
import shipmentRoute from "./shipment.routes";
import quoteRoute from "./quote.routes";
import notificationRoute from "./notification.route";
import profileRoute from "./profile.route";
import appointmentRoute from "./appointment.route";
import conversationRoute from "./conversation.route";
import userRoute from "./user.route";
import googleCalendarRoute from "./googleCalendar.routes";
import gmailRoute from "./gmail.route";
import organizationRoute from "./organization.routes";
import invitationRoute from "./invitation.routes";
import driverTrackingRoute from "./driverTracking.routes";
import driverRequestRoute from "./driverRequest.routes";
import adminRoute from "./admin.routes";
import paymentRoute from "./payment.routes";
import leadRoute from "./lead.route";
import serviceRoute from "./service.route";
import ownedVehicleRoute from "./ownedVehicle.route";

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
    path: "/shipments",
    route: shipmentRoute,
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
    path: "/appointments",
    route: appointmentRoute,
  },
  {
    path: "/conversations",
    route: conversationRoute,
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
    path: "/gmail",
    route: gmailRoute,
  },
  {
    path: "/leads",
    route: leadRoute,
  },
  {
    path: "/organizations",
    route: organizationRoute,
  },
  {
    path: "/invitations",
    route: invitationRoute,
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
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;