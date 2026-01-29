import nodemailer from 'nodemailer';
import config from '../config';
import { ApiError } from '../utils/ApiError';
// Placeholder for email sending logic.
// You would replace this with a real email service like Nodemailer, SendGrid, etc.

interface EmailOptions {
    to: string;
    subject:string;
    text: string;
    html?: string;
}

const sendEmail = async (options: EmailOptions): Promise<void> => {
    // 1. Create a transporter
    // In production, you would use a real email service like SendGrid, Mailgun, or AWS SES.
    // For development, you can use a service like Mailtrap.io or even a local SMTP server.
    const transporter = nodemailer.createTransport({
        host: config.email.host, // e.g., 'smtp.mailtrap.io' or 'smtp.gmail.com'
        port: config.email.port, // e.g., 2525 or 587
        secure: config.email.port === 465, // true for 465, false for other ports
        auth: {
            user: config.email.user, // generated ethereal user or your service user
            pass: config.email.pass, // generated ethereal password or your service password
        }
    });

    // 2. Define the email options
    const mailOptions = {
        from: `Action Auto <${config.email.from}>`,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
    };

    // 3. Actually send the email
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Message sent: %s', info.messageId);
    } catch (error) {
        console.error('Error sending email:', error);
        throw new ApiError(500, 'There was an error sending the email.');
    }
};

export default {
    sendEmail,
};