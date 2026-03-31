import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import googleCalendarService from '../services/googleCalendar.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';

/**
 * Check Google Calendar connection status
 * @route GET /api/google-calendar/status
 * @access Private
 */
const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const connected = await googleCalendarService.isGoogleCalendarConnected(userId);
  res.json(new ApiResponse(200, { connected }, 'Calendar status fetched'));
});

/**
 * Disconnect Google Calendar
 * @route POST /api/google-calendar/disconnect
 * @access Private
 */
const disconnect = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  await googleCalendarService.disconnectCalendar(userId);
  res.json(new ApiResponse(200, null, 'Google Calendar disconnected successfully'));
});

/**
 * Handle Google Calendar webhook notifications
 * @route POST /api/google-calendar/webhook
 * @access Public (validated via middleware)
 */
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

  // Acknowledge sync notifications immediately
  if (resourceState === 'sync') {
    console.log('ℹ️ Sync notification received');
    return res.status(200).send('OK');
  }

  // Process in background — don't block Google's delivery timeout
  if (resourceState === 'exists') {
    googleCalendarService
      .processWebhookNotification(channelId, resourceState, resourceId)
      .catch((error) => {
        console.error('❌ Error processing webhook notification:', error);
      });
  }

  // Always respond quickly
  res.status(200).send('OK');
});

/**
 * Manually trigger RSVP sync for an appointment
 * @route POST /api/google-calendar/sync-rsvp/:appointmentId
 * @access Private
 */
const syncRSVPStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const { appointmentId } = req.params;
  await googleCalendarService.updateRSVPStatusFromGoogle(appointmentId, userId);
  res.json(new ApiResponse(200, null, 'RSVP status synced successfully'));
});

/**
 * Manually sync ALL events from Google Calendar (full paginated sync).
 * @route POST /api/google-calendar/sync-events
 * @access Private
 */
const syncEvents = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const syncedAppointments = await googleCalendarService.syncAllEvents(userId);

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