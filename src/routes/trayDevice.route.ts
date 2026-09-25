import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import trayDeviceController from '../controllers/trayDevice.controller';
import {
  trayDeviceBootstrapLimiter,
  trayDeviceConnectIpLimiter,
  trayDeviceConnectLimiter,
} from '../middleware/rate-limit.middleware';

const router = express.Router();

router.post('/connect', trayDeviceConnectIpLimiter, trayDeviceConnectLimiter, trayDeviceController.connect);
router.post('/disconnect', trayDeviceConnectIpLimiter, trayDeviceConnectLimiter, trayDeviceController.disconnect);

router.use(crmAuth());

router.get('/status', trayDeviceController.status);
router.post('/bootstrap', trayDeviceBootstrapLimiter, trayDeviceController.bootstrap);
router.post('/register-session', trayDeviceBootstrapLimiter, trayDeviceController.registerSession);
router.post('/:deviceId/revoke', trayDeviceController.revoke);

export default router;
