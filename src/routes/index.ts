import express from 'express';
import authRoute from './auth.route';
import vehicleRoute from './vehicle.route';
import dashboardRoute from './dashboard.route';
import myWorkRoute from './mywork.route';

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
    path: '/my-work',
    route: myWorkRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;
