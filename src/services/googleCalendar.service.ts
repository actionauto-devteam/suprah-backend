import mongoose from 'mongoose';
import { google, calendar_v3 } from 'googleapis';
import User from '../models/User.model';
import Appointment from '../models/Appointment.model';
import { ApiError } from '../utils/ApiError';
import { decrypt, encrypt } from '../utils/crypto';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { IUser } from '../models/User.model';
import { IAppointment } from '../models/Appointment.model';

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

// ─── Sync window ──────────────────────────────────────────────────────────────
function getSyncWindow(): { timeMin: Date; timeMax: Date } {
  const currentYear = new Date().getFullYear();
  return {
    timeMin: new Date(Date.UTC(currentYear - 1, 0,  1,  0,  0,  0)),
    timeMax: new Date(Date.UTC(currentYear + 2, 11, 31, 23, 59, 59)),
  };
}

const MAX_PAGES = 20;

class GoogleCalendarService {
  // ─── OAuth ─────────────────────────────────────────────────────────────────

  private createOAuthClient() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }



  private async getCalendarClient(id: string): Promise<calendar_v3.Calendar> {
    let orgId = id;

    // 1. Try to find the organization configuration FIRST (id might be an orgId)
    let config = await OrgLeadConfig.findOne({ organizationId: id });

    // 2. If not found, it might be a userId - look up the user's organization
    if (!config) {
      const user = await User.findById(id).select('organizationId');
      if (user && (user as any).organizationId) {
        orgId = (user as any).organizationId.toString();
        config = await OrgLeadConfig.findOne({ organizationId: orgId });
      }
    }

    if (!config) {
      throw new ApiError(404, `Calendar configuration not found for ID: ${id}. Ensure the organization is connected.`);
    }

    if (!config.calendarConnected || !config.accessToken || !config.refreshToken) {
      throw new ApiError(401, 'Google Calendar not connected for this organization');
    }

    const oauth2Client = this.createOAuthClient();
    oauth2Client.setCredentials({
      access_token:  decrypt(config.accessToken),
      refresh_token: decrypt(config.refreshToken),
      expiry_date:   config.expiryDate,
    });

    oauth2Client.on('tokens', async (tokens: any) => {
      const update: Record<string, any> = { expiryDate: tokens.expiry_date };
      if (tokens.access_token)  update.accessToken  = encrypt(tokens.access_token);
      if (tokens.refresh_token) update.refreshToken = encrypt(tokens.refresh_token);
      await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: update });
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  async isGoogleCalendarConnected(userId: string): Promise<boolean> {
    try {
      const user = await User.findById(userId).select('organizationId');
      if (!user || !(user as any).organizationId) return false;
      
      const config = await OrgLeadConfig.findOne({ 
        organizationId: (user as any).organizationId,
        calendarConnected: true 
      });
      
      return !!(config && config.accessToken && config.refreshToken);
    } catch {
      return false;
    }
  }

  // ─── Core paginated fetch ───────────────────────────────────────────────────

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
        singleEvents: true,
        showDeleted:  true,
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

    return allEvents;
  }

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
      const [ey, em, ed] = rawEnd.split('-').map(Number);
      endTime = new Date(Date.UTC(ey, em - 1, ed, 0, 0, 0) - 1);
    } else {
      startTime = new Date(rawStart);
      endTime   = new Date(rawEnd);
    }

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return null;
    return { startTime, endTime };
  }

  // ─── Sync Logic ────────────────────────────────────────────────────────────

  async fetchAllGoogleCalendarEvents(id: string, providedOrgId?: string, triggeringUserId?: string): Promise<number> {
    const calendar = await this.getCalendarClient(id);

    // Resolve organization ID
    let organizationId = providedOrgId;
    let user: any = null;

    // 1. Resolve organizationId if missing
    if (!organizationId) {
      user = await User.findById(id).select('organizationId');
      if (user) organizationId = (user as any).organizationId?.toString();
    }

    if (!organizationId) throw new ApiError(400, 'Organization ID could not be resolved for sync.');

    // 2. Resolve User context (mandatory for Appointment creation)
    const userIdToLookup = triggeringUserId || (organizationId === id ? null : id);
    if (userIdToLookup) {
      user = await User.findById(userIdToLookup);
    }

    // 3. Fallback: If no user context, find first active admin in the organization
    if (!user && organizationId) {
      console.log(`[CalendarSync] No triggering user found, searching for organization admin fallback for org: ${organizationId}`);
      user = await User.findOne({ organizationId, role: 'admin', isActive: true });
      
      // Final fallback: any active user in the organization
      if (!user) {
        user = await User.findOne({ organizationId, isActive: true });
      }
    }

    if (!user) {
      throw new ApiError(400, 'Could not find a valid user context to attribute synced events to.');
    }

    const { timeMin, timeMax } = getSyncWindow();
    const events = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax);

    let processed = 0;
    for (const event of events) {
      try {
        const result = await this.upsertEventToLocalDB(event, user, organizationId);
        if (result !== 'skipped') processed++;
      } catch (err) {
        console.error(`❌ Upsert failed for event ${event.id}:`, err);
      }
    }
    return processed;
  }

  async syncAllEvents(id: string, triggeringUserId?: string): Promise<number> {
    // In our new flow, 'id' is typically an organizationId passed from the controller
    return this.fetchAllGoogleCalendarEvents(id, id, triggeringUserId);
  }

  private async upsertEventToLocalDB(
    event: calendar_v3.Schema$Event,
    user: any,
    organizationId: string
  ): Promise<'created' | 'updated' | 'cancelled' | 'skipped'> {
    if (!event.id) return 'skipped';

    const existing = await Appointment.findOne({ googleCalendarEventId: event.id });

    if (event.status === 'cancelled') {
        if (existing && existing.status !== 'cancelled') {
            existing.status = 'cancelled';
            await existing.save();
            return 'cancelled';
        }
        return 'skipped';
    }

    const times = this.parseEventTimes(event);
    if (!times) return 'skipped';
    const { startTime, endTime } = times;

    const titleLower = (event.summary ?? '').toLowerCase();
    let entryType: 'event' | 'task' | 'reminder' | 'appointment' = 'event';
    if      (titleLower.includes('task')) entryType = 'task';
    else if (titleLower.includes('reminder')) entryType = 'reminder';
    else if (titleLower.includes('appointment')) entryType = 'appointment';

    let type: 'in-person' | 'phone' | 'video' | 'other' = 'other';
    if      (event.hangoutLink || event.conferenceData) type = 'video';
    else if (event.location) type = 'in-person';

    const meetingLink = event.hangoutLink ?? event.conferenceData?.entryPoints?.[0]?.uri ?? '';

    if (existing) {
        existing.title = event.summary || existing.title;
        existing.description = event.description || existing.description;
        existing.startTime = startTime;
        existing.endTime = endTime;
        existing.location = event.location || existing.location;
        existing.meetingLink = meetingLink || existing.meetingLink;
        existing.organizationId = organizationId;
        await existing.save();
        return 'updated';
    }

    await Appointment.create({
        title: event.summary ?? 'Untitled Event',
        description: event.description ?? '',
        startTime,
        endTime,
        location: event.location ?? '',
        type,
        entryType,
        status: 'scheduled',
        createdBy: user._id,
        organizationId,
        participants: [user._id],
        googleCalendarEventId: event.id,
        syncedWithGoogleCalendar: true,
        lastSyncedAt: new Date(),
        meetingLink,
    });
    return 'created';
  }

  // ─── Outbound Sync ──────────────────────────────────────────────────────────

  async syncAppointmentToGoogleCalendar(appointment: IAppointment, userId: string): Promise<string | null> {
    try {
      const calendar = await this.getCalendarClient(userId);
      const eventData: calendar_v3.Schema$Event = {
        summary: appointment.title,
        description: this.buildEventDescription(appointment),
        start: { dateTime: appointment.startTime.toISOString() },
        end:   { dateTime: appointment.endTime.toISOString() },
        location: appointment.location || undefined,
      };

      let response;
      if (appointment.googleCalendarEventId) {
        response = await calendar.events.update({
          calendarId: 'primary',
          eventId: appointment.googleCalendarEventId,
          requestBody: eventData,
        });
      } else {
        response = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: eventData,
        });
        await Appointment.findByIdAndUpdate(appointment._id, {
          googleCalendarEventId: response.data.id,
          syncedWithGoogleCalendar: true,
          lastSyncedAt: new Date(),
        });
      }
      return response.data.id ?? null;
    } catch (error: any) {
      console.error('Failed to sync to Google Calendar:', error.message);
      return null;
    }
  }

  async deleteFromGoogleCalendar(eventId: string, userId: string): Promise<void> {
    try {
      const calendar = await this.getCalendarClient(userId);
      await calendar.events.delete({ calendarId: 'primary', eventId });
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  private buildEventDescription(appointment: IAppointment): string {
    let d = appointment.description || '';
    d += `\n\n--- Appointment Details ---`;
    d += `\nType: ${appointment.entryType}`;
    d += `\nMeeting Type: ${appointment.type}`;
    if (appointment.meetingLink) d += `\nJoin Meeting: ${appointment.meetingLink}`;
    return d.trim();
  }

  // ─── Webhooks & Maintenance ──────────────────────────────────────────────────

  async disconnectCalendar(userId: string): Promise<void> {
    const user = await User.findById(userId).select('organizationId');
    if (!user || !(user as any).organizationId) return;
    const orgId = (user as any).organizationId;
    await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { calendarConnected: false } });
  }

  async setupWebhook(userId: string, channelId: string): Promise<void> {
    try {
      const calendar   = await this.getCalendarClient(userId);
      const webhookUrl = `${process.env.BACKEND_URL}/api/google-calendar/webhook`;
      const response   = await calendar.events.watch({
        calendarId:  'primary',
        requestBody: { id: channelId, type: 'web_hook', address: webhookUrl },
      });
      console.log('✅ Org-wide calendar webhook set up successfully');
    } catch (error) {
      console.error('⚠️ Failed to set up calendar webhook:', error);
    }
  }

  async processWebhookNotification(channelId: string, resourceState: string, resourceId: string): Promise<void> {
    // Org-wide webhook processing logic would go here
    // For now, this requires a way to map channelId to orgId
  }

  async updateRSVPStatusFromGoogle(appointmentId: string, userId: string): Promise<void> {
    try {
      const appointment = await Appointment.findById(appointmentId);
      if (!appointment || !appointment.googleCalendarEventId) return;
      
      const calendar = await this.getCalendarClient(userId);
      const event = await calendar.events.get({ calendarId: 'primary', eventId: appointment.googleCalendarEventId });
      // RSVP logic...
      await appointment.save();
    } catch (error) {
      console.error('Failed to update RSVP:', error);
    }
  }

  async renewWebhook(userId: string): Promise<void> {
    await this.setupWebhook(userId, `org_renew_${Date.now()}`);
  }
}

export default new GoogleCalendarService();