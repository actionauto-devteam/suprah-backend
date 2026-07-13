import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import googleCalendarService from '../services/googleCalendar.service';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';

const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const connected = await googleCalendarService.isGoogleCalendarConnected(userId);
  res.json(new ApiResponse(200, { connected }, 'Calendar status fetched'));
});

const disconnect = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  await googleCalendarService.disconnectCalendar(userId);
  res.json(new ApiResponse(200, null, 'Google Calendar disconnected successfully'));
});

const handleWebhook = asyncHandler(async (req: Request, res: Response) => {
  const channelId = req.headers['x-goog-channel-id'] as string;
  const resourceState = req.headers['x-goog-resource-state'] as string;
  const resourceId = req.headers['x-goog-resource-id'] as string;
  const channelExpiration = req.headers['x-goog-channel-expiration'] as string;

  console.log('📨 Received Google Calendar webhook:', {
    channelId,
    resourceState,
    resourceId,
    channelExpiration,
  });

  if (resourceState === 'sync') {
    console.log('ℹ️ Sync notification received');
    return res.status(200).send('OK');
  }

  if (resourceState === 'exists') {
    googleCalendarService
      .processWebhookNotification(channelId, resourceState, resourceId)
      .catch((error) => {
        console.error('❌ Error processing webhook notification:', error);
      });
  }

  res.status(200).send('OK');
});

const syncRSVPStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { appointmentId } = req.params;
  const orgId = user.organizationId?.toString();
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  
  const target = { type: 'org' as const, id: orgId };
  await googleCalendarService.updateRSVPStatusFromGoogle(appointmentId, target);
  res.json(new ApiResponse(200, null, 'RSVP status synced successfully'));
});

const syncEvents = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const orgId = user.organizationId?.toString();
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  
  const syncedAppointments = await googleCalendarService.syncAllEvents(orgId, user._id.toString());

  res.json(
    new ApiResponse(
      200,
      { syncedAppointments },
      `Successfully synced ${syncedAppointments} events`
    )
  );
});

export default {
  getStatus,
  disconnect,
  handleWebhook,
  syncRSVPStatus,
  syncEvents,
};