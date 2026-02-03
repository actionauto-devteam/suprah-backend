// services/email.service.ts

import nodemailer from 'nodemailer';
import config from '../config';
import { ApiError } from '../utils/ApiError';
import { IAppointment } from '../models/Appointment.model';
import { IUser } from '../models/User.model';

interface EmailOptions {
    to: string;
    subject: string;
    text: string;
    html?: string;
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
     * Generic email sending method (existing functionality)
     */
    async sendEmail(options: EmailOptions): Promise<void> {
        const mailOptions = {
            from: `Action Auto <${config.email.from}>`,
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html,
        };

        try {
            const info = await this.transporter.sendMail(mailOptions);
            console.log('Message sent: %s', info.messageId);
        } catch (error) {
            console.error('Error sending email:', error);
            throw new ApiError(500, 'There was an error sending the email.');
        }
    }

    /**
     * Send appointment invitation to external guest
     */
    async sendAppointmentInvitation(
        appointment: IAppointment,
        organizer: IUser,
        guestEmail: string,
        token: string
    ): Promise<void> {
        const acceptUrl = `${process.env.FRONTEND_URL}/api/appointments/${appointment._id}/guest-response?token=${token}&status=accepted`;
        const declineUrl = `${process.env.FRONTEND_URL}/api/appointments/${appointment._id}/guest-response?token=${token}&status=declined`;

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
                    .buttons { 
                        text-align: center; 
                        margin: 30px 0; 
                    }
                    .btn { 
                        display: inline-block; 
                        padding: 14px 32px; 
                        margin: 0 8px; 
                        text-decoration: none; 
                        border-radius: 6px; 
                        font-weight: bold;
                        font-size: 16px;
                        transition: all 0.3s;
                    }
                    .btn-accept { 
                        background: #10b981; 
                        color: white; 
                    }
                    .btn-accept:hover {
                        background: #059669;
                    }
                    .btn-decline { 
                        background: #ef4444; 
                        color: white; 
                    }
                    .btn-decline:hover {
                        background: #dc2626;
                    }
                    .info-box {
                        background: #fef3c7;
                        border-left: 4px solid #f59e0b;
                        padding: 12px 16px;
                        margin: 20px 0;
                        border-radius: 4px;
                    }
                    .info-box p {
                        margin: 0;
                        color: #92400e;
                        font-size: 14px;
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
                        <p style="margin: 8px 0 0 0; opacity: 0.9;">Action Auto Appointment System</p>
                    </div>
                    
                    <div class="content">
                        <p style="font-size: 16px; margin-bottom: 8px;">Hi there,</p>
                        <p style="font-size: 16px;"><strong>Action Auto Utah</strong> has invited you to:</p>
                        
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
                                <span class="detail-value">${organizer.email}</span>
                            </div>
                        </div>

                        <div class="buttons">
                            <a href="${acceptUrl}" class="btn btn-accept">✓ Accept Invitation</a>
                            <a href="${declineUrl}" class="btn btn-decline">✗ Decline</a>
                        </div>

                        <div class="info-box">
                            <p>By accepting, this event will be automatically added to your Google Calendar.</p>
                        </div>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Action Auto - Appointment System</strong></p>
                        <p>This invitation was sent by Action Auto Utah</p>
                        <p>If you have questions, please contact the organizer directly at ${organizer.email}</p>
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

To accept this invitation, visit: ${acceptUrl}
To decline, visit: ${declineUrl}

By accepting, this event will be automatically added to your Google Calendar.
        `;

        await this.sendEmail({
            to: guestEmail,
            subject: `Invitation: ${appointment.title} - Action Auto`,
            text,
            html
        });
    }

    /**
     * Send appointment update notification
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
                        </div>

                        <p style="margin-top: 20px;">Please check your calendar for the complete updated details.</p>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Action Auto - Appointment System</strong></p>
                        <p>For questions, please kindly email the organizer at ${organizer.email}</p>
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

Please check your calendar for the complete updated details.

For questions, please kindly email the organizer at ${organizer.email}
        `;

        await this.sendEmail({
            to: guestEmail,
            subject: `Updated: ${appointment.title} - Action Auto`,
            text,
            html
        });
    }

    /**
     * Send appointment cancellation notification
     */
    async sendAppointmentCancellation(
        appointment: IAppointment,
        organizer: IUser,
        guestEmail: string
    ): Promise<void> {
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
                        
                        <p style="margin-top: 20px; color: #6b7280;">This event has been removed from your calendar.</p>
                    </div>
                    
                    <div class="footer">
                        <p><strong>Action Auto - Appointment System</strong></p>
                        <p>For questions, please kindly email the organizer at ${organizer.email}</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        const text = `
Appointment Cancelled

The appointment "${appointment.title}" has been cancelled by organizer.

This event has been removed from your calendar.

For questions, please kindly email the organizer at ${organizer.email}
        `;

        await this.sendEmail({
            to: guestEmail,
            subject: `Cancelled: ${appointment.title} - Action Auto`,
            text,
            html
        });
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
                            ${appointment.meetingLink ? `<p style="margin: 4px 0 0 0;">🔗 <a href="${appointment.meetingLink}" style="color: #8b5cf6;">Join Meeting</a></p>` : ''}
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
            subject: `Reminder: ${appointment.title} - Action Auto`,
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