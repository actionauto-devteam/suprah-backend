import mongoose, { Schema } from 'mongoose';
import { google, calendar_v3 } from 'googleapis';
import User from '../models/User.model';
import Appointment from '../models/Appointment.model';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';
import { IAppointment } from '../models/Appointment.model';

interface IUserWithGoogleCalendar extends IUser {
  googleCalendar?: {
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    connected: boolean;
    watchChannelId?: string;
    watchResourceId?: string;
    watchExpiration?: Date;
  };
  organizationId?: mongoose.Types.ObjectId;
}

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

// How far back and forward to sync (in years)
const SYNC_PAST_YEARS = 1;
const SYNC_FUTURE_YEARS = 2;

// Maximum pages to fetch to avoid infinite loops (2500 events/page × 20 pages = 50,000 events)
const MAX_PAGES = 20;

class GoogleCalendarService {
  /**
   * Get authorization URL for OAuth
   * prompt: 'consent' forces Google to always return a refresh_token
   */
  getAuthUrl(userId: string): string {
    const oauth2Client = this.createOAuthClient();

    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ];

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state: userId,
    });
  }

  /**
   * Create a fresh OAuth2 client per-request to avoid shared singleton race conditions
   */
  private createOAuthClient() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  /**
   * Get tokens from authorization code
   */
  async getTokensFromCode(code: string): Promise<GoogleTokens> {
    try {
      const oauth2Client = this.createOAuthClient();
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.access_token) {
        throw new ApiError(400, 'No access token returned from Google');
      }

      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? undefined,
        expiry_date: tokens.expiry_date ?? undefined,
        scope: tokens.scope ?? undefined,
        token_type: tokens.token_type ?? undefined,
      };
    } catch (error) {
      console.error('Failed to get tokens from code:', error);
      throw new ApiError(400, 'Failed to exchange authorization code for tokens');
    }
  }

  /**
   * Save user tokens to database.
   * Only overwrites refresh_token if a new one is actually returned,
   * preventing wiping out a valid existing refresh_token.
   */
  async saveUserTokens(userId: string, tokens: GoogleTokens): Promise<void> {
    try {
      const updateFields: Record<string, any> = {
        'googleCalendar.accessToken': tokens.access_token,
        'googleCalendar.expiryDate': tokens.expiry_date,
        'googleCalendar.connected': true,
        'googleCalendar.connectedAt': new Date(),
      };

      if (tokens.refresh_token) {
        updateFields['googleCalendar.refreshToken'] = tokens.refresh_token;
      }

      await User.findByIdAndUpdate(userId, { $set: updateFields });
      console.log(`Saved Google Calendar tokens for user ${userId}`);
    } catch (error) {
      console.error('Failed to save user tokens:', error);
      throw new ApiError(500, 'Failed to save calendar credentials');
    }
  }

  /**
   * Get user tokens from database
   */
  async getUserTokens(userId: string): Promise<GoogleTokens | null> {
    try {
      const user = (await User.findById(userId).select(
        'googleCalendar'
      )) as IUserWithGoogleCalendar | null;

      if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
        return null;
      }

      return {
        access_token: user.googleCalendar.accessToken,
        refresh_token: user.googleCalendar.refreshToken,
        expiry_date: user.googleCalendar.expiryDate,
      };
    } catch (error) {
      console.error('Failed to get user tokens:', error);
      return null;
    }
  }

  /**
   * Get authorized calendar client for a user.
   * Creates a fresh OAuth2 client per call to avoid shared singleton race conditions.
   * Guards against a missing refresh_token and marks user as disconnected so the
   * frontend can prompt reconnection.
   */
  private async getCalendarClient(userId: string): Promise<calendar_v3.Calendar> {
    const user = (await User.findById(userId).select(
      'googleCalendar'
    )) as IUserWithGoogleCalendar | null;

    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      throw new ApiError(401, 'Google Calendar not connected');
    }

    if (!user.googleCalendar.refreshToken) {
      await User.findByIdAndUpdate(userId, {
        $set: { 'googleCalendar.connected': false },
      });
      throw new ApiError(
        401,
        'Google Calendar requires reconnection. Please disconnect and reconnect your calendar.'
      );
    }

    const oauth2Client = this.createOAuthClient();

    oauth2Client.setCredentials({
      access_token: user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date: user.googleCalendar.expiryDate,
    });

    // Persist refreshed tokens when Google auto-rotates them
    oauth2Client.on('tokens', async (tokens: any) => {
      const update: Record<string, any> = {
        'googleCalendar.expiryDate': tokens.expiry_date,
      };
      if (tokens.access_token) {
        update['googleCalendar.accessToken'] = tokens.access_token;
      }
      if (tokens.refresh_token) {
        update['googleCalendar.refreshToken'] = tokens.refresh_token;
      }
      await User.findByIdAndUpdate(userId, { $set: update });
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  /**
   * Check if Google Calendar is connected
   */
  async isGoogleCalendarConnected(userId: string): Promise<boolean> {
    try {
      const user = (await User.findById(userId).select(
        'googleCalendar'
      )) as IUserWithGoogleCalendar | null;
      return !!(
        user?.googleCalendar?.connected &&
        user.googleCalendar.accessToken &&
        user.googleCalendar.refreshToken
      );
    } catch (error) {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CORE: Full paginated fetch with recurring-event and timezone support
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch ALL Google Calendar events for the configured window using cursor-based
   * pagination (nextPageToken).  Handles:
   *   - Recurring event expansions (singleEvents: true)
   *   - Cancelled / deleted instances  (showDeleted: true)
   *   - All-day events (date-only ISO strings)
   *   - Any timezone — Google normalises to UTC in dateTime fields
   *
   * Returns the raw event list so callers can do their own upsert logic.
   */
  private async fetchAllEventsFromGoogle(
    calendar: calendar_v3.Calendar,
    timeMin: Date,
    timeMax: Date
  ): Promise<calendar_v3.Schema$Event[]> {
    const allEvents: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined;
    let page = 0;

    console.log(
      `📅 Fetching Google Calendar events from ${timeMin.toISOString()} to ${timeMax.toISOString()}`
    );

    do {
      page++;
      if (page > MAX_PAGES) {
        console.warn(
          `⚠️  Reached MAX_PAGES (${MAX_PAGES}) — stopping pagination to avoid runaway loop`
        );
        break;
      }

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: 2500,       // maximum Google allows per page
        singleEvents: true,     // expand recurring events into individual instances
        showDeleted: true,      // include cancelled/deleted instances so we can cancel them locally
        orderBy: 'startTime',
        pageToken,
      });

      const items = response.data.items ?? [];
      allEvents.push(...items);

      pageToken = response.data.nextPageToken ?? undefined;

      console.log(
        `  Page ${page}: fetched ${items.length} events (total so far: ${allEvents.length})${
          pageToken ? ', more pages pending…' : ', done.'
        }`
      );
    } while (pageToken);

    console.log(`✅ Total events fetched from Google: ${allEvents.length}`);
    return allEvents;
  }

  /**
   * Normalise a Google Calendar event's start/end to JS Date objects.
   * Google uses dateTime (with tz offset) for timed events and date (YYYY-MM-DD)
   * for all-day events.  We treat all-day events as starting at 00:00 UTC on
   * that date and ending at 23:59:59 UTC on the end date (Google's end date is
   * exclusive, so we subtract one second).
   */
  private parseEventTimes(
    event: calendar_v3.Schema$Event
  ): { startTime: Date; endTime: Date } | null {
    const rawStart = event.start?.dateTime ?? event.start?.date;
    const rawEnd   = event.end?.dateTime   ?? event.end?.date;

    if (!rawStart || !rawEnd) return null;

    // All-day events use date-only strings (YYYY-MM-DD)
    const isAllDay = !event.start?.dateTime;

    let startTime: Date;
    let endTime: Date;

    if (isAllDay) {
      // Parse as local-midnight UTC to avoid day-shifting
      const [sy, sm, sd] = rawStart.split('-').map(Number);
      startTime = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0));

      // Google's all-day end is exclusive (next day), so subtract 1 ms
      const [ey, em, ed] = rawEnd.split('-').map(Number);
      endTime = new Date(Date.UTC(ey, em - 1, ed, 0, 0, 0) - 1);
    } else {
      startTime = new Date(rawStart);
      endTime   = new Date(rawEnd);
    }

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return null;

    return { startTime, endTime };
  }

  /**
   * Fetch all Google Calendar events and upsert into the local database.
   * This is the authoritative "full sync" that the webhook and manual sync both call.
   */
  async fetchAllGoogleCalendarEvents(userId: string, orgId: string): Promise<number> {
    const calendar = await this.getCalendarClient(userId);
    const user     = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    const timeMin = new Date();
    timeMin.setFullYear(timeMin.getFullYear() - SYNC_PAST_YEARS);

    const timeMax = new Date();
    timeMax.setFullYear(timeMax.getFullYear() + SYNC_FUTURE_YEARS);

    const events = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax);

    let syncedCount = 0;

    for (const event of events) {
      try {
        await this.upsertEventToLocalDB(event, user as any, orgId, userId);
        syncedCount++;
      } catch (err) {
        console.error(`Failed to upsert event ${event.id} (${event.summary}):`, err);
      }
    }

    console.log(`✅ Full sync complete: processed ${syncedCount}/${events.length} events`);
    return syncedCount;
  }

  /**
   * Upsert a single Google Calendar event into the local appointments collection.
   * Handles cancellation of deleted/cancelled recurring instances.
   */
  private async upsertEventToLocalDB(
    event: calendar_v3.Schema$Event,
    user: any,
    organizationId: string,
    userId: string
  ): Promise<void> {
    if (!event.id) return;

    const existing = await Appointment.findOne({ googleCalendarEventId: event.id });

    // ── Handle deleted / cancelled events ──────────────────────────────────
    if (event.status === 'cancelled') {
      if (existing && existing.status !== 'cancelled') {
        existing.status = 'cancelled';
        existing.lastSyncedAt = new Date();
        await existing.save();
        console.log(`🗑  Marked cancelled: ${event.summary ?? event.id}`);
      }
      return;
    }

    // ── Parse times (skip events with no valid times) ───────────────────────
    const times = this.parseEventTimes(event);
    if (!times) {
      console.log(`⏭  Skipping event with no valid times: ${event.summary}`);
      return;
    }

    const { startTime, endTime } = times;

    // ── Derive entry type from title keywords ───────────────────────────────
    const titleLower = (event.summary ?? '').toLowerCase();
    let entryType: 'event' | 'task' | 'reminder' | 'appointment' = 'event';
    if (titleLower.includes('task'))                                                    entryType = 'task';
    else if (titleLower.includes('reminder'))                                           entryType = 'reminder';
    else if (titleLower.includes('appointment') || titleLower.includes('meeting'))      entryType = 'appointment';

    // ── Derive meeting type ─────────────────────────────────────────────────
    let type: 'in-person' | 'phone' | 'video' | 'other' = 'other';
    if (event.hangoutLink || event.conferenceData)   type = 'video';
    else if (event.location)                         type = 'in-person';

    const meetingLink =
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.[0]?.uri ??
      '';

    if (existing) {
      // ── UPDATE ────────────────────────────────────────────────────────────
      existing.title        = event.summary     ?? existing.title;
      existing.description  = event.description ?? existing.description;
      existing.startTime    = startTime;
      existing.endTime      = endTime;
      existing.location     = event.location    ?? existing.location ?? '';
      existing.meetingLink  = meetingLink        || existing.meetingLink;
      existing.lastSyncedAt = new Date();
      // Only upgrade status if Google says it's now cancelled
      if (event.status === 'cancelled') existing.status = 'cancelled';

      await existing.save();
    } else {
      // ── CREATE ────────────────────────────────────────────────────────────
      await Appointment.create({
        title:                  event.summary ?? 'Untitled Event',
        description:            event.description ?? '',
        startTime,
        endTime,
        location:               event.location ?? '',
        type,
        entryType,
        status:                 'scheduled',
        createdBy:              user._id,
        organizationId,
        participants:           [user._id],
        guestEmails:            [],
        googleCalendarEventId:  event.id,
        syncedWithGoogleCalendar: true,
        lastSyncedAt:           new Date(),
        meetingLink,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC SYNC METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Full sync — fetches PAST_YEARS back and FUTURE_YEARS forward, paginating
   * through all result pages.  Called by:
   *   - The "Sync Calendar" button (syncEvents controller action)
   *   - Webhook notifications (processWebhookNotification)
   */
  async syncAllEvents(userId: string): Promise<number> {
    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    const orgId = (user as any).organizationId?.toString() ?? '';
    return this.fetchAllGoogleCalendarEvents(userId, orgId);
  }

  /**
   * Recent sync — last 30 days + next 90 days with full pagination.
   * Kept for backward compat and lighter on-demand refreshes.
   * Now also uses the paginated helper so no events are missed.
   */
  async syncRecentEvents(userId: string): Promise<number> {
    const calendar = await this.getCalendarClient(userId);
    const user     = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    const orgId = (user as any).organizationId?.toString() ?? '';

    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - 30);   // 30 days back

    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 90);   // 90 days forward

    const events = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax);

    let syncedCount = 0;
    for (const event of events) {
      try {
        await this.upsertEventToLocalDB(event, user as any, orgId, userId);
        syncedCount++;
      } catch (err) {
        console.error(`Failed to upsert event ${event.id}:`, err);
      }
    }

    console.log(`✅ Recent sync complete: processed ${syncedCount}/${events.length} events`);
    return syncedCount;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // OUTBOUND SYNC (local → Google Calendar)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sync a local appointment to Google Calendar
   */
  async syncAppointmentToGoogleCalendar(
    appointment: IAppointment,
    userId: string
  ): Promise<string | null> {
    try {
      const calendar = await this.getCalendarClient(userId);

      const eventData: calendar_v3.Schema$Event = {
        summary:     appointment.title,
        description: this.buildEventDescription(appointment),
        start: {
          dateTime: appointment.startTime.toISOString(),
          timeZone: 'UTC',
        },
        end: {
          dateTime: appointment.endTime.toISOString(),
          timeZone: 'UTC',
        },
        location:       appointment.location || undefined,
        conferenceData:
          appointment.type === 'video' && appointment.meetingLink
            ? {
                entryPoints: [
                  {
                    entryPointType: 'video',
                    uri: appointment.meetingLink,
                  },
                ],
              }
            : undefined,
      };

      let response;

      if (appointment.googleCalendarEventId) {
        response = await calendar.events.update({
          calendarId: 'primary',
          eventId:    appointment.googleCalendarEventId,
          requestBody: eventData,
          sendUpdates: 'all',
        });
        console.log(`Updated Google Calendar event: ${appointment.title}`);
      } else {
        response = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: eventData,
          sendUpdates: 'all',
        });
        console.log(`Created Google Calendar event: ${appointment.title}`);

        await Appointment.findByIdAndUpdate(appointment._id, {
          googleCalendarEventId:    response.data.id,
          syncedWithGoogleCalendar: true,
          lastSyncedAt:             new Date(),
        });
      }

      await this.syncToParticipantsCalendars(appointment);

      return response.data.id ?? null;
    } catch (error: any) {
      console.error('Failed to sync to Google Calendar:', error.message);
      return null;
    }
  }

  /**
   * Sync appointment to all participants' Google Calendars
   */
  private async syncToParticipantsCalendars(appointment: IAppointment) {
    for (const participantId of appointment.participants) {
      try {
        if (participantId.toString() === appointment.createdBy.toString()) continue;

        const participant = await User.findById(participantId).select('googleCalendar');
        if (
          !participant ||
          !(participant as IUserWithGoogleCalendar).googleCalendar?.connected
        ) {
          console.log(`Skipping participant ${participantId} — Google Calendar not connected`);
          continue;
        }

        await this.syncAppointmentToGoogleCalendar(appointment, participantId.toString());
      } catch (error) {
        console.error(`Failed to sync to participant ${participantId}:`, error);
      }
    }
  }

  /**
   * Delete event from Google Calendar
   */
  async deleteFromGoogleCalendar(eventId: string, userId: string): Promise<void> {
    try {
      const calendar = await this.getCalendarClient(userId);
      await calendar.events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'all',
      });
      console.log(`Deleted Google Calendar event: ${eventId}`);
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build a rich event description from a local appointment
   */
  private buildEventDescription(appointment: IAppointment): string {
    let description = appointment.description || '';

    if (appointment.notes) {
      description += `\n\nNotes:\n${appointment.notes}`;
    }

    description += `\n\n--- Appointment Details ---`;
    description += `\nType: ${
      appointment.entryType.charAt(0).toUpperCase() + appointment.entryType.slice(1)
    }`;
    description += `\nMeeting Type: ${appointment.type}`;

    if (appointment.meetingLink) {
      description += `\n\nJoin Meeting: ${appointment.meetingLink}`;
    }

    if (appointment.customerBooking) {
      description += `\n\n--- Customer Information ---`;
      description += `\nName: ${appointment.customerBooking.firstName} ${appointment.customerBooking.lastName}`;
      description += `\nEmail: ${appointment.customerBooking.email}`;
      description += `\nPhone: ${appointment.customerBooking.phone}`;
    }

    description += `\n\nManage: ${process.env.FRONTEND_URL}/appointments`;

    return description.trim();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CALENDAR MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Disconnect Google Calendar
   */
  async disconnectCalendar(userId: string): Promise<void> {
    try {
      const user = (await User.findById(userId).select(
        'googleCalendar'
      )) as IUserWithGoogleCalendar | null;

      if (user?.googleCalendar?.watchChannelId && user?.googleCalendar?.watchResourceId) {
        try {
          const calendar = await this.getCalendarClient(userId);
          await calendar.channels.stop({
            requestBody: {
              id:         user.googleCalendar.watchChannelId,
              resourceId: user.googleCalendar.watchResourceId,
            },
          });
          console.log('Stopped webhook channel');
        } catch (error) {
          console.error('Failed to stop webhook channel (non-critical):', error);
        }
      }

      await User.findByIdAndUpdate(userId, { $unset: { googleCalendar: 1 } });
      console.log(`Disconnected Google Calendar for user ${userId}`);
    } catch (error) {
      console.error('Failed to disconnect calendar:', error);
      throw new ApiError(500, 'Failed to disconnect calendar');
    }
  }

  /**
   * Setup webhook for calendar changes
   */
  async setupWebhook(userId: string, channelId: string): Promise<void> {
    try {
      const calendar   = await this.getCalendarClient(userId);
      const webhookUrl = `${process.env.BACKEND_URL}/api/google-calendar/webhook`;

      const response = await calendar.events.watch({
        calendarId: 'primary',
        requestBody: {
          id:      channelId,
          type:    'web_hook',
          address: webhookUrl,
          params:  { ttl: '604800' },
        },
      });

      await User.findByIdAndUpdate(userId, {
        $set: {
          'googleCalendar.watchChannelId':  channelId,
          'googleCalendar.watchResourceId': response.data.resourceId,
          'googleCalendar.watchExpiration': new Date(Date.now() + 604800000),
        },
      });

      console.log(`Set up webhook for user ${userId}, channel ${channelId}`);
    } catch (error) {
      console.error('Failed to set up webhook:', error);
      throw new ApiError(500, 'Failed to set up calendar notifications');
    }
  }

  /**
   * Process webhook notification — triggers a full sync for the affected user
   */
  async processWebhookNotification(
    channelId: string,
    resourceState: string,
    resourceId: string
  ): Promise<void> {
    try {
      console.log('Processing webhook:', { channelId, resourceState, resourceId });

      const user = (await User.findOne({
        'googleCalendar.watchChannelId': channelId,
      })) as IUserWithGoogleCalendar | null;

      if (!user) {
        console.log('No user found for channel:', channelId);
        return;
      }

      if (resourceState === 'sync') {
        console.log('Sync message received, ignoring');
        return;
      }

      if (resourceState === 'exists') {
        // Use the full paginated sync so webhook-triggered updates are also complete
        await this.fetchAllGoogleCalendarEvents(
          user._id.toString(),
          user.organizationId?.toString() ?? ''
        );
      }
    } catch (error) {
      console.error('Failed to process webhook notification:', error);
    }
  }

  /**
   * Update RSVP status from Google Calendar
   */
  async updateRSVPStatusFromGoogle(appointmentId: string, userId: string): Promise<void> {
    try {
      const appointment = await Appointment.findById(appointmentId);

      if (!appointment || !appointment.googleCalendarEventId) {
        throw new ApiError(
          404,
          'Appointment not found or not synced with Google Calendar'
        );
      }

      const calendar = await this.getCalendarClient(userId);

      const event = await calendar.events.get({
        calendarId: 'primary',
        eventId:    appointment.googleCalendarEventId,
      });

      if (event.data.attendees) {
        const user      = await User.findById(userId);
        const userEmail = user?.email;
        const attendee  = event.data.attendees.find((a) => a.email === userEmail);

        if (attendee?.responseStatus) {
          console.log(`RSVP status for ${userEmail}: ${attendee.responseStatus}`);
        }
      }

      await appointment.save();
    } catch (error) {
      console.error('Error updating RSVP status from Google:', error);
      throw error;
    }
  }

  /**
   * Renew webhook subscription
   */
  async renewWebhook(userId: string): Promise<void> {
    try {
      const user = (await User.findById(userId).select(
        'googleCalendar'
      )) as IUserWithGoogleCalendar | null;

      if (!user?.googleCalendar?.watchChannelId) {
        console.log('No existing webhook to renew');
        return;
      }

      try {
        const calendar = await this.getCalendarClient(userId);
        await calendar.channels.stop({
          requestBody: {
            id:         user.googleCalendar.watchChannelId,
            resourceId: user.googleCalendar.watchResourceId ?? '',
          },
        });
      } catch (error) {
        console.log('Failed to stop old channel (non-critical):', error);
      }

      const newChannelId = `${userId}_${Date.now()}`;
      await this.setupWebhook(userId, newChannelId);

      console.log(`Renewed webhook for user ${userId}`);
    } catch (error) {
      console.error('Failed to renew webhook:', error);
      throw error;
    }
  }
}

export default new GoogleCalendarService();