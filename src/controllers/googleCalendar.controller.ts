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
  
  res.json(
    new ApiResponse(200, { authUrl }, 'Authorization URL generated')
  );
});

/**
 * Handle Google Calendar OAuth callback
 * @route GET /api/google-calendar/callback
 * @access Public (called by Google)
 */
const handleCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state } = req.query;
  
  if (!code || !state) {
    return res.redirect(`${process.env.FRONTEND_URL}/appointments?calendar_error=missing_params`);
  }

  try {
    const userId = state as string;
    
    // Exchange code for tokens
    const tokens = await googleCalendarService.getTokensFromCode(code as string);
    
    // Save tokens to user record
    await googleCalendarService.saveUserTokens(userId, tokens);
    
    // Set up webhook for calendar changes
    const channelId = uuidv4();
    try {
      await googleCalendarService.setupWebhook(userId, channelId);
      console.log('✅ Webhook set up successfully');
    } catch (error) {
      console.error('⚠️ Failed to set up webhook (non-critical):', error);
    }
    
    // Redirect back to frontend with success
    res.redirect(`${process.env.FRONTEND_URL}/appointments?calendar_connected=true`);
  } catch (error: any) {
    console.error('❌ OAuth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/appointments?calendar_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Check Google Calendar connection status
 * @route GET /api/google-calendar/status
 * @access Private
 */
const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  
  const tokens = await googleCalendarService.getUserTokens(userId);
  const connected = !!tokens;
  
  res.json(
    new ApiResponse(200, { connected }, 'Calendar status fetched')
  );
});

/**
 * Disconnect Google Calendar
 * @route POST /api/google-calendar/disconnect
 * @access Private
 */
const disconnect = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  
  await googleCalendarService.disconnectCalendar(userId);
  
  res.json(
    new ApiResponse(200, null, 'Google Calendar disconnected successfully')
  );
});

/**
 * Handle Google Calendar webhook notifications
 * @route POST /api/google-calendar/webhook
 * @access Public (called by Google) - Validated via middleware
 */
const handleWebhook = asyncHandler(async (req: Request, res: Response) => {
  // Extract Google Calendar notification headers
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

  // Acknowledge receipt immediately
  if (resourceState === 'sync') {
    console.log('ℹ️ Sync notification received');
    return res.status(200).send('OK');
  }

  // Process notification asynchronously (don't block response)
  if (resourceState === 'exists') {
    // Fire and forget - process in background
    googleCalendarService.processWebhookNotification(
      channelId,
      resourceState,
      resourceId
    ).catch(error => {
      console.error('❌ Error processing webhook notification:', error);
    });
  }

  // Always respond quickly to Google
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

  res.json(
    new ApiResponse(200, null, 'RSVP status synced successfully')
  );
});

/**
 * Manually sync all recent events
 * @route POST /api/google-calendar/sync-events
 * @access Private
 */
const syncEvents = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();

  await googleCalendarService.syncRecentEvents(userId);

  res.json(
    new ApiResponse(200, null, 'Events synced successfully')
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