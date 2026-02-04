import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { IAppointment } from '../models/Appointment.model';
import User, { IUser } from '../models/User.model';
import Appointment from '../models/Appointment.model';
import { ApiError } from '../utils/ApiError';
import notificationService from './notification.service';

interface GoogleCalendarTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
}

// FIXED: Match the User model interface exactly
interface IUserWithGoogleCalendar extends IUser {
  googleCalendar?: {
    connected: boolean; // FIXED: Remove undefined, make required in type
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    connectedAt?: Date;
    watchChannelId?: string;
    watchResourceId?: string;
    watchExpiration?: Date;
  };
}

class GoogleCalendarService {
  private oauth2Client: OAuth2Client;

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `${process.env.BACKEND_URL}/api/google-calendar/callback`
    );
  }

  /**
   * Generate authorization URL for Google Calendar OAuth
   */
  getAuthUrl(userId: string): string {
    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state: userId,
      prompt: 'consent'
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokensFromCode(code: string): Promise<GoogleCalendarTokens> {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      return {
        access_token: tokens.access_token!,
        refresh_token: tokens.refresh_token || undefined,
        expiry_date: tokens.expiry_date || undefined
      };
    } catch (error) {
      console.error('Failed to exchange code for tokens:', error);
      throw new ApiError(400, 'Failed to authenticate with Google Calendar');
    }
  }

  /**
   * Save user's Google Calendar tokens
   */
  async saveUserTokens(userId: string, tokens: GoogleCalendarTokens): Promise<void> {
    try {
      await User.findByIdAndUpdate(userId, {
        $set: {
          'googleCalendar.accessToken': tokens.access_token,
          'googleCalendar.refreshToken': tokens.refresh_token,
          'googleCalendar.expiryDate': tokens.expiry_date,
          'googleCalendar.connected': true,
          'googleCalendar.connectedAt': new Date()
        }
      });
      console.log('Saved Google Calendar tokens for user:', userId);
    } catch (error) {
      console.error('Failed to save Google Calendar tokens:', error);
      throw new ApiError(500, 'Failed to save calendar credentials');
    }
  }

  /**
   * Get user's stored tokens
   */
  async getUserTokens(userId: string): Promise<GoogleCalendarTokens | null> {
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
   * Refresh access token if expired
   */
  async refreshAccessToken(userId: string): Promise<string> {
    try {
      const tokens = await this.getUserTokens(userId);
      
      if (!tokens?.refresh_token) {
        throw new ApiError(401, 'No refresh token available. Please reconnect Google Calendar.');
      }

      this.oauth2Client.setCredentials(tokens);
      
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      
      await this.saveUserTokens(userId, {
        access_token: credentials.access_token!,
        refresh_token: credentials.refresh_token || tokens.refresh_token,
        expiry_date: credentials.expiry_date || undefined
      });

      console.log('Refreshed access token for user:', userId);
      return credentials.access_token!;
    } catch (error) {
      console.error('Failed to refresh access token:', error);
      throw new ApiError(401, 'Failed to refresh calendar access. Please reconnect.');
    }
  }

  /**
   * Get authenticated calendar instance for user
   */
  async getCalendarClient(userId: string) {
    const tokens = await this.getUserTokens(userId);
    
    if (!tokens) {
      throw new ApiError(401, 'Google Calendar not connected');
    }

    // Check if token is expired
    if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
      const newAccessToken = await this.refreshAccessToken(userId);
      tokens.access_token = newAccessToken;
    }

    this.oauth2Client.setCredentials(tokens);
    return google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  /**
   * Create calendar event for organizer with proper attendee list
   */
  async createEventForOrganizer(
    appointment: IAppointment,
    organizerId: string
  ): Promise<string | null> {
    try {
      const calendar = await this.getCalendarClient(organizerId);

      // Get participant emails
      const participantEmails: string[] = [];
      
      for (const p of appointment.participants) {
        if (typeof p === 'string') {
          try {
            const user = await User.findById(p).select('email');
            if (user?.email) {
              participantEmails.push(user.email);
            }
          } catch (err) {
            console.error('Failed to fetch participant email:', err);
          }
        } else if (p && typeof p === 'object' && 'email' in p) {
          participantEmails.push((p as any).email);
        }
      }

      // Add guest emails
      const guestEmails = appointment.guestEmails?.map(g => g.email) || [];
      const allAttendees = [...new Set([...participantEmails, ...guestEmails])];

      const event = {
        summary: appointment.title,
        description: this.buildEventDescription(appointment),
        location: appointment.location || '',
        start: {
          dateTime: appointment.startTime.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        end: {
          dateTime: appointment.endTime.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        attendees: allAttendees.map(email => ({
          email,
          responseStatus: 'needsAction'
        })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 30 },
          ],
        },
        ...(appointment.meetingLink && {
          conferenceData: {
            entryPoints: [{
              entryPointType: 'video',
              uri: appointment.meetingLink
            }]
          }
        }),
        // Add custom metadata to track our appointment
        extendedProperties: {
          private: {
            appointmentId: appointment._id.toString(),
            appSource: 'action-auto'
          }
        }
      };

      const response = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: event,
        conferenceDataVersion: appointment.meetingLink ? 1 : 0,
        sendUpdates: 'all'
      });

      console.log(`Created organizer calendar event: ${response.data.id}`);
      return response.data.id || null;
    } catch (error: any) {
      console.error('❌ Failed to create organizer calendar event:', error.message);
      return null;
    }
  }

  /**
   * Build rich event description
   */
  private buildEventDescription(appointment: IAppointment): string {
    let description = appointment.description || '';
    
    if (appointment.notes) {
      description += `\n\nNotes:\n${appointment.notes}`;
    }
    
    description += `\n\n--- Appointment Details ---`;
    description += `\nType: ${appointment.entryType.charAt(0).toUpperCase() + appointment.entryType.slice(1)}`;
    description += `\nMeeting Type: ${appointment.type}`;
    
    if (appointment.meetingLink) {
      description += `\n\nJoin Meeting: ${appointment.meetingLink}`;
    }
    
    description += `\n\nManage: ${process.env.FRONTEND_URL}/appointments`;
    description += `\nAppointment ID: ${appointment._id}`;
    
    return description.trim();
  }

  /**
   * Update calendar event
   */
  async updateEvent(
    eventId: string,
    appointment: IAppointment,
    userId: string
  ): Promise<void> {
    try {
      const calendar = await this.getCalendarClient(userId);

      const event = {
        summary: appointment.title,
        description: this.buildEventDescription(appointment),
        location: appointment.location || '',
        start: {
          dateTime: appointment.startTime.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        end: {
          dateTime: appointment.endTime.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      };

      await calendar.events.update({
        calendarId: 'primary',
        eventId: eventId,
        requestBody: event,
        sendUpdates: 'all'
      });

      console.log(`Updated calendar event: ${eventId}`);
    } catch (error) {
      console.error('Failed to update calendar event:', error);
      throw new ApiError(500, 'Failed to update calendar event');
    }
  }

  /**
   * Delete/cancel calendar event
   */
  async deleteEvent(eventId: string, userId: string): Promise<void> {
    try {
      const calendar = await this.getCalendarClient(userId);

      await calendar.events.delete({
        calendarId: 'primary',
        eventId: eventId,
        sendUpdates: 'all'
      });

      console.log(`Deleted calendar event: ${eventId}`);
    } catch (error) {
      console.error('❌ Failed to delete calendar event:', error);
    }
  }

  /**
   * Set up webhook for calendar changes (push notifications)
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

      // Save channel info to user record
      await User.findByIdAndUpdate(userId, {
        $set: {
          'googleCalendar.watchChannelId': channelId,
          'googleCalendar.watchResourceId': response.data.resourceId
        }
      });

      console.log(`Set up webhook for user ${userId}, channel ${channelId}`);
    } catch (error) {
      console.error('❌ Failed to set up webhook:', error);
      throw new ApiError(500, 'Failed to set up calendar notifications');
    }
  }

  /**
   * Process webhook notification from Google Calendar
   */
  async processWebhookNotification(
    channelId: string,
    resourceState: string,
    resourceId: string
  ): Promise<void> {
    try {
      console.log('📨 Processing webhook:', { channelId, resourceState, resourceId });

      // Find user by channel ID
      const user = await User.findOne({
        'googleCalendar.watchChannelId': channelId
      }) as IUserWithGoogleCalendar | null;

      if (!user) {
        console.log('No user found for channel:', channelId);
        return;
      }

      // Ignore sync messages
      if (resourceState === 'sync') {
        console.log('ℹ️ Sync message received, ignoring');
        return;
      }

      // Fetch changed events
      if (resourceState === 'exists') {
        await this.syncRecentEvents(user._id.toString());
      }
    } catch (error) {
      console.error('❌ Failed to process webhook notification:', error);
    }
  }

  /**
   * Sync recent events to check for RSVP changes
   */
  async syncRecentEvents(userId: string): Promise<void> {
    try {
      const calendar = await this.getCalendarClient(userId);

      const timeMin = new Date();
      timeMin.setDate(timeMin.getDate() - 7);
      const timeMax = new Date();
      timeMax.setDate(timeMax.getDate() + 30);

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      const events = response.data.items || [];

      for (const event of events) {
        const appointmentId = event.extendedProperties?.private?.appointmentId;
        
        if (appointmentId) {
          await this.checkEventRSVPStatus(appointmentId, event);
        }
      }

      console.log(`Synced ${events.length} events for user ${userId}`);
    } catch (error) {
      console.error('Failed to sync recent events:', error);
    }
  }

  /**
   * Check RSVP status changes and create notifications
   */
  private async checkEventRSVPStatus(appointmentId: string, event: any): Promise<void> {
    try {
      const appointment = await Appointment.findById(appointmentId)
        .populate('createdBy', 'name email');

      if (!appointment) {
        console.log('Appointment not found:', appointmentId);
        return;
      }

      const attendees = event.attendees || [];

      for (const attendee of attendees) {
        const email = attendee.email.toLowerCase();
        const guestIndex = appointment.guestEmails.findIndex(
          g => g.email.toLowerCase() === email
        );

        if (guestIndex === -1) continue;

        const currentGuest = appointment.guestEmails[guestIndex];
        const googleStatus = attendee.responseStatus;

        let newStatus: 'pending' | 'accepted' | 'declined' = 'pending';
        if (googleStatus === 'accepted') newStatus = 'accepted';
        else if (googleStatus === 'declined') newStatus = 'declined';

        if (currentGuest.status !== newStatus) {
          console.log(`📧 RSVP status changed for ${email}: ${currentGuest.status} → ${newStatus}`);

          appointment.guestEmails[guestIndex].status = newStatus;
          appointment.guestEmails[guestIndex].respondedAt = new Date();
          await appointment.save();

          await notificationService.createNotification({
            userId: appointment.createdBy._id.toString(),
            type: 'guest_response',
            title: `Guest Response - ${newStatus === 'accepted' ? 'Accepted' : 'Declined'}`,
            message: `${email} has ${newStatus} your invitation to "${appointment.title}"`,
            metadata: {
              appointmentId: appointment._id,
              guestEmail: email,
              status: newStatus,
              respondedAt: new Date()
            }
          });

          console.log(`Created notification for RSVP change: ${email} → ${newStatus}`);
        }
      }
    } catch (error) {
      console.error('Failed to check RSVP status:', error);
    }
  }

  /**
   * Manually fetch and update RSVP status for an event
   */
  async updateRSVPStatusFromGoogle(appointmentId: string, userId: string): Promise<void> {
    try {
      const appointment = await Appointment.findById(appointmentId);
      if (!appointment || !appointment.googleCalendarEventId) {
        return;
      }

      const calendar = await this.getCalendarClient(userId);
      const event = await calendar.events.get({
        calendarId: 'primary',
        eventId: appointment.googleCalendarEventId
      });

      await this.checkEventRSVPStatus(appointmentId, event.data);
    } catch (error) {
      console.error('Failed to update RSVP status from Google:', error);
    }
  }

  /**
   * Disconnect Google Calendar for user
   */
  async disconnectCalendar(userId: string): Promise<void> {
    try {
      const user = await User.findById(userId).select('googleCalendar') as IUserWithGoogleCalendar | null;

      if (user?.googleCalendar?.watchChannelId && user?.googleCalendar?.watchResourceId) {
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
          console.error('Failed to stop webhook channel:', error);
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
   * Create event for guest (deprecated - use ICS approach instead)
   */
  async createEventForGuest(
    appointment: IAppointment,
    guestEmail: string,
    accessToken: string
  ): Promise<string | null> {
    console.log('createEventForGuest called - ICS approach is recommended');
    return null;
  }
}

export default new GoogleCalendarService();