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
  /**
   * Create a fresh OAuth2 client per request (avoids cross-user contamination)
   */
  private createOAuth2Client(): OAuth2Client {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `${process.env.BACKEND_URL}/api/google-calendar/callback`
    );
  }

  /**
   * Get authenticated Gmail client
   * FIX: Create fresh OAuth client per call, use once() for token refresh
   */
  private async getGmailClient(userId: string) {
    const user = await User.findById(userId)
      .select('+googleCalendar.accessToken +googleCalendar.refreshToken') as IUserWithGoogleCalendar | null;

    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      throw new ApiError(401, 'Gmail not connected. Please connect Google Calendar first.');
    }

    const oauth2Client = this.createOAuth2Client();

    oauth2Client.setCredentials({
      access_token: user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date: user.googleCalendar.expiryDate
    });

    // FIX: Use once() to avoid memory leak from accumulating listeners
    oauth2Client.once('tokens', async (tokens: any) => {
      try {
        const updateData: any = {};
        if (tokens.access_token) {
          updateData['googleCalendar.accessToken'] = tokens.access_token;
        }
        if (tokens.refresh_token) {
          updateData['googleCalendar.refreshToken'] = tokens.refresh_token;
        }
        if (tokens.expiry_date) {
          updateData['googleCalendar.expiryDate'] = tokens.expiry_date;
        }
        if (Object.keys(updateData).length > 0) {
          await User.findByIdAndUpdate(userId, { $set: updateData });
        }
      } catch (err) {
        console.error('Failed to save refreshed Gmail tokens:', err);
      }
    });

    return google.gmail({ version: 'v1', auth: oauth2Client });
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
      // Check if conversation already exists with this external email
      let conversation = await Conversation.findOne({
        organizationId,
        type: 'external',
        participants: userId,
        'externalEmails.email': externalEmail.toLowerCase()
      });

      if (!conversation) {
        // Create new conversation with external participant
        conversation = await Conversation.create({
          type: 'external',
          organizationId,
          participants: [userId],
          createdBy: userId,
          externalEmails: [{
            email: externalEmail.toLowerCase(),
            name: externalName || externalEmail.split('@')[0],
            addedAt: new Date()
          }],
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
        _id: new mongoose.Types.ObjectId().toString(),
        sender: new mongoose.Types.ObjectId(senderId),
        content,
        type: 'email' as const,
        metadata: {
          gmailMessageId,
          direction
        },
        isFromExternal: direction === 'incoming',
        readBy: [new mongoose.Types.ObjectId(senderId)],
        createdAt: new Date()
      };

      await Conversation.findByIdAndUpdate(conversationId, {
        $push: { messages: message },
        lastMessage: content.substring(0, 100),
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

      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
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
    const user = await User.findById(userId)
      .select('+googleCalendar.accessToken') as IUserWithGoogleCalendar | null;
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
      const appointments = await mongoose.model('Appointment').find({
        organizationId,
        'customerBooking.email': externalEmail.toLowerCase(),
        'customerBooking.isCustomerBooking': true
      }).sort({ createdAt: -1 });

      if (appointments.length > 0) {
        await Conversation.findByIdAndUpdate(conversationId, {
          $addToSet: {
            linkedCustomerBookings: { $each: appointments.map((a: any) => a._id) }
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