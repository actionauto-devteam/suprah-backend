import { google } from 'googleapis';
import { IAppointment } from '../models/Appointment.model';

class GoogleCalendarService {
  private oauth2Client: any;

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  async createEvent(
    appointment: IAppointment,
    guestEmail: string,
    accessToken: string
  ) {
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const event = {
      summary: appointment.title,
      description: appointment.description || '',
      location: appointment.location || '',
      start: {
        dateTime: appointment.startTime.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: appointment.endTime.toISOString(),
        timeZone: 'UTC',
      },
      attendees: [{ email: guestEmail }],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 },
          { method: 'popup', minutes: 30 },
        ],
      },
      conferenceData: appointment.meetingLink ? {
        entryPoints: [{
          entryPointType: 'video',
          uri: appointment.meetingLink
        }]
      } : undefined
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      conferenceDataVersion: appointment.meetingLink ? 1 : 0
    });

    return response.data.id;
  }

  async updateEvent(
    eventId: string,
    appointment: IAppointment,
    accessToken: string
  ) {
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const event = {
      summary: appointment.title,
      description: appointment.description || '',
      location: appointment.location || '',
      start: {
        dateTime: appointment.startTime.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: appointment.endTime.toISOString(),
        timeZone: 'UTC',
      },
    };

    await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      requestBody: event
    });
  }

  async deleteEvent(eventId: string, accessToken: string) {
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId
    });
  }
}

export default new GoogleCalendarService();