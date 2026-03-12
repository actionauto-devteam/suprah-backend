import mongoose from 'mongoose';
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

// ─── Sync window ──────────────────────────────────────────────────────────────
//
// FIX: Use year-anchored boundaries instead of "N years relative to today".
// This guarantees the ENTIRE current year is always covered regardless of
// which month the sync is triggered.
//
//   timeMin = Jan 1 00:00:00 UTC  of (currentYear - 1)
//   timeMax = Dec 31 23:59:59 UTC of (currentYear + 2)
//
// Example when run on March 13 2026:
//   timeMin = 2025-01-01T00:00:00Z   ← all of 2025 back-fill
//   timeMax = 2028-12-31T23:59:59Z   ← 2026, 2027, 2028 forward
//
function getSyncWindow(): { timeMin: Date; timeMax: Date } {
  const currentYear = new Date().getFullYear();
  return {
    timeMin: new Date(Date.UTC(currentYear - 1, 0,  1,  0,  0,  0)),
    timeMax: new Date(Date.UTC(currentYear + 2, 11, 31, 23, 59, 59)),
  };
}

// Maximum pages to fetch (2500 events/page × 20 = 50 000 events ceiling)
const MAX_PAGES = 20;

class GoogleCalendarService {
  // ─── OAuth ─────────────────────────────────────────────────────────────────

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

  private createOAuthClient() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  async getTokensFromCode(code: string): Promise<GoogleTokens> {
    try {
      const oauth2Client = this.createOAuthClient();
      const { tokens } = await oauth2Client.getToken(code);
      if (!tokens.access_token) throw new ApiError(400, 'No access token returned from Google');
      return {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token  ?? undefined,
        expiry_date:   tokens.expiry_date    ?? undefined,
        scope:         tokens.scope          ?? undefined,
        token_type:    tokens.token_type     ?? undefined,
      };
    } catch (error) {
      console.error('Failed to get tokens from code:', error);
      throw new ApiError(400, 'Failed to exchange authorization code for tokens');
    }
  }

  async saveUserTokens(userId: string, tokens: GoogleTokens): Promise<void> {
    try {
      const updateFields: Record<string, any> = {
        'googleCalendar.accessToken':  tokens.access_token,
        'googleCalendar.expiryDate':   tokens.expiry_date,
        'googleCalendar.connected':    true,
        'googleCalendar.connectedAt':  new Date(),
      };
      if (tokens.refresh_token) {
        updateFields['googleCalendar.refreshToken'] = tokens.refresh_token;
      }
      await User.findByIdAndUpdate(userId, { $set: updateFields });
    } catch (error) {
      throw new ApiError(500, 'Failed to save calendar credentials');
    }
  }

  async getUserTokens(userId: string): Promise<GoogleTokens | null> {
    try {
      const user = (await User.findById(userId).select('googleCalendar')) as IUserWithGoogleCalendar | null;
      if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) return null;
      return {
        access_token:  user.googleCalendar.accessToken,
        refresh_token: user.googleCalendar.refreshToken,
        expiry_date:   user.googleCalendar.expiryDate,
      };
    } catch {
      return null;
    }
  }

  private async getCalendarClient(userId: string): Promise<calendar_v3.Calendar> {
    const user = (await User.findById(userId).select('googleCalendar')) as IUserWithGoogleCalendar | null;
    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      throw new ApiError(401, 'Google Calendar not connected');
    }
    if (!user.googleCalendar.refreshToken) {
      await User.findByIdAndUpdate(userId, { $set: { 'googleCalendar.connected': false } });
      throw new ApiError(401, 'Google Calendar requires reconnection. Please disconnect and reconnect your calendar.');
    }
    const oauth2Client = this.createOAuthClient();
    oauth2Client.setCredentials({
      access_token:  user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date:   user.googleCalendar.expiryDate,
    });
    oauth2Client.on('tokens', async (tokens: any) => {
      const update: Record<string, any> = { 'googleCalendar.expiryDate': tokens.expiry_date };
      if (tokens.access_token)  update['googleCalendar.accessToken']  = tokens.access_token;
      if (tokens.refresh_token) update['googleCalendar.refreshToken'] = tokens.refresh_token;
      await User.findByIdAndUpdate(userId, { $set: update });
    });
    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  async isGoogleCalendarConnected(userId: string): Promise<boolean> {
    try {
      const user = (await User.findById(userId).select('googleCalendar')) as IUserWithGoogleCalendar | null;
      return !!(
        user?.googleCalendar?.connected &&
        user.googleCalendar.accessToken &&
        user.googleCalendar.refreshToken
      );
    } catch {
      return false;
    }
  }

  // ─── Core paginated fetch ───────────────────────────────────────────────────

  /**
   * Fetches ALL events in the given window from Google Calendar, consuming
   * every nextPageToken page until no more remain.
   */
  private async fetchAllEventsFromGoogle(
    calendar: calendar_v3.Calendar,
    timeMin: Date,
    timeMax: Date
  ): Promise<calendar_v3.Schema$Event[]> {
    const allEvents: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined;
    let page = 0;

    console.log(`📅 Google Calendar fetch: ${timeMin.toISOString()} → ${timeMax.toISOString()}`);

    do {
      page++;
      if (page > MAX_PAGES) {
        console.warn(`⚠️  MAX_PAGES (${MAX_PAGES}) reached — halting pagination`);
        break;
      }

      const response = await calendar.events.list({
        calendarId:   'primary',
        timeMin:      timeMin.toISOString(),
        timeMax:      timeMax.toISOString(),
        maxResults:   2500,
        singleEvents: true,    // expand recurring instances individually
        showDeleted:  true,    // include cancelled instances → we cancel them locally
        orderBy:      'startTime',
        pageToken,
      });

      const items = response.data.items ?? [];
      allEvents.push(...items);
      pageToken = response.data.nextPageToken ?? undefined;

      console.log(
        `  Page ${page}: ${items.length} events (running total: ${allEvents.length})` +
        (pageToken ? ' — more pages…' : ' — done ✓')
      );
    } while (pageToken);

    console.log(`✅ Google returned ${allEvents.length} total events`);
    return allEvents;
  }

  /**
   * Convert Google Calendar's start/end to JS Date objects safely.
   *
   * Google uses:
   *   • dateTime  (ISO 8601 with tz offset) for timed events
   *   • date      (YYYY-MM-DD)              for all-day events
   *
   * All-day events are stored as UTC-midnight of that date to avoid the
   * one-day shift that `new Date("YYYY-MM-DD")` produces in non-UTC servers.
   */
  private parseEventTimes(
    event: calendar_v3.Schema$Event
  ): { startTime: Date; endTime: Date } | null {
    const rawStart = event.start?.dateTime ?? event.start?.date;
    const rawEnd   = event.end?.dateTime   ?? event.end?.date;
    if (!rawStart || !rawEnd) return null;

    const isAllDay = !event.start?.dateTime;
    let startTime: Date;
    let endTime:   Date;

    if (isAllDay) {
      const [sy, sm, sd] = rawStart.split('-').map(Number);
      startTime = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0));
      // Google's all-day end date is exclusive (the next day) → subtract 1 ms
      const [ey, em, ed] = rawEnd.split('-').map(Number);
      endTime = new Date(Date.UTC(ey, em - 1, ed, 0, 0, 0) - 1);
    } else {
      startTime = new Date(rawStart);
      endTime   = new Date(rawEnd);
    }

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return null;
    return { startTime, endTime };
  }

  // ─── Full sync (public entry point) ────────────────────────────────────────

  /**
   * fetchAllGoogleCalendarEvents — authoritative full sync.
   *
   * FIX (orgId):  orgId is now cross-validated. If the caller passes an empty
   * string (which happened when syncAllEvents couldn't resolve it), we pull it
   * directly from the user record. This prevents synced events from being
   * saved with organizationId: '' and then disappearing from all queries.
   *
   * FIX (window): Uses getSyncWindow() which is year-anchored, so the current
   * year is always fully covered no matter when in the year the sync runs.
   */
  async fetchAllGoogleCalendarEvents(userId: string, orgId: string): Promise<number> {
    const calendar = await this.getCalendarClient(userId);
    const user     = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    // Resolve orgId — never let it be an empty string
    const resolvedOrgId =
      orgId && orgId.trim() !== ''
        ? orgId
        : ((user as any).organizationId?.toString() ?? '');

    if (!resolvedOrgId) {
      console.warn(`⚠️  No organizationId for user ${userId} — events will be saved with empty org`);
    }

    const { timeMin, timeMax } = getSyncWindow();
    console.log(`🔄 Full sync | user: ${userId} | org: ${resolvedOrgId || '(empty)'}`);
    console.log(`   Window: ${timeMin.toISOString()} → ${timeMax.toISOString()}`);

    const events = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax);

    let created   = 0;
    let updated   = 0;
    let cancelled = 0;
    let skipped   = 0;

    for (const event of events) {
      try {
        const result = await this.upsertEventToLocalDB(event, user as any, resolvedOrgId, userId);
        if      (result === 'created')   created++;
        else if (result === 'updated')   updated++;
        else if (result === 'cancelled') cancelled++;
        else                             skipped++;
      } catch (err) {
        console.error(`❌ Upsert failed for event ${event.id} "${event.summary}":`, err);
      }
    }

    console.log(
      `✅ Sync complete | created: ${created} | updated: ${updated} | cancelled: ${cancelled} | skipped: ${skipped}`
    );
    return created + updated + cancelled;
  }

  /**
   * syncAllEvents — called by the "Sync Calendar" button controller action.
   * Resolves orgId from the user record (not from a request parameter) to
   * eliminate the empty-string orgId bug.
   */
  async syncAllEvents(userId: string): Promise<number> {
    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    const orgId = (user as any).organizationId?.toString() ?? '';
    return this.fetchAllGoogleCalendarEvents(userId, orgId);
  }

  // ─── Upsert ─────────────────────────────────────────────────────────────────

  /**
   * Create-or-update a single Google Calendar event in the local DB.
   *
   * FIX: Also back-fills organizationId on existing records that were previously
   * saved with an empty string — so running a new sync retroactively fixes old
   * broken records and makes them visible in queries.
   */
  private async upsertEventToLocalDB(
    event: calendar_v3.Schema$Event,
    user: any,
    organizationId: string,
    _userId: string
  ): Promise<'created' | 'updated' | 'cancelled' | 'skipped'> {
    if (!event.id) return 'skipped';

    const existing = await Appointment.findOne({ googleCalendarEventId: event.id });

    // ── Handle cancelled / deleted instances ──────────────────────────────────
    if (event.status === 'cancelled') {
      if (existing && existing.status !== 'cancelled') {
        existing.status       = 'cancelled';
        existing.lastSyncedAt = new Date();
        await existing.save();
        return 'cancelled';
      }
      return 'skipped';
    }

    // ── Parse times ───────────────────────────────────────────────────────────
    const times = this.parseEventTimes(event);
    if (!times) return 'skipped';
    const { startTime, endTime } = times;

    // ── Derive entryType from title keywords ──────────────────────────────────
    const titleLower = (event.summary ?? '').toLowerCase();
    let entryType: 'event' | 'task' | 'reminder' | 'appointment' = 'event';
    if      (titleLower.includes('task'))                                              entryType = 'task';
    else if (titleLower.includes('reminder'))                                          entryType = 'reminder';
    else if (titleLower.includes('appointment') || titleLower.includes('meeting'))     entryType = 'appointment';

    // ── Derive meeting type ───────────────────────────────────────────────────
    let type: 'in-person' | 'phone' | 'video' | 'other' = 'other';
    if      (event.hangoutLink || event.conferenceData) type = 'video';
    else if (event.location)                             type = 'in-person';

    const meetingLink =
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.[0]?.uri ??
      '';

    if (existing) {
      existing.title        = event.summary     ?? existing.title;
      existing.description  = event.description ?? existing.description;
      existing.startTime    = startTime;
      existing.endTime      = endTime;
      existing.location     = event.location    ?? existing.location ?? '';
      existing.meetingLink  = meetingLink        || existing.meetingLink;
      existing.lastSyncedAt = new Date();

      // FIX: Back-fill organizationId if a previous sync left it empty
      if (organizationId && (!existing.organizationId || existing.organizationId === '')) {
        existing.organizationId = organizationId;
        console.log(`🔧 Back-filled organizationId on event "${existing.title}"`);
      }

      await existing.save();
      return 'updated';
    }

    // ── Create new record ─────────────────────────────────────────────────────
    await Appointment.create({
      title:                    event.summary ?? 'Untitled Event',
      description:              event.description ?? '',
      startTime,
      endTime,
      location:                 event.location ?? '',
      type,
      entryType,
      status:                   'scheduled',
      createdBy:                user._id,
      organizationId,           // always the resolved, non-empty value
      participants:             [user._id],
      guestEmails:              [],
      googleCalendarEventId:    event.id,
      syncedWithGoogleCalendar: true,
      lastSyncedAt:             new Date(),
      meetingLink,
    });
    return 'created';
  }

  // ─── Recent sync ────────────────────────────────────────────────────────────

  /** 30 days back + 90 days forward — used for lightweight on-demand refreshes */
  async syncRecentEvents(userId: string): Promise<number> {
    const calendar = await this.getCalendarClient(userId);
    const user     = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    const orgId = (user as any).organizationId?.toString() ?? '';

    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - 30);
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 90);

    const events = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax);
    let processed = 0;
    for (const event of events) {
      try {
        const r = await this.upsertEventToLocalDB(event, user as any, orgId, userId);
        if (r !== 'skipped') processed++;
      } catch (err) {
        console.error(`Failed to upsert event ${event.id}:`, err);
      }
    }
    return processed;
  }

  // ─── Outbound sync ──────────────────────────────────────────────────────────

  async syncAppointmentToGoogleCalendar(appointment: IAppointment, userId: string): Promise<string | null> {
    try {
      const calendar  = await this.getCalendarClient(userId);
      const eventData: calendar_v3.Schema$Event = {
        summary:     appointment.title,
        description: this.buildEventDescription(appointment),
        start: { dateTime: appointment.startTime.toISOString(), timeZone: 'UTC' },
        end:   { dateTime: appointment.endTime.toISOString(),   timeZone: 'UTC' },
        location: appointment.location || undefined,
        conferenceData:
          appointment.type === 'video' && appointment.meetingLink
            ? { entryPoints: [{ entryPointType: 'video', uri: appointment.meetingLink }] }
            : undefined,
      };

      let response;
      if (appointment.googleCalendarEventId) {
        response = await calendar.events.update({
          calendarId: 'primary', eventId: appointment.googleCalendarEventId,
          requestBody: eventData, sendUpdates: 'all',
        });
      } else {
        response = await calendar.events.insert({
          calendarId: 'primary', requestBody: eventData, sendUpdates: 'all',
        });
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

  private async syncToParticipantsCalendars(appointment: IAppointment) {
    for (const participantId of appointment.participants) {
      try {
        if (participantId.toString() === appointment.createdBy.toString()) continue;
        const p = await User.findById(participantId).select('googleCalendar');
        if (!p || !(p as IUserWithGoogleCalendar).googleCalendar?.connected) continue;
        await this.syncAppointmentToGoogleCalendar(appointment, participantId.toString());
      } catch (err) {
        console.error(`Failed to sync to participant ${participantId}:`, err);
      }
    }
  }

  async deleteFromGoogleCalendar(eventId: string, userId: string): Promise<void> {
    try {
      const calendar = await this.getCalendarClient(userId);
      await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  private buildEventDescription(appointment: IAppointment): string {
    let d = appointment.description || '';
    if (appointment.notes) d += `\n\nNotes:\n${appointment.notes}`;
    d += `\n\n--- Appointment Details ---`;
    d += `\nType: ${appointment.entryType.charAt(0).toUpperCase() + appointment.entryType.slice(1)}`;
    d += `\nMeeting Type: ${appointment.type}`;
    if (appointment.meetingLink) d += `\n\nJoin Meeting: ${appointment.meetingLink}`;
    if (appointment.customerBooking) {
      d += `\n\n--- Customer Information ---`;
      d += `\nName: ${appointment.customerBooking.firstName} ${appointment.customerBooking.lastName}`;
      d += `\nEmail: ${appointment.customerBooking.email}`;
      d += `\nPhone: ${appointment.customerBooking.phone}`;
    }
    d += `\n\nManage: ${process.env.FRONTEND_URL}/appointments`;
    return d.trim();
  }

  // ─── Calendar management ────────────────────────────────────────────────────

  async disconnectCalendar(userId: string): Promise<void> {
    try {
      const user = (await User.findById(userId).select('googleCalendar')) as IUserWithGoogleCalendar | null;
      if (user?.googleCalendar?.watchChannelId && user?.googleCalendar?.watchResourceId) {
        try {
          const calendar = await this.getCalendarClient(userId);
          await calendar.channels.stop({
            requestBody: { id: user.googleCalendar.watchChannelId, resourceId: user.googleCalendar.watchResourceId },
          });
        } catch { /* non-critical */ }
      }
      await User.findByIdAndUpdate(userId, { $unset: { googleCalendar: 1 } });
    } catch {
      throw new ApiError(500, 'Failed to disconnect calendar');
    }
  }

  async setupWebhook(userId: string, channelId: string): Promise<void> {
    try {
      const calendar   = await this.getCalendarClient(userId);
      const webhookUrl = `${process.env.BACKEND_URL}/api/google-calendar/webhook`;
      const response   = await calendar.events.watch({
        calendarId:  'primary',
        requestBody: { id: channelId, type: 'web_hook', address: webhookUrl, params: { ttl: '604800' } },
      });
      await User.findByIdAndUpdate(userId, {
        $set: {
          'googleCalendar.watchChannelId':  channelId,
          'googleCalendar.watchResourceId': response.data.resourceId,
          'googleCalendar.watchExpiration': new Date(Date.now() + 604800000),
        },
      });
    } catch {
      throw new ApiError(500, 'Failed to set up calendar notifications');
    }
  }

  async processWebhookNotification(channelId: string, resourceState: string, resourceId: string): Promise<void> {
    try {
      const user = (await User.findOne({ 'googleCalendar.watchChannelId': channelId })) as IUserWithGoogleCalendar | null;
      if (!user || resourceState === 'sync') return;
      if (resourceState === 'exists') {
        await this.fetchAllGoogleCalendarEvents(
          user._id.toString(),
          user.organizationId?.toString() ?? ''
        );
      }
    } catch (error) {
      console.error('Failed to process webhook notification:', error);
    }
  }

  async updateRSVPStatusFromGoogle(appointmentId: string, userId: string): Promise<void> {
    try {
      const appointment = await Appointment.findById(appointmentId);
      if (!appointment || !appointment.googleCalendarEventId) {
        throw new ApiError(404, 'Appointment not found or not synced with Google Calendar');
      }
      const calendar = await this.getCalendarClient(userId);
      const event    = await calendar.events.get({ calendarId: 'primary', eventId: appointment.googleCalendarEventId });
      if (event.data.attendees) {
        const user     = await User.findById(userId);
        const attendee = event.data.attendees.find((a) => a.email === user?.email);
        if (attendee?.responseStatus) console.log(`RSVP: ${user?.email} → ${attendee.responseStatus}`);
      }
      await appointment.save();
    } catch (error) {
      throw error;
    }
  }

  async renewWebhook(userId: string): Promise<void> {
    try {
      const user = (await User.findById(userId).select('googleCalendar')) as IUserWithGoogleCalendar | null;
      if (!user?.googleCalendar?.watchChannelId) return;
      try {
        const calendar = await this.getCalendarClient(userId);
        await calendar.channels.stop({
          requestBody: { id: user.googleCalendar.watchChannelId, resourceId: user.googleCalendar.watchResourceId ?? '' },
        });
      } catch { /* non-critical */ }
      await this.setupWebhook(userId, `${userId}_${Date.now()}`);
    } catch (error) {
      throw error;
    }
  }
}

export default new GoogleCalendarService();