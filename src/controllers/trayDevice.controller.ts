import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import {
  connectDevice,
  disconnectDevice,
  getTrayDeviceStatus,
  issueBootstrapCode,
  registerDeviceFromSession,
  revokeDeviceById,
} from '../services/trayDevice.service';
import type { ServiceFailure } from '../services/trayDevice.service';
import { isTrayDeviceAuthEnabledForUser, isTrayDeviceAuthKilled, sanitizeDeviceMeta } from '../utils/trayDevice.util';

const sendFailure = (res: Response, failure: ServiceFailure) => {
  res.status(failure.status).json({
    success: false,
    code: failure.code,
    message: failure.message,
    ...(failure.extra ?? {}),
  });
};

const sendFlagOff = (res: Response) => {
  const killed = isTrayDeviceAuthKilled();
  res.status(403).json({
    success: false,
    code: killed ? 'TRAY_DEVICE_AUTH_DISABLED' : 'TRAY_DEVICE_AUTH_OFF',
    message: killed ? 'Device sign-in is temporarily unavailable.' : 'Device sign-in is not enabled for this account.',
  });
};

const connect = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await connectDevice({
    deviceId: body.deviceId,
    deviceSecret: body.deviceSecret,
    bootstrapCode: body.bootstrapCode,
    confirmSwitch: body.confirmSwitch === true,
    preview: body.preview === true,
    meta: sanitizeDeviceMeta(body),
  });
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  if ('preview' in result) {
    res.json(new ApiResponse(200, { preview: result.preview }, 'Registration preview'));
    return;
  }
  res.json(
    new ApiResponse(
      200,
      {
        token: result.token,
        user: result.user,
        ...(result.credentials && { credentials: result.credentials }),
        ...(result.registered && { registered: true }),
        ...(result.switched && { switched: true }),
      },
      'Tray session issued',
    ),
  );
});

const disconnect = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const outcome = await disconnectDevice(body.deviceId, body.deviceSecret);
  if (outcome === 'unknown') {
    sendFailure(res, { ok: false, status: 401, code: 'DEVICE_UNKNOWN', message: 'This computer is not registered.' });
    return;
  }
  res.json(new ApiResponse(200, { disconnected: true }, 'Computer disconnected'));
});

const status = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  if (!isTrayDeviceAuthEnabledForUser(user)) {
    sendFlagOff(res);
    return;
  }
  res.json(new ApiResponse(200, await getTrayDeviceStatus(user._id), 'Tray device status fetched'));
});

const bootstrap = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  if (!isTrayDeviceAuthEnabledForUser(user)) {
    sendFlagOff(res);
    return;
  }
  res.json(new ApiResponse(200, await issueBootstrapCode(user), 'Bootstrap code issued'));
});

const registerSession = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  if (!isTrayDeviceAuthEnabledForUser(user)) {
    sendFlagOff(res);
    return;
  }
  const credentials = await registerDeviceFromSession(user, sanitizeDeviceMeta(req.body));
  res.json(new ApiResponse(200, { credentials }, 'Computer registered'));
});

const revoke = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const outcome = await revokeDeviceById(String(req.params.deviceId), {
    id: user._id,
    role: user.role,
    organizationId: user.organizationId,
  });
  if (outcome === 'not_found') throw new ApiError(404, 'Computer not found');
  if (outcome === 'forbidden') throw new ApiError(403, 'You cannot disconnect this computer');
  res.json(new ApiResponse(200, { revoked: true }, 'Computer disconnected'));
});

export default { connect, disconnect, status, bootstrap, registerSession, revoke };
