import { google } from 'googleapis';
import mongoose from 'mongoose';
import User from '../models/User.model';
import Conversation from '../models/Conversation.model';
import { ApiError } from '../utils/ApiError';

class GmailConversationService {
  private oauth2Client: any;

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  /**
   * Get Gmail client for user
   */
  private async getGmailClient(userId: string) {
    const user = await User.findById(userId).select('googleCalendar');

    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      throw new ApiError(401, 'Gmail not connected');
    }

    this.oauth2Client.setCredentials({
      access_token: user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date: user.googleCalendar.expiryDate,
    });

    // Handle token refresh
    this.oauth2Client.on('tokens', async (tokens: any) => {
      if (tokens.refresh_token) {
        await User.findByIdAndUpdate(userId, {
          'googleCalendar.accessToken': tokens.access_token,
          'googleCalendar.refreshToken': tokens.refresh_token,
          'googleCalendar.expiryDate': tokens.expiry_date,
        });
      }
    });

    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  /**
   * Send email to external recipient
   */
  async sendEmailToExternal(
    userId: string,
    to: string,
    subject: string,
    body: string,
    threadId?: string
  ): Promise<{ messageId: string; threadId: string }> {
    try {
      const gmail = await this.getGmailClient(userId);
      const user = await User.findById(userId).select('email name');

      if (!user) {
        throw new ApiError(404, 'User not found');
      }

      // Create email message
      const email = [
        `From: ${user.name} <${user.email}>`,
        `To: ${to}`,
        `Subject: ${subject}`,
        threadId ? `In-Reply-To: ${threadId}` : '',
        threadId ? `References: ${threadId}` : '',
        'Content-Type: text/html; charset=utf-8',
        '',
        body,
      ].filter(Boolean).join('\n');

      const encodedEmail = Buffer.from(email)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedEmail,
          threadId: threadId || undefined,
        },
      });

      console.log('Email sent successfully:', response.data.id);

      return {
        messageId: response.data.id || '',
        threadId: response.data.threadId || '',
      };
    } catch (error: any) {
      console.error('Failed to send email:', error);
      throw new ApiError(500, 'Failed to send email via Gmail');
    }
  }

  /**
   * Fetch emails from a specific thread
   */
  async fetchThreadMessages(userId: string, threadId: string): Promise<any[]> {
    try {
      const gmail = await this.getGmailClient(userId);

      const response = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });

      const messages = response.data.messages || [];
      
      return messages.map((msg: any) => {
        const headers = msg.payload.headers;
        const from = headers.find((h: any) => h.name === 'From')?.value || '';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '';
        const date = headers.find((h: any) => h.name === 'Date')?.value || '';

        // Extract email body
        let body = '';
        if (msg.payload.body.data) {
          body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
        } else if (msg.payload.parts) {
          const textPart = msg.payload.parts.find((part: any) => 
            part.mimeType === 'text/plain' || part.mimeType === 'text/html'
          );
          if (textPart?.body.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        }

        return {
          id: msg.id,
          threadId: msg.threadId,
          from,
          subject,
          body,
          date: new Date(date),
          snippet: msg.snippet,
        };
      });
    } catch (error) {
      console.error('Failed to fetch thread messages:', error);
      throw new ApiError(500, 'Failed to fetch email thread');
    }
  }

  /**
   * Check for new emails and sync to conversations
   */
  async syncInboxToConversations(userId: string, organizationId: string): Promise<number> {
    try {
      const gmail = await this.getGmailClient(userId);
      
      // Get emails from last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const query = `after:${Math.floor(sevenDaysAgo.getTime() / 1000)}`;

      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 100,
      });

      const messageIds = response.data.messages || [];
      let syncedCount = 0;

      for (const { id, threadId } of messageIds) {
        try {
          // Get full message details
          const messageResponse = await gmail.users.messages.get({
            userId: 'me',
            id: id!,
            format: 'full',
          });

          const message = messageResponse.data;
          const headers = message.payload?.headers || [];
          
          const from = headers.find((h: any) => h.name === 'From')?.value || '';
          const to = headers.find((h: any) => h.name === 'To')?.value || '';
          const subject = headers.find((h: any) => h.name === 'Subject')?.value || '';
          
          // Extract email address from "Name <email>" format
          const fromEmail = from.match(/<(.+?)>/)?.[1] || from;
          const toEmail = to.match(/<(.+?)>/)?.[1] || to;

          // Check if conversation exists for this thread
          let conversation = await Conversation.findOne({
            gmailThreadId: threadId,
            organizationId,
          });

          if (!conversation) {
            // Check if this email is from/to a customer booking
            const linkedBookings = await this.findLinkedBookings(fromEmail, toEmail, organizationId);

            // Create new external conversation
            conversation = await Conversation.create({
              type: 'external',
              organizationId,
              createdBy: userId,
              participants: [userId],
              externalEmails: [{
                email: fromEmail !== toEmail ? fromEmail : toEmail,
                addedAt: new Date(),
                gmailThreadId: threadId,
              }],
              gmailThreadId: threadId,
              metadata: {
                subject,
              },
              linkedCustomerBookings: linkedBookings,
              messages: [],
            });

            syncedCount++;
          }

          // Add message to conversation if not already exists
          const messageExists = conversation.messages.some(
            (msg: any) => msg.metadata?.gmailMessageId === id
          );

          if (!messageExists) {
            // Extract body
            let body = '';
            if (message.payload?.body?.data) {
              body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
            }

            conversation.messages.push({
              _id: new mongoose.Types.ObjectId().toString(),
              senderEmail: fromEmail,
              content: message.snippet || body.substring(0, 200),
              type: 'email',
              metadata: {
                emailSubject: subject,
                emailThreadId: threadId,
                gmailMessageId: id,
              },
              isFromExternal: true,
              readBy: [],
              createdAt: new Date(parseInt(message.internalDate || '0')),
            } as any);

            await conversation.save();
          }
        } catch (error) {
          console.error(`Failed to sync message ${id}:`, error);
        }
      }

      console.log(`Synced ${syncedCount} new email conversations`);
      return syncedCount;
    } catch (error) {
      console.error('Failed to sync inbox:', error);
      throw new ApiError(500, 'Failed to sync Gmail inbox');
    }
  }

  /**
   * Find customer bookings linked to an email
   */
  private async findLinkedBookings(
    fromEmail: string,
    toEmail: string,
    organizationId: string
  ): Promise<string[]> {
    const Appointment = (await import('../models/Appointment.model')).default;
    
    const bookings = await Appointment.find({
      organizationId,
      'customerBooking.isCustomerBooking': true,
      $or: [
        { 'customerBooking.email': fromEmail },
        { 'customerBooking.email': toEmail },
      ],
    }).select('_id');

    return bookings.map(b => b._id.toString());
  }
}

export default new GmailConversationService();