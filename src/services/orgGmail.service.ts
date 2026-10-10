import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import mongoose from 'mongoose';
import OrgLeadConfig, { IOrgLeadConfig } from '../models/OrgLeadConfig.model';
import Lead from '../models/lead.model';
import { resolveOrgSystemUserId } from '../utils/orgSystemUser';
import { normalizeIdentityEmail } from '../utils/contactIdentity';
import { decrypt, encrypt } from '../utils/crypto';
import { ApiError } from '../utils/ApiError';
import { parseEmailBody, extractADFFromBody, parseADF, detectChannel } from '../utils/adfParser';
import { getSocketIO } from '../utils/socketEmitter';
import { withRetry } from '../utils/withRetry';
import { LEAD_SOURCE } from '../constants/leadSource';
import { resolveVehicleContextForLead } from './leadLocation.service';
import { isLocalUiAcceptanceMode } from '../utils/aiOutboundSafety';
import { triggerAiReplyForNewInquiry } from './communication.service';
import { triggerAiEmailReplyForNewInquiry } from './aiEmailReply.service';

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
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/userinfo.email',
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
        if (isLocalUiAcceptanceMode()) {
            console.log(`[OrgSync] Skipping org ${orgId}: blocked by LOCAL_UI_ACCEPTANCE_MODE.`);
            return { total: 0, synced: 0 };
        }

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
                const response = await withRetry(() => gmail.users.messages.list({
                    userId: 'me',
                    q: query,
                    maxResults: 100,
                    pageToken: nextPageToken
                }));
                if (response.data.messages) {
                    messages.push(...response.data.messages);
                }
                nextPageToken = response.data.nextPageToken as string | undefined;
            } while (nextPageToken && messages.length < 2000); // Safety cap at 2000

            let syncedCount = 0;
            const systemUserId = await resolveOrgSystemUserId(orgId);
            if (!systemUserId) throw new ApiError(400, 'This dealership has no intake user configured');

            for (const msg of messages) {
                try {
                    const detail = await withRetry(() => gmail.users.messages.get({ userId: 'me', id: msg.id! }));
                    const rawBody = this.extractBody(detail.data);

                    // Skip empty emails
                    if (!rawBody || !rawBody.trim()) continue;

                    // A message already imported into this thread is skipped up front —
                    // this is a best-effort secondary check (threadId has no unique index),
                    // the real dedup guarantee is the atomic messageId upsert below.
                    const alreadyImportedInThread = detail.data.threadId
                        ? await Lead.findOne({ organizationId: orgId, threadId: detail.data.threadId }).select('_id').lean()
                        : null;
                    if (alreadyImportedInThread) continue;

                    // Extract email headers for better channel detection
                    const headers = detail.data.payload?.headers || [];
                    const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                    const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';

                    // Use parseEmailBody which gracefully falls back to plain text
                    const { parsedContent, channel, adfData } = await parseEmailBody(rawBody, subject, from);
                    const senderAddress = normalizeIdentityEmail(from.match(/<([^<>]+)>/)?.[1] || from);

                    const sourceSubmittedAt = detail.data.internalDate
                        ? new Date(Number(detail.data.internalDate))
                        : undefined;

                    const vehicleContext = adfData
                        ? await resolveVehicleContextForLead(orgId, adfData.vehicle).catch(() => null)
                        : null;

                    const upsertResult = await Lead.findOneAndUpdate(
                        { organizationId: orgId, messageId: detail.data.id },
                        {
                            $setOnInsert: {
                                organizationId: orgId,
                                createdBy: systemUserId,
                                firstName: adfData?.firstName || '',
                                lastName: adfData?.lastName || '',
                                email: adfData ? (adfData.email || '') : (senderAddress || ''),
                                identityEmailExcluded: !adfData && (channel === 'adf' || Boolean(config.leadSourceEmail)),
                                phone: adfData?.phone || '',
                                vehicle: adfData?.vehicle || {},
                                vehicleId: vehicleContext?.vehicleId,
                                location: vehicleContext?.location,
                                comments: adfData?.comments || '',
                                subject,
                                body: rawBody,
                                parsedContent,
                                messageId: detail.data.id,
                                threadId: detail.data.threadId,
                                channel,
                                source: adfData ? LEAD_SOURCE.THIRD_PARTY_LEAD : LEAD_SOURCE.EMAIL_INQUIRY,
                                sourceProvider: adfData ? (adfData.provider || adfData.vendor || undefined) : undefined,
                                senderEmail: from,
                                sourceSubmittedAt,
                                centralIngestion: true,
                            },
                        },
                        { new: true, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
                    );

                    if (upsertResult.lastErrorObject?.updatedExisting) {
                        // Another sync run already won this message — nothing left to do.
                        continue;
                    }

                    const newLead = upsertResult.value;
                    syncedCount++;

                    if (newLead) {
                        triggerAiReplyForNewInquiry(orgId, newLead, newLead.phone, newLead.comments).catch((err) => {
                            console.error('[OrgSync] triggerAiReplyForNewInquiry failed:', err);
                        });
                        triggerAiEmailReplyForNewInquiry(orgId, newLead, newLead.comments).catch((err) => {
                            console.error('[OrgSync] triggerAiEmailReplyForNewInquiry failed:', err);
                        });
                    }

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

    async isGmailConnected(orgId: string): Promise<boolean> {
        const config = await OrgLeadConfig.findOne({ organizationId: orgId });
        return !!(config && config.gmailConnected && config.accessToken && config.refreshToken);
    }

    /**
     * Send email via Gmail API using Org credentials
     */
    async sendEmail(orgId: string, to: string, subject: string, body: string) {
        const config = await OrgLeadConfig.findOne({ organizationId: orgId });
        if (!config || !config.gmailConnected) {
            throw new ApiError(400, 'Gmail not connected for this organization');
        }

        const oauth2Client = this.createOAuth2Client();
        oauth2Client.setCredentials({
            access_token: decrypt(config.accessToken),
            refresh_token: decrypt(config.refreshToken),
            expiry_date: config.expiryDate
        });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const messageParts = [
            `From: ${config.gmailAddress}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset=utf-8',
            'MIME-Version: 1.0',
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

        console.log(`[GmailSend] Email sent successfully to ${to}. MessageId: ${response.data.id}`);

        return response.data;
    }

    /**
     * Fetch emails for dashboard display
     */
    async fetchEmails(orgId: string, query: string = '', maxResults: number = 20) {
        const config = await OrgLeadConfig.findOne({ organizationId: orgId });
        if (!config || !config.gmailConnected) {
            throw new ApiError(400, 'Gmail not connected for this organization');
        }

        const oauth2Client = this.createOAuth2Client();
        oauth2Client.setCredentials({
            access_token: decrypt(config.accessToken),
            refresh_token: decrypt(config.refreshToken),
            expiry_date: config.expiryDate
        });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults
        });

        const messages = response.data.messages || [];
        const details = await Promise.all(
            messages.map(async (m) => {
                const res = await gmail.users.messages.get({ userId: 'me', id: m.id! });
                return res.data;
            })
        );

        return details;
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
