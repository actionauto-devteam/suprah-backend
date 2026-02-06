import nodemailer from 'nodemailer';
import config from '../config';
import { ApiError } from '../utils/ApiError';
import { IAppointment } from '../models/Appointment.model';
import { IUser } from '../models/User.model';
import ical, { ICalAttendeeStatus, ICalAttendeeRole, ICalEventStatus, ICalAlarmType, ICalCalendarMethod } from 'ical-generator';

interface EmailOptions {
    to: string;
    subject: string;
    text: string;
    html?: string;
    icalEvent?: any; // ICS attachment
}

class EmailService {
    private transporter: nodemailer.Transporter;

    constructor() {
        // Initialize transporter using existing config
        this.transporter = nodemailer.createTransport({
            host: config.email.host,
            port: config.email.port,
            secure: config.email.port === 465,
            auth: {
                user: config.email.user,
                pass: config.email.pass,
            }
        });
    }

    /**
     * Generic email sending method with ICS support
     */
    async sendEmail(options: EmailOptions): Promise<void> {
        const mailOptions: any = {
            from: `Action Auto <${config.email.from}>`,
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html,
        };

        // Add ICS attachment if provided
        if (options.icalEvent) {
            mailOptions.alternatives = [{
                contentType: 'text/calendar; charset="utf-8"; method=REQUEST',
                content: Buffer.from(options.icalEvent.toString()),
            }];
            mailOptions.attachments = [{
                filename: 'invite.ics',
                content: options.icalEvent.toString(),
                contentType: 'text/calendar; charset="utf-8"; method=REQUEST'
            }];
        }

        try {
            const info = await this.transporter.sendMail(mailOptions);
            console.log('Message sent: %s', info.messageId);
        } catch (error) {
            console.error('Error sending email:', error);
            throw new ApiError(500, 'There was an error sending the email.');
        }
    }

    /**
     * Generate ICS calendar event
     */
    private generateICS(
        appointment: IAppointment,
        organizer: IUser,
        guestEmail: string,
        method: 'REQUEST' | 'CANCEL' = 'REQUEST'
    ): any {
        const calendar = ical({ 
            name: 'Action Auto Appointment',
            method: method === 'REQUEST' ? ICalCalendarMethod.REQUEST : ICalCalendarMethod.CANCEL
        });

        const event = calendar.createEvent({
            start: appointment.startTime,
            end: appointment.endTime,
            summary: appointment.title,
            description: this.buildEventDescription(appointment),
            location: appointment.location || '',
            url: appointment.meetingLink || undefined,
            organizer: {
                name: organizer.name,
                email: organizer.email
            },
            attendees: [
                {
                    name: guestEmail.split('@')[0],
                    email: guestEmail,
                    rsvp: true,
                    status: ICalAttendeeStatus.NEEDSACTION,
                    role: ICalAttendeeRole.REQ
                }
            ],
            status: method === 'CANCEL' ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
            alarms: [
                {
                    type: ICalAlarmType.display,
                    trigger: 1800,
                    description: `Reminder: ${appointment.title}`
                }
            ]
        });

        event.uid(`appointment-${appointment._id}@actionauto.com`);
        event.sequence(0);

        return calendar;
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
        
        description += `\n\nOrganized by Action Auto Utah`;
        
        return description.trim();
    }

    /**
     * Send appointment invitation to external guest WITH ICS ATTACHMENT
     * UPDATED: Removed manual accept/decline buttons - relies on Google Calendar RSVP
     */
    async sendAppointmentInvitation(
        appointment: IAppointment,
        organizer: IUser,
        guestEmail: string,
        token: string
    ): Promise<void> {
        const startDate = new Date(appointment.startTime).toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        const endDate = new Date(appointment.endTime).toLocaleString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });

        // Generate ICS file
        const icsCalendar = this.generateICS(appointment, organizer, guestEmail, 'REQUEST');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        line-height: 1.6; 
                        color: #333; 
                        background-color: #f4f4f4;
                        margin: 0;
                        padding: 0;
                    }
                    .container { 
                        max-width: 600px; 
                        margin: 20px auto; 
                        background: white;
                        border-radius: 8px;
                        overflow: hidden;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    .header { 
                        background: #10b981; 
                        color: white; 
                        padding: 30px 20px; 
                        text-align: center;
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 24px;
                    }
                    .content { 
                        padding: 30px; 
                    }
                    .details { 
                        background: #f9fafb; 
                        padding: 20px; 
                        border-radius: 8px; 
                        margin: 20px 0; 
                        border-left: 4px solid #10b981;
                    }
                    .details h2 {
                        margin-top: 0;
                        color: #1f2937;
                        font-size: 20px;
                    }
                    .detail-row { 
                        display: flex; 
                        padding: 10px 0; 
                        border-bottom: 1px solid #e5e7eb; 
                    }
                    .detail-row:last-child {
                        border-bottom: none;
                    }
                    .detail-label { 
                        font-weight: bold; 
                        min-width: 120px;
                        color: #4b5563;
                    }
                    .detail-value {
                        flex: 1;
                        color: #1f2937;
                    }
                    .calendar-section {
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        padding: 24px;
                        border-radius: 8px;
                        margin: 24px 0;
                        text-align: center;
                    }
                    .calendar-section h3 {
                        margin: 0 0 12px 0;
                        font-size: 18px;
                        font-weight: 600;
                    }
                    .calendar-section p {
                        margin: 8px 0;
                        opacity: 0.95;
                        font-size: 14px;
                        line-height: 1.5;
                    }
                    .calendar-icon {
                        font-size: 48px;
                        margin-bottom: 12px;
                    }
                    .info-box {
                        background: #dbeafe;
                        border-left: 4px solid #3b82f6;
                        padding: 16px;
                        margin: 20px 0;
                        border-radius: 4px;
                    }
                    .info-box p {
                        margin: 0;
                        color: #1e40af;
                        font-size: 14px;
                        line-height: 1.6;
                    }
                    .info-box p strong {
                        display: block;
                        margin-bottom: 8px;
                        font-size: 15px;
                    }
                    .footer { 
                        text-align: center; 
                        color: #6b7280; 
                        font-size: 12px; 
                        padding: 20px;
                        background: #f9fafb;
                        border-top: 1px solid #e5e7eb;
                    }
                    .footer p {
                        margin: 5px 0;
                    }
                    .logo {
                        font-size: 32px;
                        margin-bottom: 8px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div class="logo">ACTION AUTO UTAH</div>
                        <h1>You're Invited!</h1>
                        <p style="margin: 8px 0 0 0; opacity: 0.9;">Calendar Invitation</p>
                    </div>
                    
                    <div class="content">
                        <p style="font-size: 16px; margin-bottom: 8px;">Hi there,</p>
                        <p style="font-size: 16px;"><strong>${organizer.name}</strong> has invited you to:</p>
                        
                        <div class="details">
                            <h2>${appointment.title}</h2>
                            ${appointment.description ? `<p style="color: #6b7280; margin: 12px 0;">${appointment.description}</p>` : ''}
                            
                            <div class="detail-row">
                                <span class="detail-label">When:</span>
                                <span class="detail-value">${startDate} - ${endDate}</span>
                            </div>
                            
                            ${appointment.location ? `
                                <div class="detail-row">
                                    <span class="detail-label">Where:</span>
                                    <span class="detail-value">${appointment.location}</span>
                                </div>
                            ` : ''}
                            
                            ${appointment.meetingLink ? `
                                <div class="detail-row">
                                    <span class="detail-label">Meeting Link:</span>
                                    <span class="detail-value"><a href="${appointment.meetingLink}" style="color: #10b981; text-decoration: none;">${appointment.meetingLink}</a></span>
                                </div>
                            ` : ''}
                            
                            <div class="detail-row">
                                <span class="detail-label">Type:</span>
                                <span class="detail-value">${appointment.entryType.charAt(0).toUpperCase() + appointment.entryType.slice(1)}</span>
                            </div>
                            
                            <div class="detail-row">
                                <span class="detail-label">Organizer:</span>
                                <span class="detail-value">${organizer.name} (${organizer.email})</span>
                            </div>
                        </div>

                        <div class="info-box">
                            <p><strong>📎 Calendar Attachment Included</strong></p>
                            <p>This email includes a calendar file (.ics) that works with Google Calendar, Outlook, Apple Calendar, and other calendar apps.</p>
                        </div>

                        <!-- GOOGLE CALENDAR RESPONSE SECTION -->
                        <div class="calendar-section">
                          
                            <h3>Add to Your Calendar & RSVP</h3>
                            <p><strong>Look for the calendar invitation buttons at the top of this email:</strong></p>
                            <p>• Gmail/Google Calendar: "Yes" / "No" / "Maybe" buttons</p>
                            <p>• Outlook: "Accept" / "Tentative" / "Decline" buttons</p>
                            <p>• Apple Mail: "Add to Calendar" option</p>
                            <p style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.3);">
                                <strong>Your response will automatically notify ${organizer.name}</strong><br/>
                                When you click Yes or No in your calendar app, the organizer will be notified instantly.
                            </p>
                        </div>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Action Auto - Appointment System</strong></p>
                        <p>Questions? Contact ${organizer.email}</p>
                        <p style="margin-top: 12px; color: #9ca3af; font-size: 11px;">
                            This is an automated calendar invitation. Your RSVP via your calendar app will notify the organizer.
                        </p>
                    </div>
                </div>
            </body>
            </html>
        `;

        const text = `
You're Invited!

${organizer.name} has invited you to: ${appointment.title}

When: ${startDate} - ${endDate}
${appointment.location ? `Where: ${appointment.location}` : ''}
${appointment.meetingLink ? `Meeting Link: ${appointment.meetingLink}` : ''}
Type: ${appointment.entryType}
Organizer: ${organizer.name} (${organizer.email})

CALENDAR ATTACHMENT INCLUDED
============================
This email includes a calendar file (.ics) that you can add to Google Calendar, Outlook, Apple Calendar, or any calendar app.

ADD TO YOUR CALENDAR & RSVP:
Most email clients will show calendar invitation buttons at the top of this email:
- Gmail/Google Calendar: Click "Yes" / "No" / "Maybe"
- Outlook: Click "Accept" / "Tentative" / "Decline"  
- Apple Mail: Look for "Add to Calendar" option

YOUR RESPONSE WILL AUTOMATICALLY NOTIFY THE ORGANIZER
When you click Yes or No in your calendar app, ${organizer.name} will be notified instantly.

---
Action Auto - Appointment System
Questions? Contact ${organizer.email}
        `;

        await this.sendEmail({
            to: guestEmail,
            subject: `Invitation: ${appointment.title}`,
            text,
            html,
            icalEvent: icsCalendar
        });

        console.log(`Sent invitation with ICS attachment to ${guestEmail}`);
    }

    /**
     * Send appointment update notification with updated ICS
     */
    async sendAppointmentUpdate(
        appointment: IAppointment,
        organizer: IUser,
        guestEmail: string
    ): Promise<void> {
        const startDate = new Date(appointment.startTime).toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        // Generate updated ICS file (same UID, incremented sequence)
        const icsCalendar = this.generateICS(appointment, organizer, guestEmail, 'REQUEST');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        line-height: 1.6; 
                        color: #333; 
                        background-color: #f4f4f4;
                        margin: 0;
                        padding: 0;
                    }
                    .container { 
                        max-width: 600px; 
                        margin: 20px auto; 
                        background: white;
                        border-radius: 8px;
                        overflow: hidden;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    .header { 
                        background: #f59e0b; 
                        color: white; 
                        padding: 30px 20px; 
                        text-align: center;
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 24px;
                    }
                    .content { 
                        padding: 30px; 
                    }
                    .details {
                        background: #fef3c7;
                        border-left: 4px solid #f59e0b;
                        padding: 16px;
                        margin: 20px 0;
                        border-radius: 4px;
                    }
                    .info-box {
                        background: #dbeafe;
                        border-left: 4px solid #3b82f6;
                        padding: 12px 16px;
                        margin: 20px 0;
                        border-radius: 4px;
                    }
                    .footer { 
                        text-align: center; 
                        color: #6b7280; 
                        font-size: 12px; 
                        padding: 20px;
                        background: #f9fafb;
                        border-top: 1px solid #e5e7eb;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>Appointment Updated</h1>
                    </div>
                    
                    <div class="content">
                        <p style="font-size: 16px;">Hello,</p>
                        <p style="font-size: 16px;">The appointment "<strong>${appointment.title}</strong>" has been updated by ${organizer.name}.</p>
                        
                        <div class="details">
                            <p style="margin: 0;"><strong>Updated Details:</strong></p>
                            <p style="margin: 8px 0 0 0;">${startDate}</p>
                            ${appointment.location ? `<p style="margin: 4px 0 0 0;">${appointment.location}</p>` : ''}
                            ${appointment.meetingLink ? `<p style="margin: 4px 0 0 0;"><a href="${appointment.meetingLink}">${appointment.meetingLink}</a></p>` : ''}
                        </div>

                        <div class="info-box">
                            <p><strong>Your calendar has been automatically updated</strong></p>
                            <p style="margin-top: 8px;">This email includes an updated calendar attachment. Your calendar app should automatically update the event details.</p>
                        </div>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Action Auto - Appointment System</strong></p>
                        <p>Questions? Contact ${organizer.email}</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        const text = `
Appointment Updated

The appointment "${appointment.title}" has been updated by ${organizer.name}.

Updated Details:
When: ${startDate}
${appointment.location ? `Where: ${appointment.location}` : ''}
${appointment.meetingLink ? `Meeting Link: ${appointment.meetingLink}` : ''}

This email includes an updated calendar attachment.
Your calendar should automatically update the event details.

Questions? Contact ${organizer.email}
        `;

        await this.sendEmail({
            to: guestEmail,
            subject: `Updated: ${appointment.title}`,
            text,
            html,
            icalEvent: icsCalendar
        });

        console.log(`Sent update with ICS attachment to ${guestEmail}`);
    }

    /**
     * Send appointment cancellation notification with CANCEL ICS
     */
    async sendAppointmentCancellation(
        appointment: IAppointment,
        organizer: IUser,
        guestEmail: string
    ): Promise<void> {
        // Generate cancellation ICS file
        const icsCalendar = this.generateICS(appointment, organizer, guestEmail, 'CANCEL');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        line-height: 1.6; 
                        color: #333; 
                        background-color: #f4f4f4;
                        margin: 0;
                        padding: 0;
                    }
                    .container { 
                        max-width: 600px; 
                        margin: 20px auto; 
                        background: white;
                        border-radius: 8px;
                        overflow: hidden;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    .header { 
                        background: #ef4444; 
                        color: white; 
                        padding: 30px 20px; 
                        text-align: center;
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 24px;
                    }
                    .content { 
                        padding: 30px; 
                    }
                    .info-box {
                        background: #fee2e2;
                        border-left: 4px solid #ef4444;
                        padding: 12px 16px;
                        margin: 20px 0;
                        border-radius: 4px;
                    }
                    .footer { 
                        text-align: center; 
                        color: #6b7280; 
                        font-size: 12px; 
                        padding: 20px;
                        background: #f9fafb;
                        border-top: 1px solid #e5e7eb;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>Appointment Cancelled</h1>
                    </div>
                    
                    <div class="content">
                        <p style="font-size: 16px;">Hello,</p>
                        <p style="font-size: 16px;">The appointment "<strong>${appointment.title}</strong>" has been cancelled by the organizer.</p>
                        
                        <div class="info-box">
                            <p><strong>This event has been removed from your calendar</strong></p>
                            <p style="margin-top: 8px;">Your calendar app should automatically remove or mark this event as cancelled.</p>
                        </div>

                        <p style="margin-top: 20px; color: #6b7280;">We apologize for any inconvenience.</p>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Action Auto - Appointment System</strong></p>
                        <p>Questions? Contact ${organizer.email}</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        const text = `
Appointment Cancelled

The appointment "${appointment.title}" has been cancelled by the organizer.

This event has been removed from your calendar.
Your calendar app should automatically remove or mark this event as cancelled.

We apologize for any inconvenience.

Questions? Contact ${organizer.email}
        `;

        await this.sendEmail({
            to: guestEmail,
            subject: `Cancelled: ${appointment.title}`,
            text,
            html,
            icalEvent: icsCalendar
        });

        console.log(`Sent cancellation with ICS attachment to ${guestEmail}`);
    }

    /**
     * Send appointment reminder
     */
    async sendAppointmentReminder(
        appointment: IAppointment,
        recipientEmail: string,
        recipientName: string
    ): Promise<void> {
        const startDate = new Date(appointment.startTime).toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        line-height: 1.6; 
                        color: #333; 
                        background-color: #f4f4f4;
                        margin: 0;
                        padding: 0;
                    }
                    .container { 
                        max-width: 600px; 
                        margin: 20px auto; 
                        background: white;
                        border-radius: 8px;
                        overflow: hidden;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    .header { 
                        background: #8b5cf6; 
                        color: white; 
                        padding: 30px 20px; 
                        text-align: center;
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 24px;
                    }
                    .content { 
                        padding: 30px; 
                    }
                    .details {
                        background: #f3e8ff;
                        border-left: 4px solid #8b5cf6;
                        padding: 16px;
                        margin: 20px 0;
                        border-radius: 4px;
                    }
                    .footer { 
                        text-align: center; 
                        color: #6b7280; 
                        font-size: 12px; 
                        padding: 20px;
                        background: #f9fafb;
                        border-top: 1px solid #e5e7eb;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>Appointment Reminder</h1>
                    </div>
                    
                    <div class="content">
                        <p style="font-size: 16px;">Hi ${recipientName},</p>
                        <p style="font-size: 16px;">This is a reminder about your upcoming appointment:</p>
                        
                        <div class="details">
                            <p style="margin: 0; font-weight: bold; font-size: 18px;">${appointment.title}</p>
                            <p style="margin: 12px 0 0 0;">${startDate}</p>
                            ${appointment.location ? `<p style="margin: 4px 0 0 0;">${appointment.location}</p>` : ''}
                            ${appointment.meetingLink ? `<p style="margin: 4px 0 0 0;"><a href="${appointment.meetingLink}" style="color: #8b5cf6;">Join Meeting</a></p>` : ''}
                        </div>

                        <p style="margin-top: 20px;">See you there!</p>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Action Auto - Appointment System</strong></p>
                    </div>
                </div>
            </body>
            </html>
        `;

        const text = `
Appointment Reminder

Hi ${recipientName},

This is a reminder about your upcoming appointment:

${appointment.title}
When: ${startDate}
${appointment.location ? `Where: ${appointment.location}` : ''}
${appointment.meetingLink ? `Meeting Link: ${appointment.meetingLink}` : ''}

See you there!
        `;

        await this.sendEmail({
            to: recipientEmail,
            subject: `Reminder: ${appointment.title}`,
            text,
            html
        });
    }
}

// Export as singleton instance to maintain compatibility with existing code
const emailService = new EmailService();

export default {
    sendEmail: emailService.sendEmail.bind(emailService),
    sendAppointmentInvitation: emailService.sendAppointmentInvitation.bind(emailService),
    sendAppointmentUpdate: emailService.sendAppointmentUpdate.bind(emailService),
    sendAppointmentCancellation: emailService.sendAppointmentCancellation.bind(emailService),
    sendAppointmentReminder: emailService.sendAppointmentReminder.bind(emailService),
};