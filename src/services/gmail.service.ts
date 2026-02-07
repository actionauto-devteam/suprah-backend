import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import User, { IUser } from '../models/User.model';
import Conversation from '../models/Conversation.model';
import { ApiError } from '../utils/ApiError';
import mongoose from 'mongoose';

interface IUserWithGoogleCalendar extends IUser {
  googleCalendar?: {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
  };
}

class GmailService {
  private oauth2Client: OAuth2Client;

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `${process.env.BACKEND_URL}/api/google-calendar/callback`
    );
  }

  /**
   * Get authenticated Gmail client
   */
  private async getGmailClient(userId: string) {
    const user = await User.findById(userId).select('googleCalendar') as IUserWithGoogleCalendar | null;

    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      throw new ApiError(401, 'Gmail not connected. Please connect Google Calendar first.');
    }

    // Check if token is expired
    if (user.googleCalendar.expiryDate && user.googleCalendar.expiryDate < Date.now()) {
      // Refresh token logic (should be in a separate service)
      throw new ApiError(401, 'Token expired. Please reconnect Google Calendar.');
    }

    this.oauth2Client.setCredentials({
      access_token: user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date: user.googleCalendar.expiryDate
    });

    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  /**
   * Send email via Gmail
   */
  async sendEmail(
    userId: string,
    to: string,
    subject: string,
    body: string,
    conversationId?: string
  ) {
    try {
      const gmail = await this.getGmailClient(userId);
      const user = await User.findById(userId).select('email name');

      if (!user) {
        throw new ApiError(404, 'User not found');
      }

      // Create email message
      const messageParts = [
        `From: ${user.name} <${user.email}>`,
        `To: ${to}`,
        `Subject: ${subject}`,
        '',
        body
      ];

      const message = messageParts.join('\n');
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage
        }
      });

      console.log(`✅ Sent email via Gmail: ${response.data.id}`);

      // Save to conversation if provided
      if (conversationId) {
        await this.saveMessageToConversation(
          conversationId,
          userId,
          body,
          'outgoing',
          response.data.id!
        );
      }

      return response.data;
    } catch (error: any) {
      console.error('❌ Failed to send email via Gmail:', error.message);
      throw new ApiError(500, 'Failed to send email via Gmail');
    }
  }

  /**
   * Fetch emails from Gmail
   */
  async fetchEmails(userId: string, query: string = '', maxResults: number = 50) {
    try {
      const gmail = await this.getGmailClient(userId);

      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults
      });

      const messages = response.data.messages || [];
      console.log(`✅ Found ${messages.length} emails in Gmail`);

      // Fetch full message details
      const fullMessages = await Promise.all(
        messages.map(async (message) => {
          try {
            const details = await gmail.users.messages.get({
              userId: 'me',
              id: message.id!
            });
            return details.data;
          } catch (error) {
            console.error(`Failed to fetch message ${message.id}:`, error);
            return null;
          }
        })
      );

      return fullMessages.filter(Boolean);
    } catch (error: any) {
      console.error('❌ Failed to fetch emails from Gmail:', error.message);
      throw new ApiError(500, 'Failed to fetch emails from Gmail');
    }
  }

  /**
   * Create or get conversation with external email
   */
  async createExternalConversation(
    userId: string,
    organizationId: string,
    externalEmail: string,
    externalName?: string
  ) {
    try {
      // Check if conversation already exists
      let conversation = await Conversation.findOne({
        organizationId,
        type: 'direct',
        participants: userId,
        'externalParticipant.email': externalEmail.toLowerCase()
      });

      if (!conversation) {
        // Create new conversation with external participant
        conversation = await Conversation.create({
          type: 'direct',
          organizationId,
          participants: [userId],
          externalParticipant: {
            email: externalEmail.toLowerCase(),
            name: externalName || externalEmail.split('@')[0],
            isExternal: true
          },
          messages: []
        });

        console.log(`✅ Created conversation with external email: ${externalEmail}`);
      }

      return conversation;
    } catch (error: any) {
      console.error('❌ Failed to create external conversation:', error.message);
      throw new ApiError(500, 'Failed to create conversation');
    }
  }

  /**
   * Save message to conversation
   */
  private async saveMessageToConversation(
    conversationId: string,
    senderId: string,
    content: string,
    direction: 'incoming' | 'outgoing',
    gmailMessageId: string
  ) {
    try {
      const message = {
        sender: new mongoose.Types.ObjectId(senderId),
        content,
        type: 'text' as const,
        metadata: {
          gmailMessageId,
          direction
        },
        readBy: [new mongoose.Types.ObjectId(senderId)],
        createdAt: new Date()
      };

      await Conversation.findByIdAndUpdate(conversationId, {
        $push: { messages: message },
        lastMessage: content,
        lastMessageAt: new Date(),
        lastMessageBy: new mongoose.Types.ObjectId(senderId)
      });

      console.log(`✅ Saved ${direction} message to conversation ${conversationId}`);
    } catch (error) {
      console.error('Failed to save message to conversation:', error);
    }
  }

  /**
   * Sync Gmail inbox with conversations
   */
  async syncGmailConversations(userId: string, organizationId: string) {
    try {
      console.log(`📧 Syncing Gmail conversations for user ${userId}`);

      // Fetch recent emails (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const query = `after:${Math.floor(sevenDaysAgo.getTime() / 1000)}`;

      const emails = await this.fetchEmails(userId, query, 100);

      let syncedCount = 0;

      for (const email of emails) {
        try {
          if (!email || !email.payload) continue;

          const headers = email.payload.headers || [];
          const from = headers.find((h: any) => h.name === 'From')?.value || '';
          const to = headers.find((h: any) => h.name === 'To')?.value || '';
          const subject = headers.find((h: any) => h.name === 'Subject')?.value || '';

          // Extract email address
          const fromEmail = this.extractEmail(from);
          const toEmail = this.extractEmail(to);

          if (!fromEmail || !toEmail) continue;

          // Determine if this is incoming or outgoing
          const user = await User.findById(userId).select('email');
          if (!user) continue;

          const isOutgoing = fromEmail.toLowerCase() === user.email.toLowerCase();
          const externalEmail = isOutgoing ? toEmail : fromEmail;
          const externalName = isOutgoing
            ? this.extractName(to) || toEmail
            : this.extractName(from) || fromEmail;

          // Get or create conversation
          const conversation = await this.createExternalConversation(
            userId,
            organizationId,
            externalEmail,
            externalName
          );

          // Check if this message already exists
          const existingMessage = conversation.messages.find(
            (m: any) => m.metadata?.gmailMessageId === email.id
          );

          if (!existingMessage) {
            // Extract email body
            const body = this.extractEmailBody(email.payload);

            // Save message
            await this.saveMessageToConversation(
              conversation._id.toString(),
              userId,
              body || subject,
              isOutgoing ? 'outgoing' : 'incoming',
              email.id!
            );

            syncedCount++;
          }
        } catch (error) {
          console.error(`Failed to sync email ${email?.id || 'unknown'}:`, error);
        }
      }

      console.log(`✅ Synced ${syncedCount} Gmail conversations`);

      return {
        totalEmails: emails.length,
        syncedConversations: syncedCount
      };
    } catch (error: any) {
      console.error('❌ Failed to sync Gmail conversations:', error.message);
      throw new ApiError(500, 'Failed to sync Gmail conversations');
    }
  }

  /**
   * Extract email address from header value
   */
  private extractEmail(headerValue: string): string {
    const match = headerValue.match(/<(.+?)>/);
    if (match) {
      return match[1];
    }
    // If no angle brackets, assume the whole value is an email
    return headerValue.trim();
  }

  /**
   * Extract name from header value
   */
  private extractName(headerValue: string): string | null {
    const match = headerValue.match(/^(.+?)\s*</);
    if (match) {
      return match[1].trim().replace(/"/g, '');
    }
    return null;
  }

  /**
   * Extract email body from payload
   */
  private extractEmailBody(payload: any): string {
    if (payload.body && payload.body.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }

      // Try HTML if no plain text
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
          // Strip HTML tags (basic)
          return html.replace(/<[^>]*>/g, '');
        }
      }
    }

    return '';
  }

  /**
   * Check if user has Gmail connected
   */
  async isGmailConnected(userId: string): Promise<boolean> {
    const user = await User.findById(userId).select('googleCalendar') as IUserWithGoogleCalendar | null;
    return !!(user?.googleCalendar?.connected && user.googleCalendar.accessToken);
  }

  /**
   * Link external email conversation to customer booking
   */
  async linkConversationToCustomerBooking(
    conversationId: string,
    externalEmail: string,
    organizationId: string
  ) {
    try {
      // Find customer bookings with matching email
      const appointments = await mongoose.model('Appointment').find({
        organizationId,
        'customerBooking.email': externalEmail.toLowerCase(),
        'customerBooking.isCustomerBooking': true
      }).sort({ createdAt: -1 });

      if (appointments.length > 0) {
        // Link conversation to the most recent booking
        await Conversation.findByIdAndUpdate(conversationId, {
          $set: {
            linkedCustomerBooking: {
              email: externalEmail,
              appointmentIds: appointments.map((a: any) => a._id),
              totalBookings: appointments.length
            }
          }
        });

        console.log(`✅ Linked conversation to ${appointments.length} customer booking(s)`);
      }
    } catch (error) {
      console.error('Failed to link conversation to customer booking:', error);
    }
  }
}

export default new GmailService();