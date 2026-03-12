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

class GoogleCalendarService {
  /**
   * Get authorization URL for OAuth
   * FIX: Changed prompt from 'select_account' to 'consent'
   * so Google always returns a refresh_token
   */
  getAuthUrl(userId: string): string {
    const oauth2Client = this.createOAuthClient();

    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify'
    ];

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent', // FIX: was 'select_account' — 'consent' forces Google to always return refresh_token
      state: userId
    });
  }

  /**
   * Create a fresh OAuth2 client (per-request, avoids shared singleton race conditions)
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
   * Save user tokens to database
   * FIX: Only overwrites refresh_token if a new one is actually returned,
   * preventing wiping out a valid existing refresh_token
   */
  async saveUserTokens(userId: string, tokens: GoogleTokens): Promise<void> {
    try {
      const updateFields: Record<string, any> = {
        'googleCalendar.accessToken': tokens.access_token,
        'googleCalendar.expiryDate': tokens.expiry_date,
        'googleCalendar.connected': true,
        'googleCalendar.connectedAt': new Date()
      };

      // FIX: Only write refresh_token if Google actually returned one
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
      const user = await User.findById(userId).select('googleCalendar') as IUserWithGoogleCalendar | null;

      if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
        return null;
      }

      return {
        access_token: user.googleCalendar.accessToken,
        refresh_token: user.googleCalendar.refreshToken,
        expiry_date: user.googleCalendar.expiryDate
      };
    } catch (error) {
      console.error('Failed to get user tokens:', error);
      return null;
    }
  }

  /**
   * Get authorized calendar client for a user
   * FIX: Creates a fresh OAuth2 client per call to avoid shared singleton
   * race conditions when multiple users sync simultaneously.
   * FIX: Guards against missing refresh_token and marks user as disconnected
   * so the frontend can prompt reconnection.
   */
  private async getCalendarClient(userId: string): Promise<calendar_v3.Calendar> {
    const user = await User.findById(userId).select('googleCalendar') as IUserWithGoogleCalendar | null;

    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      throw new ApiError(401, 'Google Calendar not connected');
    }

    // FIX: Guard — if refresh token is missing, mark disconnected and tell user to reconnect
    if (!user.googleCalendar.refreshToken) {
      await User.findByIdAndUpdate(userId, {
        $set: { 'googleCalendar.connected': false }
      });
      throw new ApiError(
        401,
        'Google Calendar requires reconnection. Please disconnect and reconnect your calendar.'
      );
    }

    // FIX: Fresh client per call — no more shared singleton mutations
    const oauth2Client = this.createOAuthClient();

    oauth2Client.setCredentials({
      access_token: user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date: user.googleCalendar.expiryDate
    });

    // Persist refreshed tokens when Google auto-rotates them
    oauth2Client.on('tokens', async (tokens: any) => {
      const update: Record<string, any> = {
        'googleCalendar.expiryDate': tokens.expiry_date
      };
      if (tokens.access_token) {
        update['googleCalendar.accessToken'] = tokens.access_token;
      }
      // FIX: Only overwrite refresh_token if a new one was returned
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
      const user = await User.findById(userId).select('googleCalendar') as IUserWithGoogleCalendar | null;
      return !!(user?.googleCalendar?.connected && user.googleCalendar.accessToken && user.googleCalendar.refreshToken);
    } catch (error) {
      return false;
    }
  }

  /**
   * Fetch all Google Calendar events and sync to local database
   */
  async fetchAllGoogleCalendarEvents(userId: string, orgId: string): Promise<number> {
    try {
      const calendar = await this.getCalendarClient(userId);

      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      const oneYearFromNow = new Date();
      oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

      console.log('Fetching Google Calendar events...');

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: oneYearAgo.toISOString(),
        timeMax: oneYearFromNow.toISOString(),
        maxResults: 2500,
        singleEvents: true,
        orderBy: 'startTime'
      });

      const events = response.data.items || [];
      console.log(`Found ${events.length} events in Google Calendar`);

      let syncedCount = 0;
      const user = await User.findById(userId);

      if (!user) {
        throw new ApiError(404, 'User not found');
      }

      for (const event of events) {
        try {
          const existingAppointment = await Appointment.findOne({
            googleCalendarEventId: event.id
          });

          if (!existingAppointment) {
            await this.createLocalAppointmentFromGoogleEvent(event, user as any, orgId);
            syncedCount++;
          } else {
            await this.updateLocalAppointmentFromGoogleEvent(event, user as any, userId);
          }
        } catch (error) {
          console.error(`Failed to sync event ${event.id}:`, error);
        }
      }

      console.log(`Synced ${syncedCount} new events from Google Calendar`);
      return syncedCount;
    } catch (error: any) {
      console.error('Failed to fetch Google Calendar events:', error.message);
      throw error;
    }
  }

  /**
   * Create local appointment from Google Calendar event
   */
  private async createLocalAppointmentFromGoogleEvent(
    event: calendar_v3.Schema$Event,
    user: any,
    organizationId: string
  ): Promise<void> {
    try {
      const startTime = event.start?.dateTime || event.start?.date;
      const endTime = event.end?.dateTime || event.end?.date;

      if (!startTime || !endTime) {
        console.log('Skipping event without valid times:', event.summary);
        return;
      }

      let entryType: 'event' | 'task' | 'reminder' | 'appointment' = 'event';
      if (event.summary?.toLowerCase().includes('task')) {
        entryType = 'task';
      } else if (event.summary?.toLowerCase().includes('reminder')) {
        entryType = 'reminder';
      } else if (
        event.summary?.toLowerCase().includes('appointment') ||
        event.summary?.toLowerCase().includes('meeting')
      ) {
        entryType = 'appointment';
      }

      let type: 'in-person' | 'phone' | 'video' | 'other' = 'other';
      if (event.location) {
        type = 'in-person';
      } else if (event.hangoutLink || event.conferenceData) {
        type = 'video';
      }

      await Appointment.create({
        title: event.summary || 'Untitled Event',
        description: event.description || '',
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        location: event.location || '',
        type,
        entryType,
        status: 'scheduled',
        createdBy: user._id,
        organizationId: organizationId,
        participants: [user._id],
        guestEmails: [],
        googleCalendarEventId: event.id || '',
        syncedWithGoogleCalendar: true,
        lastSyncedAt: new Date(),
        meetingLink:
          event.hangoutLink ||
          event.conferenceData?.entryPoints?.[0]?.uri ||
          ''
      });

      console.log(`Created appointment from Google event: ${event.summary}`);
    } catch (error) {
      console.error('Failed to create appointment from Google event:', error);
      throw error;
    }
  }

  /**
   * Update local appointment from Google Calendar event
   */
  private async updateLocalAppointmentFromGoogleEvent(
    event: calendar_v3.Schema$Event,
    user: any,
    userId: string
  ): Promise<void> {
    try {
      const appointment = await Appointment.findOne({
        googleCalendarEventId: event.id
      });

      if (!appointment) return;

      const startTime = event.start?.dateTime || event.start?.date;
      const endTime = event.end?.dateTime || event.end?.date;

      if (!startTime || !endTime) return;

      appointment.title = event.summary || appointment.title;
      appointment.description = event.description || appointment.description;
      appointment.startTime = new Date(startTime);
      appointment.endTime = new Date(endTime);
      appointment.location = event.location || appointment.location;
      appointment.meetingLink =
        event.hangoutLink ||
        event.conferenceData?.entryPoints?.[0]?.uri ||
        appointment.meetingLink;
      appointment.lastSyncedAt = new Date();

      if (event.status === 'cancelled') {
        appointment.status = 'cancelled';
      }

      await appointment.save();
      console.log(`Updated appointment from Google event: ${event.summary}`);
    } catch (error) {
      console.error('Failed to update appointment from Google event:', error);
      throw error;
    }
  }

  /**
   * Sync appointment to Google Calendar
   */
  async syncAppointmentToGoogleCalendar(
    appointment: IAppointment,
    userId: string
  ): Promise<string | null> {
    try {
      const calendar = await this.getCalendarClient(userId);

      const eventData: calendar_v3.Schema$Event = {
        summary: appointment.title,
        description: this.buildEventDescription(appointment),
        start: {
          dateTime: appointment.startTime.toISOString(),
          timeZone: 'UTC'
        },
        end: {
          dateTime: appointment.endTime.toISOString(),
          timeZone: 'UTC'
        },
        location: appointment.location || undefined,
        conferenceData:
          appointment.type === 'video' && appointment.meetingLink
            ? {
                entryPoints: [
                  {
                    entryPointType: 'video',
                    uri: appointment.meetingLink
                  }
                ]
              }
            : undefined
      };

      let response;

      if (appointment.googleCalendarEventId) {
        response = await calendar.events.update({
          calendarId: 'primary',
          eventId: appointment.googleCalendarEventId,
          requestBody: eventData,
          sendUpdates: 'all'
        });
        console.log(`Updated Google Calendar event: ${appointment.title}`);
      } else {
        response = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: eventData,
          sendUpdates: 'all'
        });
        console.log(`Created Google Calendar event: ${appointment.title}`);

        await Appointment.findByIdAndUpdate(appointment._id, {
          googleCalendarEventId: response.data.id,
          syncedWithGoogleCalendar: true,
          lastSyncedAt: new Date()
        });
      }

      await this.syncToParticipantsCalendars(appointment);

      return response.data.id || null;
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
          console.log(`Skipping participant ${participantId} - Google Calendar not connected`);
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
        eventId: eventId,
        sendUpdates: 'all'
      });
      console.log(`Deleted Google Calendar event: ${eventId}`);
    } catch (error) {
      console.error('Failed to delete from Google Calendar:', error);
    }
  }

  /**
   * Build event description
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

  /**
   * Disconnect Google Calendar
   */
  async disconnectCalendar(userId: string): Promise<void> {
    try {
      const user = await User.findById(userId).select(
        'googleCalendar'
      ) as IUserWithGoogleCalendar | null;

      if (
        user?.googleCalendar?.watchChannelId &&
        user?.googleCalendar?.watchResourceId
      ) {
        try {
          const calendar = await this.getCalendarClient(userId);
          await calendar.channels.stop({
            requestBody: {
              id: user.googleCalendar.watchChannelId,
              resourceId: user.googleCalendar.watchResourceId
            }
          });
          console.log('Stopped webhook channel');
        } catch (error) {
          console.error('Failed to stop webhook channel (non-critical):', error);
        }
      }

      await User.findByIdAndUpdate(userId, {
        $unset: { googleCalendar: 1 }
      });

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
      const calendar = await this.getCalendarClient(userId);
      const webhookUrl = `${process.env.BACKEND_URL}/api/google-calendar/webhook`;

      const response = await calendar.events.watch({
        calendarId: 'primary',
        requestBody: {
          id: channelId,
          type: 'web_hook',
          address: webhookUrl,
          params: {
            ttl: '604800'
          }
        }
      });

      await User.findByIdAndUpdate(userId, {
        $set: {
          'googleCalendar.watchChannelId': channelId,
          'googleCalendar.watchResourceId': response.data.resourceId,
          'googleCalendar.watchExpiration': new Date(Date.now() + 604800000)
        }
      });

      console.log(`Set up webhook for user ${userId}, channel ${channelId}`);
    } catch (error) {
      console.error('Failed to set up webhook:', error);
      throw new ApiError(500, 'Failed to set up calendar notifications');
    }
  }

  /**
   * Process webhook notification
   */
  async processWebhookNotification(
    channelId: string,
    resourceState: string,
    resourceId: string
  ): Promise<void> {
    try {
      console.log('Processing webhook:', { channelId, resourceState, resourceId });

      const user = await User.findOne({
        'googleCalendar.watchChannelId': channelId
      }) as IUserWithGoogleCalendar | null;

      if (!user) {
        console.log('No user found for channel:', channelId);
        return;
      }

      if (resourceState === 'sync') {
        console.log('Sync message received, ignoring');
        return;
      }

      if (resourceState === 'exists') {
        await this.fetchAllGoogleCalendarEvents(
          user._id.toString(),
          user.organizationId?.toString() || ''
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
        eventId: appointment.googleCalendarEventId
      });

      if (event.data.attendees) {
        const user = await User.findById(userId);
        const userEmail = user?.email;
        const attendee = event.data.attendees.find((a) => a.email === userEmail);

        if (attendee && attendee.responseStatus) {
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
   * Sync recent events (last 7 days)
   */
  async syncRecentEvents(userId: string): Promise<number> {
    try {
      const calendar = await this.getCalendarClient(userId);

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: sevenDaysAgo.toISOString(),
        timeMax: new Date().toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100
      });

      const events = response.data.items || [];
      let syncedCount = 0;

      const user = await User.findById(userId);
      if (!user) {
        throw new ApiError(404, 'User not found');
      }

      const orgId = (user as any).organizationId || '';

      for (const event of events) {
        try {
          const existingAppointment = await Appointment.findOne({
            googleCalendarEventId: event.id
          });

          if (!existingAppointment) {
            await this.createLocalAppointmentFromGoogleEvent(event, user as any, orgId);
            syncedCount++;
          } else {
            await this.updateLocalAppointmentFromGoogleEvent(event, user as any, userId);
            syncedCount++;
          }
        } catch (error) {
          console.error(`Failed to sync event ${event.id}:`, error);
        }
      }

      console.log(`Synced ${syncedCount} recent events`);
      return syncedCount;
    } catch (error) {
      console.error('Error syncing recent events:', error);
      throw error;
    }
  }

  /**
   * Renew webhook subscription
   */
  async renewWebhook(userId: string): Promise<void> {
    try {
      const user = await User.findById(userId).select(
        'googleCalendar'
      ) as IUserWithGoogleCalendar | null;

      if (!user?.googleCalendar?.watchChannelId) {
        console.log('No existing webhook to renew');
        return;
      }

      try {
        const calendar = await this.getCalendarClient(userId);
        await calendar.channels.stop({
          requestBody: {
            id: user.googleCalendar.watchChannelId,
            resourceId: user.googleCalendar.watchResourceId || ''
          }
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