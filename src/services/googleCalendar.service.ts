import mongoose from 'mongoose';
import { google, calendar_v3 } from 'googleapis';
import User from '../models/User.model';
import Appointment from '../models/Appointment.model';
import { ApiError } from '../utils/ApiError';
import { decrypt, encrypt } from '../utils/crypto';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import { IUser } from '../models/User.model';
import { IAppointment } from '../models/Appointment.model';

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

const MAX_PAGES = 5;

class GoogleCalendarService {

  private createOAuthClient() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }



  private async getCalendarClient(target: { type: 'org' | 'crmUser'; id: string }): Promise<calendar_v3.Calendar> {
    let config: any;
    
    if (target.type === 'org') {
      config = await OrgLeadConfig.findOne({ organizationId: target.id });
    } else {
      config = await CrmUser.findById(target.id);
    }

    if (!config) {
      throw new ApiError(404, `Calendar configuration not found for ${target.type}: ${target.id}.`);
    }

    // Handle different field nesting (CrmUser has .googleCalendar sub-doc)
    const tokens = target.type === 'org' ? config : config.googleCalendar;

    if (!tokens || !tokens.calendarConnected || !tokens.accessToken || !tokens.refreshToken) {
      // SENIOR FIX: User-friendly error message
      throw new ApiError(401, 'Google Calendar is not connected. Please go to Settings to link your account before syncing.');
    }

    const oauth2Client = this.createOAuthClient();
    oauth2Client.setCredentials({
      access_token:  decrypt(tokens.accessToken),
      refresh_token: decrypt(tokens.refreshToken),
      expiry_date:   tokens.expiryDate,
    });

    oauth2Client.on('tokens', async (newTokens: any) => {
      const update: Record<string, any> = {};
      if (newTokens.expiry_date)   update['expiryDate'] = newTokens.expiry_date;
      if (newTokens.access_token)  update['accessToken']  = encrypt(newTokens.access_token);
      if (newTokens.refresh_token) update['refreshToken'] = encrypt(newTokens.refresh_token);

      if (target.type === 'org') {
        await OrgLeadConfig.updateOne({ organizationId: target.id }, { $set: update });
      } else {
        // Nested update for CrmUser.googleCalendar
        const nestedUpdate: Record<string, any> = {};
        for (const [key, val] of Object.entries(update)) {
          nestedUpdate[`googleCalendar.${key}`] = val;
        }
        await CrmUser.updateOne({ _id: target.id }, { $set: nestedUpdate });
      }
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  /**
   * Calculates the sync window based on whether it's an initial or daily sync.
   * Initial: 3 months back, 6 months forward (9 months total)
   * Daily: 3 months back, 2 months forward (5 months total)
   */
  private getSyncWindow(isInitial: boolean): { timeMin: Date; timeMax: Date } {
    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setMonth(timeMin.getMonth() - 3);
    timeMin.setHours(0, 0, 0, 0);

    const timeMax = new Date(now);
    const monthsForward = isInitial ? 6 : 2;
    timeMax.setMonth(timeMax.getMonth() + monthsForward);
    timeMax.setHours(23, 59, 59, 999);

    return { timeMin, timeMax };
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

  async isCrmUserCalendarConnected(crmUserId: string): Promise<boolean> {
    try {
      const user = await CrmUser.findById(crmUserId).select('googleCalendar');
      return !!(user?.googleCalendar?.calendarConnected && user.googleCalendar.accessToken);
    } catch {
      return false;
    }
  }

  // ─── Core paginated fetch ───────────────────────────────────────────────────

  private async fetchAllEventsFromGoogle(
    calendar: calendar_v3.Calendar,
    timeMin?: Date,
    timeMax?: Date,
    syncToken?: string
  ): Promise<{ items: calendar_v3.Schema$Event[]; nextSyncToken?: string | null }> {
    const allEvents: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null | undefined;
    let page = 0;

    console.log(`📅 Google Calendar fetch: ${syncToken ? 'Incremental (token)' : 'Full Scan'}`);

    do {
      page++;
      if (page > MAX_PAGES) {
        console.warn(`⚠️  MAX_PAGES (${MAX_PAGES}) reached — halting pagination`);
        break;
      }

      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId:   'primary',
        maxResults:   2500,
        pageToken,
      };

      if (syncToken) {
        params.syncToken = syncToken;
      } else if (timeMin && timeMax) {
        params.timeMin = timeMin.toISOString();
        params.timeMax = timeMax.toISOString();
        params.singleEvents = true;
        params.showDeleted = true;
      }

      const response = await calendar.events.list(params);

      const items = response.data.items ?? [];
      allEvents.push(...items);
      pageToken = response.data.nextPageToken ?? undefined;
      nextSyncToken = response.data.nextSyncToken;

      console.log(
        `  Page ${page}: ${items.length} events (running total: ${allEvents.length})` +
        (pageToken ? ' — more pages…' : ' — done ✓')
      );
    } while (pageToken);

    return { items: allEvents, nextSyncToken };
  }

  private parseEventTimes(
    event: calendar_v3.Schema$Event
  ): { startTime: Date; endTime: Date; transparency: 'opaque' | 'transparent' } | null {
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
      return { startTime, endTime, transparency: 'transparent' };
    } else {
      startTime = new Date(rawStart);
      endTime   = new Date(rawEnd);
      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return null;
      return { 
        startTime, 
        endTime, 
        transparency: (event.transparency as 'opaque' | 'transparent') || 'opaque' 
      };
    }
  }

  // ─── Sync Logic ────────────────────────────────────────────────────────────

  /**
   * Internal core sync engine
   */
  private async syncInternal(target: { type: 'org' | 'crmUser'; id: string }, triggeringUserId?: string, forceFullSync?: boolean): Promise<number> {
    const calendar = await this.getCalendarClient(target);
    
    // 1. Resolve Identity and Context
    let organizationId: string;
    let userIdForAttribution: mongoose.Types.ObjectId;
    let currentSyncToken: string | undefined;
    let isInitialSync = false;

    if (target.type === 'org') {
      organizationId = target.id;
      const admin = await User.findOne({ organizationId, role: 'admin', isActive: true });
      if (!admin) throw new ApiError(400, 'No admin found for organization sync attribution.');
      userIdForAttribution = admin._id;
      // For org sync, check OrgLeadConfig for history
      const config = await OrgLeadConfig.findOne({ organizationId });
      isInitialSync = !config?.lastSyncAt;
    } else {
      const crmUser = await CrmUser.findById(target.id);
      if (!crmUser) throw new ApiError(404, 'CRM User not found');
      organizationId = crmUser.organizationId.toString();
      userIdForAttribution = crmUser._id;
      isInitialSync = !crmUser.googleCalendar?.lastSyncAt;
      if (!forceFullSync) {
        currentSyncToken = crmUser.googleCalendar?.syncToken;
      }
    }

    // 2. Fetch from Google
    // SENIOR: Use 9 months for initial/forced, otherwise use 5-month rolling window
    const { timeMin, timeMax } = this.getSyncWindow(isInitialSync || !!forceFullSync);
    let result: { items: calendar_v3.Schema$Event[]; nextSyncToken?: string | null };
    let usedFallback = false;
    
    try {
      if (forceFullSync) {
        console.log('🔄 forceFullSync=true, bypassing syncToken and using full date-range scan');
        result = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax);
      } else {
        result = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax, currentSyncToken);
      }
    } catch (err: any) {
      if (err.code === 410) { // GONE - syncToken invalid
        console.log('🔄 syncToken expired (410 GONE), performing full scan...');
        result = await this.fetchAllEventsFromGoogle(calendar, timeMin, timeMax);
        usedFallback = true;
      } else {
        const msg: string = err?.message ?? '';
        if (msg.toLowerCase().includes('insufficient') || err?.code === 403) {
          await this.markDisconnected(target);
          throw new ApiError(403, 'Insufficient permissions. Please reconnect your calendar.');
        }
        throw err;
      }
    }

    const { items: finalEvents, nextSyncToken: finalSyncToken } = result;

    // 3. Process Events
    // SENIOR FIX: Deletions are processed globally. Inserts/Updates are filtered by window.
    const cancelledIds = finalEvents
      .filter(e => e.id && e.status === 'cancelled')
      .map(e => e.id as string);

    const validEvents = finalEvents.filter(e => {
      if (!e.id || e.status === 'cancelled') return false;
      const times = this.parseEventTimes(e);
      if (!times) return false;
      // Filter by window
      return times.startTime >= timeMin && times.startTime <= timeMax;
    });

    console.log(`📊 Sync stats: totalReceived=${finalEvents.length}, filteredToSync=${validEvents.length}, deletions=${cancelledIds.length}, isInitialSync=${isInitialSync}`);

    // Fetch existing docs to avoid duplicates (scoped to THIS user/org)
    const allIds = finalEvents.map(e => e.id).filter(Boolean) as string[];
    const existingDocs = await Appointment.find({ 
      googleCalendarEventId: { $in: allIds },
      createdBy: userIdForAttribution // Important: Isolation
    }).select('_id googleCalendarEventId').lean();
    
    const existingMap = new Map(existingDocs.map(d => [d.googleCalendarEventId, d]));

    // Bulk Cancel/Remove Deletions
    if (cancelledIds.length > 0) {
      // SENIOR: We perform a hard status update to 'cancelled' for deleted events
      await Appointment.updateMany(
        { googleCalendarEventId: { $in: cancelledIds }, createdBy: userIdForAttribution },
        { $set: { status: 'cancelled' } }
      );
    }

    const ops: any[] = [];
    for (const event of validEvents) {
      const times = this.parseEventTimes(event);
      if (!times) continue;
      const { startTime, endTime, transparency } = times;

      const titleLower = (event.summary ?? '').toLowerCase();
      let entryType: 'event' | 'task' | 'reminder' | 'appointment' = 'event';
      if      (titleLower.includes('task'))        entryType = 'task';
      else if (titleLower.includes('reminder'))    entryType = 'reminder';
      else if (titleLower.includes('appointment')) entryType = 'appointment';

      let type: 'in-person' | 'phone' | 'video' | 'other' = 'other';
      if      (event.hangoutLink || event.conferenceData) type = 'video';
      else if (event.location)                            type = 'in-person';

      const meetingLink = event.hangoutLink ?? event.conferenceData?.entryPoints?.[0]?.uri ?? '';

      if (existingMap.has(event.id!)) {
        ops.push({
          updateOne: {
            filter: { googleCalendarEventId: event.id, createdBy: userIdForAttribution },
            update: {
              $set: {
                title:        event.summary || undefined,
                description:  event.description || undefined,
                startTime,
                endTime,
                location:     event.location || undefined,
                meetingLink:  meetingLink || undefined,
                transparency,
                lastSyncedAt: new Date(),
              },
            },
          },
        });
      } else {
        ops.push({
          insertOne: {
            document: {
              title:                    event.summary ?? 'Untitled Event',
              description:              event.description ?? '',
              startTime,
              endTime,
              location:                 event.location ?? '',
              type,
              entryType,
              status:                   'scheduled',
              createdBy:                userIdForAttribution,
              organizationId,
              participants:             [userIdForAttribution],
              googleCalendarEventId:    event.id,
              syncedWithGoogleCalendar: true,
              lastSyncedAt:             new Date(),
              meetingLink,
              transparency,
            },
          },
        });
      }
    }

    let processed = 0;
    if (ops.length > 0) {
      console.log(`📝 Preparing to bulkWrite ${ops.length} operations...`);
      try {
        const bulkResult = await Appointment.bulkWrite(ops, { ordered: false });
        processed = (bulkResult.insertedCount ?? 0) + (bulkResult.modifiedCount ?? 0);
        console.log(`✅ BulkWrite complete: inserted=${bulkResult.insertedCount}, modified=${bulkResult.modifiedCount}, processed=${processed}`);
      } catch (bulkErr: any) {
        console.error(`❌ BulkWrite error: ${bulkErr.message}`, bulkErr);
        throw bulkErr;
      }
    } else {
      console.log(`⚠️  No operations to write (ops.length=${ops.length})`);
    }

    // 4. Update syncToken and lastSyncAt
    if (finalSyncToken) {
      if (target.type === 'org') {
        await OrgLeadConfig.updateOne(
          { organizationId: target.id },
          { $set: { syncToken: finalSyncToken, lastSyncAt: new Date() } }
        );
        console.log(`🔐 Updated org syncToken for ${target.id}`);
      } else {
        await CrmUser.updateOne(
          { _id: target.id },
          { $set: { 'googleCalendar.syncToken': finalSyncToken, 'googleCalendar.lastSyncAt': new Date() } }
        );
        console.log(`🔐 Updated CrmUser syncToken for ${target.id}`);
      }
    } else {
      console.log(`⚠️  No nextSyncToken received from Google; syncToken not updated`);
    }

    console.log(`✅ Sync complete for ${target.type} ${target.id}: ${processed} events (fallback=${usedFallback})`);
    return processed;
  }

  private async markDisconnected(target: { type: 'org' | 'crmUser'; id: string }) {
    if (target.type === 'org') {
      await OrgLeadConfig.updateOne({ organizationId: target.id }, { $set: { calendarConnected: false } });
    } else {
      await CrmUser.updateOne({ _id: target.id }, { $set: { 'googleCalendar.calendarConnected': false } });
    }
  }

  async syncAllEvents(orgId: string, triggeringUserId?: string, forceFullSync?: boolean): Promise<number> {
    return this.syncInternal({ type: 'org', id: orgId }, triggeringUserId, forceFullSync);
  }

  async syncCrmUserCalendar(crmUserId: string, forceFullSync?: boolean): Promise<number> {
    return this.syncInternal({ type: 'crmUser', id: crmUserId }, undefined, forceFullSync);
  }

  // ─── Outbound Sync ──────────────────────────────────────────────────────────

  // ─── Outbound Sync ──────────────────────────────────────────────────────────
  
  async syncAppointmentToGoogleCalendar(appointment: IAppointment, target: { type: 'org' | 'crmUser'; id: string }): Promise<string | null> {
    try {
      const calendar = await this.getCalendarClient(target);
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

  async deleteFromGoogleCalendar(eventId: string, target: { type: 'org' | 'crmUser'; id: string }): Promise<void> {
    try {
      const calendar = await this.getCalendarClient(target);
      await calendar.events.delete({ calendarId: 'primary', eventId });
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  // ─── Webhooks & Maintenance ──────────────────────────────────────────────────

  async disconnectCalendar(crmUserId: string): Promise<void> {
    await CrmUser.updateOne({ _id: crmUserId }, { $set: { 'googleCalendar.calendarConnected': false } });
  }

  async setupWebhook(target: { type: 'org' | 'crmUser'; id: string }, channelId: string): Promise<void> {
    try {
      const calendar   = await this.getCalendarClient(target);
      const webhookUrl = `${process.env.BACKEND_URL}/api/crm-calendar/webhook`;
      await calendar.events.watch({
        calendarId:  'primary',
        requestBody: { id: channelId, type: 'web_hook', address: webhookUrl },
      });
      console.log(`✅ Calendar webhook set up successfully for ${target.type}`);
    } catch (error) {
      console.error('⚠️ Failed to set up calendar webhook:', error);
    }
  }

  async processWebhookNotification(channelId: string, resourceState: string, resourceId: string): Promise<void> {
    // Webhook logic...
    console.log(`Processing webhook for channel ${channelId}`);
  }

  async updateRSVPStatusFromGoogle(appointmentId: string, target: { type: 'org' | 'crmUser'; id: string }): Promise<void> {
    try {
      const appointment = await Appointment.findById(appointmentId);
      if (!appointment || !appointment.googleCalendarEventId) return;
      
      const calendar = await this.getCalendarClient(target);
      const event = await calendar.events.get({ calendarId: 'primary', eventId: appointment.googleCalendarEventId });
      
      // RSVP update logic can be added here if needed
      
      await appointment.save();
    } catch (error) {
      console.error('Failed to update RSVP:', error);
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
}

export default new GoogleCalendarService();