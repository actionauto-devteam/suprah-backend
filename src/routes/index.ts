import express from 'express';
import authRoute from './auth.route';
import vehicleRoute from './vehicle.route';
import dashboardRoute from './dashboard.route';
import syncRoute from './sync.route';
import shipmentRoute from './shipment.routes';
import quoteRoute from './quote.routes';
import notificationRoute from './notification.route';
import profileRoute from './profile.route';
import appointmentRoute from './appointment.route';
import conversationRoute from './conversation.route';
import userRoute from './user.route';

const router = express.Router();

const defaultRoutes = [
  {
    path: '/auth',
    route: authRoute,
  },
  {
    path: '/vehicles',
    route: vehicleRoute,
  },
  {
    path: '/dashboard',
    route: dashboardRoute,
  },
  {
    path: '/sync',
    route: syncRoute,
  },
  {
    path: '/shipments',
    route: shipmentRoute,
  },
  {
    path: '/quotes',
    route: quoteRoute,
  },
  {
    path: '/notifications',
    route: notificationRoute,
  },
  {
    path: '/profile',
    route: profileRoute,
  },
  {
    path: '/appointments',
    route: appointmentRoute,
  },
  {
    path: '/conversations',
    route: conversationRoute,
  },

  {
    path: '/users',
    route: userRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;