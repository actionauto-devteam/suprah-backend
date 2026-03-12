import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import googleCalendarService from '../services/googleCalendar.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';
import { v4 as uuidv4 } from 'uuid';

/**
 * Initiate Google Calendar OAuth flow
 * @route GET /api/google-calendar/auth
 * @access Private
 */
const initiateAuth = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const authUrl = googleCalendarService.getAuthUrl(userId);
  res.json(new ApiResponse(200, { authUrl }, 'Authorization URL generated'));
});

/**
 * Handle Google Calendar OAuth callback
 * @route GET /api/google-calendar/callback
 * @access Public (called by Google)
 */
const handleCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/appointments?calendar_error=missing_params`
    );
  }

  try {
    const userId = state as string;

    // Exchange code for tokens
    const tokens = await googleCalendarService.getTokensFromCode(code as string);

    // Save tokens — refresh_token is preserved if not returned again
    await googleCalendarService.saveUserTokens(userId, tokens);

    // Set up webhook for real-time calendar changes (non-critical)
    const channelId = uuidv4();
    try {
      await googleCalendarService.setupWebhook(userId, channelId);
      console.log('✅ Webhook set up successfully');
    } catch (error) {
      console.error('⚠️ Failed to set up webhook (non-critical):', error);
    }

    res.redirect(`${process.env.FRONTEND_URL}/appointments?calendar_connected=true`);
  } catch (error: any) {
    console.error('❌ OAuth callback error:', error);
    res.redirect(
      `${process.env.FRONTEND_URL}/appointments?calendar_error=${encodeURIComponent(
        error.message
      )}`
    );
  }
});

/**
 * Check Google Calendar connection status
 * @route GET /api/google-calendar/status
 * @access Private
 */
const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();

  // FIX: Use isGoogleCalendarConnected which also validates refresh_token presence
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
 * Manually sync recent events from Google Calendar
 * @route POST /api/google-calendar/sync-events
 * @access Private
 */
const syncEvents = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const syncedAppointments = await googleCalendarService.syncRecentEvents(userId);

  // FIX: Return syncedAppointments count so the frontend can display it
  res.json(
    new ApiResponse(
      200,
      { syncedAppointments },
      `Successfully synced ${syncedAppointments} events`
    )
  );
});

export default {
  initiateAuth,
  handleCallback,
  getStatus,
  disconnect,
  handleWebhook,
  syncRSVPStatus,
  syncEvents,
};