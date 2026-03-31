import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import mongoose from 'mongoose';
import OrgLeadConfig, { IOrgLeadConfig } from '../models/OrgLeadConfig.model';
import Lead from '../models/lead.model';
import User from '../models/User.model';
import { decrypt, encrypt } from '../utils/crypto';
import { ApiError } from '../utils/ApiError';
import { parseEmailBody, extractADFFromBody, parseADF, detectChannel } from '../utils/adfParser';
import { getSocketIO } from '../utils/socketEmitter';

class OrgGmailService {
    private createOAuth2Client(): OAuth2Client {
        return new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI || `${process.env.BACKEND_URL}/api/org-lead/callback`
        );
    }

    /**
     * Generates the Google OAuth URL for an organization
     */
    getAuthUrl(orgId: string): string {
        const oauth2Client = this.createOAuth2Client();
        const scopes = [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.events',
        ];

        return oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent',
            state: orgId,
        });
    }

    /**
     * Exchanges authorization code for tokens
     */
    async getTokensFromCode(code: string): Promise<any> {
        const oauth2Client = this.createOAuth2Client();
        const { tokens } = await oauth2Client.getToken(code);
        return tokens;
    }

    /**
     * Syncs leads from Gmail for a specific organization
     */
    async syncLeadsForOrg(orgId: string): Promise<{ total: number; synced: number }> {
        const config = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true });
        if (!config || !config.gmailConnected) {
            console.log(`[OrgSync] Skipping org ${orgId}: Gmail not connected or inactive.`);
            return { total: 0, synced: 0 };
        }

        try {
            const oauth2Client = this.createOAuth2Client();

            // Decrypt tokens
            const accessToken = decrypt(config.accessToken);
            const refreshToken = decrypt(config.refreshToken);

            oauth2Client.setCredentials({
                access_token: accessToken,
                refresh_token: refreshToken,
                expiry_date: config.expiryDate
            });

            // Handle token Refresh
            oauth2Client.once('tokens', async (tokens) => {
                const updateData: any = {};
                if (tokens.access_token) updateData.accessToken = encrypt(tokens.access_token);
                if (tokens.refresh_token) updateData.refreshToken = encrypt(tokens.refresh_token);
                if (tokens.expiry_date) updateData.expiryDate = tokens.expiry_date;

                if (Object.keys(updateData).length > 0) {
                    await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: updateData });
                    console.log(`[OrgSync] Refreshed and re-encrypted tokens for org: ${orgId}`);
                }
            });

            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

            // Build Query: restrict to leadSourceEmail if configured
            let query = 'is:unread'; // Default to unread for efficiency
            if (config.leadSourceEmail) {
                query += ` from:${config.leadSourceEmail}`;
            }

            // Only check last 24 hours to avoid stressing API
            const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
            query += ` after:${oneDayAgo}`;

            let messages: any[] = [];
            let nextPageToken: string | undefined = undefined;

            do {
                const response = await gmail.users.messages.list({ 
                    userId: 'me', 
                    q: query, 
                    maxResults: 100, 
                    pageToken: nextPageToken 
                });
                if (response.data.messages) {
                    messages.push(...response.data.messages);
                }
                nextPageToken = response.data.nextPageToken as string | undefined;
            } while (nextPageToken && messages.length < 2000); // Safety cap at 2000

            let syncedCount = 0;
            const systemUser = await User.findOne({ role: 'super_admin' }) || await User.findOne({ role: 'admin' });

            for (const msg of messages) {
                try {
                    const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id! });
                    const rawBody = this.extractBody(detail.data);

                    // Skip empty emails
                    if (!rawBody || !rawBody.trim()) continue;

                    // Check if lead already exists by messageId/threadId to avoid duplicates
                    const exists = await Lead.findOne({
                        $or: [{ messageId: detail.data.id }, { threadId: detail.data.threadId }]
                    });

                    if (exists) continue;

                    // Extract email headers for better channel detection
                    const headers = detail.data.payload?.headers || [];
                    const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                    const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';

                    // Use parseEmailBody which gracefully falls back to plain text
                    const { parsedContent, channel, adfData } = await parseEmailBody(rawBody, subject, from);

                    const newLead = new Lead({
                        organizationId: orgId,
                        createdBy: systemUser?._id,
                        firstName: adfData?.firstName || '',
                        lastName: adfData?.lastName || '',
                        email: adfData?.email || '',
                        phone: adfData?.phone || '',
                        vehicle: adfData?.vehicle || {},
                        comments: adfData?.comments || '',
                        subject, // Store the email subject
                        body: rawBody, // Store the raw/plain body
                        parsedContent,
                        messageId: detail.data.id,
                        threadId: detail.data.threadId,
                        channel,
                        source: adfData?.source || 'Gmail Sync',
                        senderEmail: config.gmailAddress,
                        centralIngestion: true,
                    });

                    await newLead.save();
                    syncedCount++;

                    // Real-time notify
                    const io = getSocketIO();
                    if (io) io.to(`org:${orgId}`).emit('lead:new', newLead);

                    // Mark as READ in Gmail to prevent double processing next time
                    await gmail.users.messages.batchModify({
                        userId: 'me',
                        requestBody: {
                            ids: [msg.id!],
                            removeLabelIds: ['UNREAD']
                        }
                    });

                } catch (err) {
                    console.error(`[OrgSync] Failed to process message ${msg.id} for org ${orgId}:`, err);
                }
            }

            // Update last sync
            await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { lastSyncAt: new Date() } });

            return { total: messages.length, synced: syncedCount };
        } catch (error) {
            console.error(`[OrgSync-FATAL] Sync failed for org ${orgId}:`, error);
            throw error;
        }
    }

    private extractBody(message: any): string {
        const parts = message.payload?.parts || [];
        let body = '';

        // Look for text/plain first (ADF is usually plain text or XML)
        for (const part of parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                body = Buffer.from(part.body.data, 'base64').toString();
                if (body) return body;
            }
        }

        // Fallback to text/html
        for (const part of parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
                body = Buffer.from(part.body.data, 'base64').toString();
                // Basic strip of HTML tags
                body = body.replace(/<[^>]*>/g, ' ');
                if (body) return body;
            }
        }

        // Direct body
        if (message.payload?.body?.data) {
            body = Buffer.from(message.payload.body.data, 'base64').toString();
        }

        return body;
    }
}

export default new OrgGmailService();
