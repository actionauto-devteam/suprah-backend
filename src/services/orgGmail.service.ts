import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import mongoose from 'mongoose';
import OrgLeadConfig, { IOrgLeadConfig } from '../models/OrgLeadConfig.model';
import Lead from '../models/lead.model';
import { resolveOrgSystemUserId } from '../utils/orgSystemUser';
import { normalizeIdentityEmail } from '../utils/contactIdentity';
import { postalAddressLine } from '../utils/customerArea';
import { decrypt, encrypt } from '../utils/crypto';
import { ApiError } from '../utils/ApiError';
import { parseEmailBody, extractADFFromBody, parseADF, detectChannel, isADFContent } from '../utils/adfParser';
import { getSocketIO } from '../utils/socketEmitter';
import { withRetry } from '../utils/withRetry';
import { LEAD_SOURCE } from '../constants/leadSource';
import { NOT_A_LEAD_STATUS } from '../constants/leadStatus';
import { resolveLeadStore } from '../utils/leadStore';
import { isLocalUiAcceptanceMode } from '../utils/aiOutboundSafety';
import { triggerAiReplyForNewInquiry } from './communication.service';
import { triggerAiEmailReplyForNewInquiry } from './aiEmailReply.service';
import { getLeadIntakeMode } from './leadIntakeControl.service';
import { processGmailMessageThroughIntake } from './gmailLeadIntake';
import { isAutomatedEmail } from './emailInquiryEvidence';
import { extractGmailText, gmailHeader } from '../utils/gmailMessageParser';
import { markLeadAwaitingReply } from '../utils/leadActivity';
import { crmStaffRoom } from '../utils/crmStaffRoom';
import { cacheService } from './cache.service';
import { notificationTemplates } from '../utils/notificationTemplates';
import { forgetRevokedPreviousMailbox, isPreviousMailboxReadable, previousMailboxClient } from './previousMailbox.service';

const RECHECK_SKIPPED_MESSAGE_MS = 10 * 60 * 1000;
const SKIPPED_NON_LEAD_RECHECK_MS = 25 * 60 * 60 * 1000;
const STAFF_EMAILS_CACHE_MS = 5 * 60 * 1000;
const recentlyCheckedMessages = new Map<string, number>();
const staffEmailsCache = new Map<string, { at: number; emails: Set<string> }>();

export function wasMessageCheckedRecently(orgId: string, messageId: string) {
    const until = recentlyCheckedMessages.get(`${orgId}:${messageId}`);
    return until !== undefined && until > Date.now();
}

export function rememberCheckedMessage(orgId: string, messageId: string, forMs: number = RECHECK_SKIPPED_MESSAGE_MS) {
    const now = Date.now();
    if (recentlyCheckedMessages.size >= 20000) {
        for (const [key, until] of recentlyCheckedMessages) {
            if (until <= now) recentlyCheckedMessages.delete(key);
        }
    }
    recentlyCheckedMessages.set(`${orgId}:${messageId}`, now + forMs);
}

const STAFF_USER_ROLES = ['employee', 'admin', 'super_admin'];

async function staffEmailsFor(orgId: string): Promise<Set<string>> {
    const cached = staffEmailsCache.get(orgId);
    if (cached && cached.at > Date.now() - STAFF_EMAILS_CACHE_MS) return cached.emails;
    if (!mongoose.isValidObjectId(orgId)) return new Set<string>();
    try {
        const [{ default: CrmUser }, { default: User }] = await Promise.all([
            import('../models/CrmUser.model'),
            import('../models/User.model'),
        ]);
        const [crmUsers, users] = await Promise.all([
            CrmUser.find({ organizationId: orgId, isActive: { $ne: false } }).select('email').lean(),
            User.find({ organizationId: orgId, role: { $in: STAFF_USER_ROLES }, isActive: { $ne: false } }).select('email').lean(),
        ]);
        const emails = new Set(
            [...crmUsers, ...users]
                .map((person: any) => normalizeIdentityEmail(person?.email))
                .filter(Boolean) as string[],
        );
        staffEmailsCache.set(orgId, { at: Date.now(), emails });
        return emails;
    } catch (err) {
        console.warn(`[OrgSync] Could not load team emails for org ${orgId}:`, err);
        return cached?.emails || new Set<string>();
    }
}

function isCustomerWrittenEmail(message: any, leadSourceEmail?: string | null): boolean {
    const from = gmailHeader(message, 'from');
    const sender = normalizeIdentityEmail(from.match(/<([^<>]+)>/)?.[1] || from);
    if (!sender) return false;
    const leadSource = normalizeIdentityEmail(leadSourceEmail);
    if (leadSource && sender === leadSource) return false;
    return !isAutomatedEmail(message);
}

export async function notifyCustomerEmailReply(orgId: string, message: any, leadSourceEmail?: string | null, intakeHandled = false): Promise<boolean> {
    if (!message?.threadId) return false;
    const lead: any = await Lead.findOne({ organizationId: orgId, $or: [{ threadId: message.threadId }, { previousThreadIds: message.threadId }], 'combinedInto.leadId': { $exists: false }, status: { $ne: NOT_A_LEAD_STATUS } }).select('_id firstName lastName phone email assignedTo createdAt messageId').lean();
    if (!lead) return false;
    const at = new Date(Number(message.internalDate) || Date.now());
    const touched = await Lead.updateOne(
        { _id: lead._id, $or: [{ 'followUp.lastCustomerActivityAt': { $lt: at } }, { 'followUp.lastCustomerActivityAt': null }] },
        { $set: { 'followUp.lastCustomerActivityAt': at, isRead: false } },
    );
    const startedLead = Boolean(lead.messageId) && lead.messageId === message.id;
    if (!intakeHandled && !startedLead && isCustomerWrittenEmail(message, leadSourceEmail)) await markLeadAwaitingReply(lead._id, at);
    await cacheService.del(`lead:thread:${lead._id}`).catch(() => undefined);
    const { clearLeadConversationEmailCache } = await import('./leadConversation.service');
    await clearLeadConversationEmailCache(lead._id, message.threadId);
    const io = getSocketIO();
    if (io) {
        io.to(crmStaffRoom(orgId)).emit('email:message:new', { leadId: String(lead._id), threadId: message.threadId });
        io.to(crmStaffRoom(orgId)).emit('lead:update', { leadId: String(lead._id) });
    }
    if (touched.modifiedCount > 0) {
        const { notifyLeadMessage } = await import('./leadMessageNotice.service');
        await notifyLeadMessage(orgId, lead, 'email', String(message.snippet || ''));
    }
    return true;
}

export function forgetCheckedMessages() {
    recentlyCheckedMessages.clear();
}

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
            prompt: 'consent select_account',
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

        let result = { total: 0, synced: 0 };
        let failure: unknown = null;
        const previous = config.previousMailbox;
        if (previous && isPreviousMailboxReadable(previous)) {
            await this.syncMailbox(orgId, config, true)
                .catch((error) => forgetRevokedPreviousMailbox(orgId, previous, error))
                .catch(() => undefined);
        }
        try {
            result = await this.syncMailbox(orgId, config, false);
        } catch (error) {
            failure = error;
        }
        if (failure) throw failure;
        return result;
    }

    private mainMailboxClient(orgId: string, config: IOrgLeadConfig): OAuth2Client {
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
                await OrgLeadConfig.updateOne({ organizationId: orgId, refreshToken: config.refreshToken }, { $set: updateData });
                console.log(`[OrgSync] Refreshed and re-encrypted tokens for org: ${orgId}`);
            }
        });

        return oauth2Client;
    }

    private async syncMailbox(orgId: string, config: IOrgLeadConfig, fromPrevious: boolean): Promise<{ total: number; synced: number }> {
        try {
            const oauth2Client = fromPrevious
                ? previousMailboxClient(orgId, config.previousMailbox!)
                : this.mainMailboxClient(orgId, config);
            const readsTwoAccounts = Boolean(config.leadSourceEmail) && isPreviousMailboxReadable(config.previousMailbox);

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

            if ((await getLeadIntakeMode(orgId)) !== 'off') {
                const newInquiryIds = new Set(messages.map((m) => m.id));
                if (config.leadSourceEmail) {
                    let replyToken: string | undefined = undefined;
                    do {
                        const replies: any = await withRetry(() => gmail.users.messages.list({
                            userId: 'me',
                            q: `is:unread after:${oneDayAgo} -from:${config.leadSourceEmail}`,
                            maxResults: 100,
                            pageToken: replyToken,
                        }));
                        if (replies.data.messages) messages.push(...replies.data.messages);
                        replyToken = replies.data.nextPageToken as string | undefined;
                    } while (replyToken && messages.length < 4000);
                }
                const unique = [...new Map(messages.map((m) => [m.id, m])).values()];
                const details: any[] = [];
                for (const msg of unique) {
                    if (wasMessageCheckedRecently(orgId, msg.id!)) continue;
                    try {
                        const detail = await withRetry(() => gmail.users.messages.get({ userId: 'me', id: msg.id! }));
                        details.push(detail.data);
                    } catch (err) {
                        console.error(`[OrgSync] Could not read message ${msg.id} for org ${orgId}:`, err);
                    }
                }
                details.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
                let intakeCreated = 0;
                const ownAddresses = [config.gmailAddress, config.previousMailbox?.gmailAddress]
                    .map((address) => normalizeIdentityEmail(address))
                    .filter(Boolean) as string[];
                const staffEmails = fromPrevious ? new Set<string>() : await staffEmailsFor(orgId);
                for (const message of details) {
                    try {
                        const rawBody = this.extractBody(message);
                        if (!rawBody || !rawBody.trim()) {
                            rememberCheckedMessage(orgId, message.id);
                            continue;
                        }
                        const result = await processGmailMessageThroughIntake({
                            organizationId: orgId,
                            message,
                            rawBody,
                            leadSourceEmail: config.leadSourceEmail,
                            systemUserId,
                            allowNewInquiry: !config.leadSourceEmail || newInquiryIds.has(message.id),
                            mailbox: fromPrevious ? config.previousMailbox?.gmailAddress : config.gmailAddress,
                            plainEmailLeads: !fromPrevious,
                            ownAddresses,
                            staffEmails,
                            notLeadSenders: config.notLeadSenders || [],
                        });
                        if (result.status === 'skipped') {
                            const reason = (result as { reason?: string }).reason;
                            rememberCheckedMessage(orgId, message.id, reason === 'not_a_lead_email' ? SKIPPED_NON_LEAD_RECHECK_MS : undefined);
                            if (reason === 'lead_source_notice' || reason === 'own_mailbox') {
                                await this.markLeadSourceNoticeRead(gmail, orgId, message, reason);
                            }
                        }
                        if (result.status === 'inactive' || result.status === 'skipped') continue;
                        if (result.status === 'sorted' || result.status === 'dismissed') {
                            await gmail.users.messages.batchModify({
                                userId: 'me',
                                requestBody: { ids: [message.id], removeLabelIds: ['UNREAD'] },
                            });
                            continue;
                        }
                        if (result.status === 'associated' && result.created) intakeCreated++;
                        await notifyCustomerEmailReply(orgId, message, config.leadSourceEmail, true);
                        await gmail.users.messages.batchModify({
                            userId: 'me',
                            requestBody: { ids: [message.id], removeLabelIds: ['UNREAD'] },
                        });
                    } catch (err) {
                        rememberCheckedMessage(orgId, message.id);
                        console.error(`[OrgSync] Lead intake failed for message ${message.id} for org ${orgId}:`, err);
                    }
                }
                if (!fromPrevious) await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { lastSyncAt: new Date() } });
                return { total: details.length, synced: intakeCreated };
            }

            for (const msg of messages) {
                if (wasMessageCheckedRecently(orgId, msg.id!)) continue;
                try {
                    const detail = await withRetry(() => gmail.users.messages.get({ userId: 'me', id: msg.id! }));
                    const rawBody = this.extractBody(detail.data);

                    // Skip empty emails
                    if (!rawBody || !rawBody.trim()) {
                        rememberCheckedMessage(orgId, msg.id!);
                        continue;
                    }

                    // A message already imported into this thread is skipped up front —
                    // this is a best-effort secondary check (threadId has no unique index),
                    // the real dedup guarantee is the atomic messageId upsert below.
                    const alreadyImportedInThread = detail.data.threadId
                        ? await Lead.findOne({ organizationId: orgId, $or: [{ threadId: detail.data.threadId }, { previousThreadIds: detail.data.threadId }] }).select('_id').lean()
                        : null;
                    if (alreadyImportedInThread) {
                        rememberCheckedMessage(orgId, msg.id!);
                        continue;
                    }
                    const sameEmailInOtherAccount = readsTwoAccounts
                        ? await Lead.exists({ organizationId: orgId, body: rawBody, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
                        : null;
                    if (sameEmailInOtherAccount) {
                        await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: [msg.id!], removeLabelIds: ['UNREAD'] } });
                        rememberCheckedMessage(orgId, msg.id!);
                        continue;
                    }

                    // Extract email headers for better channel detection
                    const headers = detail.data.payload?.headers || [];
                    const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                    const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';

                    // Use parseEmailBody which gracefully falls back to plain text
                    const { parsedContent, channel, adfData } = await parseEmailBody(rawBody, subject, from);
                    const senderAddress = normalizeIdentityEmail(from.match(/<([^<>]+)>/)?.[1] || from);
                    if (!adfData && senderAddress && senderAddress === normalizeIdentityEmail(config.leadSourceEmail) && !isADFContent(rawBody.toLowerCase())) {
                        rememberCheckedMessage(orgId, msg.id!);
                        await this.markLeadSourceNoticeRead(gmail, orgId, detail.data);
                        continue;
                    }

                    const sourceSubmittedAt = detail.data.internalDate
                        ? new Date(Number(detail.data.internalDate))
                        : undefined;

                    const vehicleContext = adfData
                        ? await resolveLeadStore(orgId, adfData.vehicle).catch(() => null)
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
                                address: postalAddressLine(adfData?.rawFields),
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
                        rememberCheckedMessage(orgId, msg.id!);
                        continue;
                    }

                    const newLead = upsertResult.value;
                    syncedCount++;

                    if (newLead) {
                        const customerName = [newLead.firstName, newLead.lastName].filter(Boolean).join(' ').trim() || newLead.email || 'A new customer';
                        const notice = notificationTemplates.new_lead({ customerName, source: newLead.sourceProvider || newLead.source });
                        import('./leadNoticeRouting.service')
                            .then(({ notifyLeadPeople }) => notifyLeadPeople({
                                organizationId: orgId,
                                leadId: newLead._id,
                                type: 'new_lead',
                                title: notice.title,
                                message: notice.message,
                                metadata: { leadId: String(newLead._id), customerName, source: newLead.source, channel: newLead.channel, route: `/crm/leads?leadId=${newLead._id}` },
                                topicText: newLead.comments,
                            }))
                            .catch(() => undefined);
                        triggerAiReplyForNewInquiry(orgId, newLead, newLead.phone, newLead.comments).catch((err) => {
                            console.error('[OrgSync] triggerAiReplyForNewInquiry failed:', err);
                        });
                        triggerAiEmailReplyForNewInquiry(orgId, newLead, newLead.comments).catch((err) => {
                            console.error('[OrgSync] triggerAiEmailReplyForNewInquiry failed:', err);
                        });
                    }

                    // Real-time notify
                    const io = getSocketIO();
                    if (io) io.to(crmStaffRoom(String(orgId))).emit('lead:new', newLead);

                    // Mark as READ in Gmail to prevent double processing next time
                    await gmail.users.messages.batchModify({
                        userId: 'me',
                        requestBody: {
                            ids: [msg.id!],
                            removeLabelIds: ['UNREAD']
                        }
                    });

                } catch (err) {
                    rememberCheckedMessage(orgId, msg.id!);
                    console.error(`[OrgSync] Failed to process message ${msg.id} for org ${orgId}:`, err);
                }
            }

            if (config.leadSourceEmail) {
                const replies: any = await withRetry(() => gmail.users.messages.list({
                    userId: 'me',
                    q: `is:unread after:${oneDayAgo} -from:${config.leadSourceEmail}`,
                    maxResults: 100,
                }));
                for (const reply of replies.data.messages || []) {
                    if (!reply.id || wasMessageCheckedRecently(orgId, reply.id)) continue;
                    rememberCheckedMessage(orgId, reply.id);
                    try {
                        const detail = await withRetry(() => gmail.users.messages.get({ userId: 'me', id: reply.id!, format: 'metadata' }));
                        await notifyCustomerEmailReply(orgId, detail.data, config.leadSourceEmail);
                    } catch (err) {
                        console.error(`[OrgSync] Could not check reply ${reply.id} for org ${orgId}:`, err);
                    }
                }
            }

            // Update last sync
            if (!fromPrevious) await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { lastSyncAt: new Date() } });

            return { total: messages.length, synced: syncedCount };
        } catch (error) {
            console.error(`[OrgSync-FATAL] Sync failed for org ${orgId}${fromPrevious ? ' (previous email account)' : ''}:`, error);
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

    private async markLeadSourceNoticeRead(gmail: any, orgId: string, message: any, reason = 'lead_source_notice'): Promise<void> {
        const what = reason === 'own_mailbox' ? 'an email sent from our own mailbox' : 'a lead-source email with no lead data';
        console.log(`[OrgSync] Skipped ${what} for org ${orgId}: ${message?.id} "${gmailHeader(message, 'subject')}"`);
        await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: [message.id], removeLabelIds: ['UNREAD'] } })
            .catch((error: unknown) => console.error(`[OrgSync] Could not mark the skipped lead-source email ${message?.id} read for org ${orgId}:`, error));
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

        return body || extractGmailText(message);
    }
}

export default new OrgGmailService();
