import { Request, Response, NextFunction } from 'express';
import Lead from '../models/lead.model';
import { parseStringPromise } from 'xml2js';
import User, { IUser } from '../models/User.model';
import { google } from 'googleapis';
import { asyncHandler } from '../utils/asyncHandler';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { ApiResponse } from '../utils/ApiResponse';
import { safeCreateNotification, notifyOrgAdmins, safeBroadcastNotification } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import {
  parseADF,
  parseEmailBody,
  isADFContent,
  extractADFFromBody,
  detectChannel,
} from '../utils/adfParser';
import { getSocketIO } from '../utils/socketEmitter';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { decrypt, encrypt } from '../utils/crypto';
import { cacheService } from '../services/cache.service';
import googleCalendarService from '../services/googleCalendar.service';

/**
 * STRICT SOURCE FILTER — only leads from this address are ingested.
 * All other senders are silently ignored during Gmail sync.
 */
const LEADS_SOURCE_EMAIL = 'leads@dealerscloud.com';

async function getCentralOAuth2Client(orgId: string) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );

  const cacheKey = `config:org:${orgId}`;
  let orgConfig = await cacheService.get(cacheKey);

  if (!orgConfig) {
    orgConfig = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true }).lean();
    if (orgConfig) {
      await cacheService.set(cacheKey, orgConfig, 3600); // 1hr
    }
  }

  if (orgConfig && orgConfig.gmailConnected && orgConfig.refreshToken) {
    const isCached = !!(await cacheService.get(cacheKey));
    console.log(`[CENTRAL-AUTH] Using tokens from OrgLeadConfig for org: ${orgId}${isCached ? ' (Cached)' : ''}`);
    
    oauth2Client.setCredentials({
      access_token:  orgConfig.accessToken ? decrypt(orgConfig.accessToken) : undefined,
      refresh_token: decrypt(orgConfig.refreshToken),
      expiry_date:   orgConfig.expiryDate,
    });
  } else {
    console.error(`[CENTRAL-AUTH] ERROR: No Gmail credentials found for organization: ${orgId}`);
    throw new Error('Please connect your email leads into the CRM settings.');
  }

  // Persistence listener: update database when tokens are refreshed
  oauth2Client.on('tokens', async (tokens) => {
    try {
      console.log(`[CENTRAL-AUTH] Tokens refreshed for org ${orgId}, updating OrgLeadConfig...`);
      const update: any = { expiryDate: tokens.expiry_date };
      if (tokens.access_token)  update.accessToken  = encrypt(tokens.access_token);
      if (tokens.refresh_token) update.refreshToken = encrypt(tokens.refresh_token);
      await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: update });
      await cacheService.del(`config:org:${orgId}`); // Invalidate cache
    } catch (err) {
      console.error('[CENTRAL-AUTH] Failed to persist refreshed tokens:', err);
    }
  });

  return oauth2Client;
}

/**
 * Robust retry wrapper with exponential backoff for Google API calls.
 * Handles 403 (Quota Exceeded) and 429 (Too Many Requests).
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const isQuotaError = error.code === 403 && error.message?.includes('Quota exceeded');
      const isRateLimitError = error.code === 429;

      if ((isQuotaError || isRateLimitError) && attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.warn(`[GMAIL-RETRY] Quota hit. Retrying in ${delay}ms (Attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────
// Handle incoming ADF XML (public endpoint for email webhooks)
// ─────────────────────────────────────────────────────────────
export const receiveADF = async (req: Request, res: Response) => {
  try {
    let xmlData = (req as any).rawBody || req.body;

    if (!xmlData || typeof xmlData !== 'string') {
      return res.status(400).json({ message: 'No valid XML data received' });
    }

    const adfData = await parseADF(xmlData);
    if (!adfData) {
      return res.status(400).json({ message: 'Invalid ADF format — could not parse' });
    }

    const orgId = req.query.orgId || req.body.organizationId;
    const config = (req as any).orgLeadConfig; // Attached by validateAdfSignature middleware

    // Find a system user to associate with automated ingestion
    const systemUser = await User.findOne({ role: 'super_admin' }) || await User.findOne({ role: 'admin' });
    if (!systemUser) {
      console.error('[ADF-ERROR] No administrative user found to associate with lead creation');
      return res.status(500).json({ message: 'Internal server error: No administrative context' });
    }

    const newLead = new Lead({
      organizationId: orgId,
      createdBy: systemUser._id,
      firstName: adfData.firstName,
      lastName: adfData.lastName,
      email: adfData.email,
      phone: adfData.phone,
      vehicle: adfData.vehicle,
      comments: adfData.comments,
      parsedContent: adfData.parsedContent,
      channel: 'adf',
      source: adfData.source || 'ADF Email',
      senderEmail: config?.leadSourceEmail || LEADS_SOURCE_EMAIL,
      centralIngestion: true,
    });

    await newLead.save();
    console.log(`[ADF] New Lead Saved: ${adfData.firstName} ${adfData.lastName}`);

    // Emit real-time notification to the organization
    const io = getSocketIO();
    if (io) {
      const orgIdString = req.query.orgId || req.body.organizationId || 'global';
      io.to(`org:${orgIdString}`).emit('lead:new', newLead);
    }

    // Notify super admins
    const superAdmins = await User.find({ role: 'super_admin' });
    const vehicleInterest = adfData.vehicle
      ? `${adfData.vehicle.year} ${adfData.vehicle.make} ${adfData.vehicle.model}`.trim()
      : undefined;

    for (const admin of superAdmins) {
      try {
        const { title, message } = notificationTemplates.new_lead({
          customerName: `${adfData.firstName} ${adfData.lastName}`.trim(),
          source: 'ADF Email',
          vehicleInterest: vehicleInterest || undefined,
        });
        await safeCreateNotification({
          userId: admin._id.toString(),
          organizationId: admin.organizationId?.toString() || 'global',
          type: 'new_lead',
          title,
          message,
          metadata: {
            leadId: newLead._id.toString(),
            customerName: `${adfData.firstName} ${adfData.lastName}`.trim(),
            email: adfData.email,
            source: 'ADF Email',
            channel: 'adf',
          },
        });
      } catch {
        // Non-critical
      }
    }

    await activityService.createActivity({
      userId: systemUser._id.toString(),
      organizationId: orgId || 'global',
      type: 'other',
      title: 'New Lead Ingested',
      description: `New lead ${adfData.firstName} ${adfData.lastName} from ${newLead.source}`,
      metadata: { leadId: newLead._id.toString(), channel: 'adf' },
      ipAddress: req.ip
    });

    logger.info({ leadId: newLead._id, orgId, source: newLead.source }, 'New lead via ADF webhook');

    res.status(200).send('Lead processed successfully');
  } catch (error) {
    console.error('Error processing ADF:', error);
    res.status(500).send('Internal Server Error');
  }
};

export const getAllLeads = async (req: Request, res: Response) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(400).json({ message: 'Organization context missing' });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const search = req.query.search as string;
    const status = req.query.status as string;
    const skip = (page - 1) * limit;

    const query: any = { organizationId: orgId };

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { 'vehicle.make': { $regex: search, $options: 'i' } },
        { 'vehicle.model': { $regex: search, $options: 'i' } },
      ];
    }

    if (status && status !== 'All') {
      query.status = status;
    }

    const totalLeads = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .select(
        'firstName lastName email phone senderEmail senderName subject ' +
        'parsedContent threadId messageId isRead isPending channel ' +
        'source status vehicle comments appointment createdAt updatedAt ' +
        'centralIngestion labels'
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(new ApiResponse(200, {
      leads,
      total: totalLeads,
      page,
      pages: Math.ceil(totalLeads / limit),
    }));
  } catch (error) {
    console.error('[ERROR] Error fetching leads:', error);
    res.status(500).json({ message: 'Error fetching leads' });
  }
};

export const updateLead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = (req.user as IUser)._id;
    const orgId = req.orgId;

    const lead = await Lead.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { status },
      { new: true }
    );

    if (lead) {
      const { title, message } = notificationTemplates.lead_status_changed({
        customerName: `${lead.firstName} ${lead.lastName || ''}`.trim(),
        status,
      });

      await safeCreateNotification({
        userId: userId.toString(),
        organizationId: (req as any).orgId || 'global',
        type: 'lead_status_changed',
        title,
        message,
        metadata: {
          leadId: lead._id.toString(),
          customerName: `${lead.firstName} ${lead.lastName || ''}`.trim(),
          newStatus: status,
        },
      });

      await activityService.createActivity({
        userId: userId.toString(),
        organizationId: orgId || 'global',
        type: 'other',
        title: 'Lead Status Updated',
        description: `Lead ${lead.firstName} status changed to ${status}`,
        metadata: { leadId: lead._id.toString(), status }
      });

      logger.info({ leadId: lead._id, status, userId }, 'Lead status updated');

      // Socket broadcast
      const io = getSocketIO();
      if (io) {
        io.to(`org:${orgId}`).emit('lead:update', lead);
      }
    }

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: 'Error updating lead' });
  }
};

export const createInquiry = async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, phone, vehicle, comments, source, channel } = req.body;
    const userId = (req.user as IUser)._id;

    if (!firstName || !email || !phone) {
      return res.status(400).json({
        message: 'Missing required fields: firstName, email, phone',
        received: { firstName, email, phone },
      });
    }

    const detectedChannel = channel || detectChannel('', comments || '', '', source || '');

    const newLead = new Lead({
      organizationId: req.orgId,
      createdBy: userId,
      firstName,
      lastName: lastName || '',
      email,
      phone,
      vehicle: {
        year: vehicle?.year || '',
        make: vehicle?.make || '',
        model: vehicle?.model || '',
      },
      comments: comments || '',
      source: source || 'Manual Entry',
      channel: detectedChannel,
      status: 'New',
    });

    const savedLead = await newLead.save();
    console.log(`[SUCCESS] New Inquiry Created: ${firstName} ${lastName} (ID: ${savedLead._id})`);

    // Emit real-time notification to the organization
    const io = getSocketIO();
    if (io) {
      io.to(`org:${req.orgId}`).emit('lead:new', savedLead);
    }

    if (userId) {
      const vehicleInterest = vehicle
        ? `${vehicle?.year || ''} ${vehicle?.make || ''} ${vehicle?.model || ''}`.trim()
        : undefined;
      const { title, message } = notificationTemplates.new_lead({
        customerName: `${firstName} ${lastName || ''}`.trim(),
        source: source || 'Manual Entry',
        vehicleInterest: vehicleInterest || undefined,
      });
      await safeCreateNotification({
        userId: userId.toString(),
        organizationId: (req as any).orgId || 'global',
        type: 'new_lead',
        title,
        message,
        metadata: {
          leadId: savedLead._id.toString(),
          customerName: `${firstName} ${lastName || ''}`.trim(),
          email,
          source: source || 'Manual Entry',
          channel: detectedChannel,
        },
      });
    }

    await activityService.createActivity({
      userId: userId.toString(),
      organizationId: req.orgId || 'global',
      type: 'other',
      title: 'Manual Lead Created',
      description: `Manual lead ${firstName} ${lastName} created by ${userId}`,
      metadata: { leadId: savedLead._id.toString(), source: savedLead.source }
    });

    logger.info({ leadId: savedLead._id, userId, orgId: req.orgId }, 'Manual lead created');

    res.status(201).json({ success: true, message: 'Inquiry created successfully', data: savedLead });
  } catch (error) {
    console.error('[ERROR] Error creating inquiry:', error);
    res.status(500).json({
      message: 'Error creating inquiry',
      error: process.env.NODE_ENV === 'development' ? error : 'Internal server error',
    });
  }
};

export const markAsRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const orgId = req.orgId;
    const lead = await Lead.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { isRead: true },
      { new: true }
    );
    if (!lead) return res.status(404).json({ message: 'Inquiry not found' });

    // Socket broadcast
    const io = getSocketIO();
    if (io) {
      io.to(`org:${orgId}`).emit('lead:update', lead);
    }

    res.json(lead);
  } catch (error) {
    console.error('[ERROR] Error marking as read:', error);
    res.status(500).json({ message: 'Error marking inquiry as read' });
  }
};

export const markAsPending = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const orgId = req.orgId;
    const lead = await Lead.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { isPending: true, status: 'Pending' },
      { new: true }
    );
    if (!lead) return res.status(404).json({ message: 'Inquiry not found' });

    // Socket broadcast
    const io = getSocketIO();
    if (io) {
      io.to(`org:${orgId}`).emit('lead:update', lead);
    }

    res.json(lead);
  } catch (error) {
    console.error('[ERROR] Error marking as pending:', error);
    res.status(500).json({ message: 'Error marking inquiry as pending' });
  }
};

export const replyToInquiry = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const userId = (req.user as IUser)._id;
    const orgId = req.orgId;

    if (!message) {
      return res.status(400).json({ message: 'Reply message is required' });
    }

    const lead = await Lead.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { status: 'Contacted', isRead: true },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ message: 'Inquiry not found' });
    }

    await activityService.createActivity({
      userId: userId.toString(),
      organizationId: orgId || 'global',
      type: 'other',
      title: 'Lead Replied',
      description: `Reply sent to lead ${lead.firstName}`,
      metadata: { leadId: lead._id.toString() }
    });

    logger.info({ leadId: lead._id, userId }, 'Staff replied to lead');

    try {
      const config = await OrgLeadConfig.findOne({ organizationId: req.orgId, isActive: true });
      const oauth2Client = await getCentralOAuth2Client(req.orgId as string);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const user = await User.findById(userId);
      const senderDisplay = user?.email || config?.gmailAddress || 'actionautoutah.dev@gmail.com';

      const recipientEmail = lead.senderEmail || lead.email;
      const headers = [
        `From: ${senderDisplay}`,
        `To: ${recipientEmail}`,
        `Subject: Re: ${lead.subject || 'Inquiry Response'}`,
        ...(lead.messageId ? [`In-Reply-To: ${lead.messageId}`] : []),
        ...(lead.threadId ? [`References: ${lead.threadId}`] : []),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
      ].join('\n');

      const emailBody = [headers, '', message].join('\n');
      const encodedMessage = Buffer.from(emailBody)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId: lead.threadId,
        },
      });
      console.log(`[REPLY] Email sent to ${recipientEmail} via centralized account`);
    } catch (gmailError) {
      console.error('[REPLY] Failed to send reply via centralized account:', gmailError);
    }

    // Cache Invalidation & Socket Broadcast
    await cacheService.del(`lead:thread:${id}`);
    const io = getSocketIO();
    if (io) {
      io.to(`org:${orgId}`).emit('lead:update', lead);
    }

    res.json({ success: true, message: 'Reply sent successfully', data: lead });
  } catch (error) {
    console.error('[ERROR] Error replying to inquiry:', error);
    res.status(500).json({ message: 'Error sending reply' });
  }
};

async function fetchAllMessageIds(
  gmail: any,
  query: string,
  maxPerPage = 500,
): Promise<{ id: string, threadId: string }[]> {
  const all: { id: string, threadId: string }[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const response: any = await gmail.users.messages.list({
      userId: 'me',
      maxResults: maxPerPage,
      q: query,
      ...(pageToken ? { pageToken } : {}),
    });

    const msgs = response.data.messages || [];
    all.push(...msgs);
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return all;
}

// ─────────────────────────────────────────────────────────────
// CENTRALIZED GMAIL SYNC
// Syncs ONLY from leads@dealerscloud.com via actionautoutah.dev@gmail.com
// Paginates through ALL matching emails — not capped at 100.
// ─────────────────────────────────────────────────────────────
export const syncCentralGmail = asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req.user as IUser)._id.toString();
    console.log(`[CENTRAL-SYNC] Starting sync for user: ${userId} — source filter: ${LEADS_SOURCE_EMAIL}`);

    const config = await OrgLeadConfig.findOne({ organizationId: req.orgId, isActive: true });
    const isConfigured = !!(config && config.gmailConnected && config.refreshToken);

    if (!isConfigured) {
      return res.status(400).json(
        new ApiResponse(400, null, 'Gmail ingestion not configured for this organization. Please connect Google via Settings.')
      );
    }

    const oauth2Client = await getCentralOAuth2Client(req.orgId as string);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    console.log(`[CENTRAL-SYNC] Fetching recent emails (7d) from: ${LEADS_SOURCE_EMAIL}`);
    let messages: { id: string, threadId: string }[];
    try {
      messages = await withRetry(() =>
        fetchAllMessageIds(gmail, `in:inbox from:${LEADS_SOURCE_EMAIL} newer_than:7d`)
      );
    } catch (gmailError: any) {
      console.error(`[CENTRAL-SYNC] Gmail API error:`, gmailError.message);
      throw new Error(`Gmail API error: ${gmailError.message}`);
    }

    console.log(`[CENTRAL-SYNC] Found ${messages.length} recent emails from ${LEADS_SOURCE_EMAIL}`);

    const existingThreadIds = new Set(
      (await Lead.find({ organizationId: req.orgId, threadId: { $exists: true, $ne: null } })
        .select('threadId')
        .lean()).map((l: any) => l.threadId)
    );

    let syncedCount = 0;
    const errors: string[] = [];
    const MAX_SYNC_PER_RUN = 20;

    for (const message of messages) {
      if (syncedCount >= MAX_SYNC_PER_RUN) {
        console.log(`[CENTRAL-SYNC] Reached safe limit of ${MAX_SYNC_PER_RUN} per run. Stopping this batch.`);
        break;
      }

      try {
        if (existingThreadIds.has(message.threadId)) continue;
        await sleep(1000);

        let details: any;
        try {
          details = await withRetry(() =>
            gmail.users.messages.get({
              userId: 'me',
              id: message.id!,
              format: 'full',
            })
          );
        } catch (retryError: any) {
          const isQuota = retryError.code === 403 || retryError.code === 429;
          if (isQuota) {
            console.warn(`[CENTRAL-SYNC] Persistent Quota hit. Ending this sync session early with partial results.`);
            break;
          }
          throw retryError;
        }

        const headers = details.data.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const from = getHeader('from');
        const subject = getHeader('subject');
        const emailMatch = from.match(/<([^>]+)>|([^\s"<>]+@[^\s"<>]+)/);
        const emailAddr = (emailMatch?.[1] || emailMatch?.[2] || '').toLowerCase().trim();
        const senderName = from.replace(/<[^>]*>/g, '').replace(/['"]/g, '').trim() || emailAddr;

        if (emailAddr && !emailAddr.includes(LEADS_SOURCE_EMAIL.toLowerCase())) {
          console.log(`[CENTRAL-SYNC] Skipping unexpected secondary sender in thread: ${emailAddr}`);
          existingThreadIds.add(message.threadId);
          continue;
        }

        let body = '';
        if (details.data.payload?.parts) {
          const textPart = details.data.payload.parts.find((p: any) => p.mimeType === 'text/plain');
          const htmlPart = details.data.payload.parts.find((p: any) => p.mimeType === 'text/html');
          const part = textPart || htmlPart;
          if (part?.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (!body) {
            for (const p of details.data.payload.parts) {
              if (p.parts) {
                const nested = p.parts.find((np: any) => np.mimeType === 'text/plain');
                if (nested?.body?.data) {
                  body = Buffer.from(nested.body.data, 'base64').toString('utf-8');
                  break;
                }
              }
            }
          }
        } else if (details.data.payload?.body?.data) {
          body = Buffer.from(details.data.payload.body.data, 'base64').toString('utf-8');
        }

        const parsed = await parseEmailBody(body, subject, from);
        let firstName = '';
        let lastName = '';
        let leadEmail = emailAddr;
        let leadPhone = '';
        let vehicleInfo = { year: '', make: '', model: '' };
        let comments = '';
        let leadSource = 'ADF Lead (DealersCloud)';

        if (parsed.adfData) {
          firstName = parsed.adfData.firstName;
          lastName = parsed.adfData.lastName;
          leadEmail = parsed.adfData.email || emailAddr;
          leadPhone = parsed.adfData.phone;
          vehicleInfo = {
            year: parsed.adfData.vehicle.year,
            make: parsed.adfData.vehicle.make,
            model: parsed.adfData.vehicle.model,
          };
          comments = parsed.adfData.comments;
          leadSource = parsed.adfData.source || 'ADF Lead (DealersCloud)';
        } else {
          const nameParts = senderName.split(' ').filter((p: string) => p.length > 0);
          firstName = nameParts[0] || emailAddr.split('@')[0];
          lastName = nameParts.slice(1).join(' ') || '';
          leadSource = 'DealersCloud Lead';
        }

        const newLead = new Lead({
          organizationId: req.orgId,
          createdBy: userId,
          firstName,
          lastName,
          email: leadEmail,
          phone: leadPhone,
          senderName,
          senderEmail: LEADS_SOURCE_EMAIL,
          subject,
          body: body.substring(0, 2000),
          parsedContent: parsed.parsedContent,
          channel: parsed.channel,
          threadId: details.data.threadId,
          messageId: message.id,
          source: leadSource,
          status: 'New',
          isRead: false,
          centralIngestion: true,
          vehicle: vehicleInfo,
          comments,
        });

        try {
          await newLead.save();
          existingThreadIds.add(details.data.threadId);
          syncedCount++;
          console.log(`[CENTRAL-SYNC] Created lead: ${firstName} ${lastName} [${parsed.channel}] — ${leadEmail}`);

          const io = getSocketIO();
          if (io) {
            io.to(`org:${req.orgId}`).emit('lead:new', newLead);
          }

          await activityService.createActivity({
            userId: userId,
            organizationId: req.orgId || 'global',
            type: 'other',
            title: 'Lead Synced from Gmail',
            description: `Lead ${firstName} ${lastName} synced from DealtCloud filter`,
            metadata: { leadId: newLead._id.toString(), threadId: details.data.threadId }
          });

          logger.info({ leadId: newLead._id, threadId: details.data.threadId }, 'Lead synced via Gmail');
        } catch (saveError: any) {
          if (saveError.code === 11000) {
            console.log(`[CENTRAL-SYNC] Skipping already synced lead (Duplicate Key): ${message.id}`);
            existingThreadIds.add(message.threadId);
            continue;
          }
          throw saveError;
        }

      } catch (error: any) {
        console.error(`[CENTRAL-SYNC] Error processing message ${message.id}:`, error.message);
        errors.push(`Message ${message.id}: Processing failed`);
      }
    }

    res.json(
      new ApiResponse(
        200,
        { syncedCount, totalFound: messages.length, errors: errors.length > 0 ? errors : undefined },
        `Sync completed. ${syncedCount} new leads added from ${LEADS_SOURCE_EMAIL}.`
      )
    );
  } catch (error: any) {
    console.error('[CENTRAL-SYNC] Unhandled error:', error);
    throw error;
  }
});

export const syncGmailInquiries = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  console.log('[SYNC] Legacy syncGmailInquiries called — redirecting to centralized sync');
  return syncCentralGmail(req, res, next);
});

export const getCentralSyncStatus = asyncHandler(async (req: Request, res: Response) => {
  const config = await OrgLeadConfig.findOne({ organizationId: req.orgId, isActive: true });
  const connected = !!(config && config.gmailConnected && config.refreshToken);
  
  const email = connected ? config.gmailAddress : null;

  res.json(
    new ApiResponse(
      200,
      { 
        connected, 
        email, 
        leadsSourceEmail: LEADS_SOURCE_EMAIL,
        mode: connected ? 'organization' : 'unconfigured'
      },
      connected ? 'Lead ingestion active' : 'Not configured'
    )
  );
});

export const setAppointmentForLead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { date, time, notes, locationOrVehicle } = req.body;
  const userId = (req.user as IUser)._id;

  const orgId = req.orgId;
  const lead = await Lead.findOneAndUpdate(
    { _id: id, organizationId: orgId },
    {
      status: 'Appointment Set',
      appointment: {
        date: new Date(date),
        time,
        notes: notes || '',
        location: locationOrVehicle || '',
      },
    },
    { new: true }
  );

  if (!lead) {
    return res.status(404).json(new ApiResponse(404, null, 'Lead not found'));
  }

  // 1. Sync to Google Calendar (New Stability Update)
  try {
      const startTime = new Date(date);
      const [hours, minutes] = time.split(':');
      startTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      
      const endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1); // Default 1hr

      const appointmentData = {
          title: `Appointment: ${lead.firstName} ${lead.lastName || ''}`,
          description: notes,
          startTime,
          endTime,
          location: locationOrVehicle,
          organizationId: orgId,
          createdBy: userId,
          participants: [userId.toString()],
          entryType: 'appointment' as const,
          status: 'scheduled' as const
      };

      await googleCalendarService.syncAppointmentToGoogleCalendar(appointmentData as any, userId.toString());
  } catch (syncError) {
      console.warn('[LeadSync] Google Calendar sync failed for lead appointment:', syncError);
  }

  // 2. Audit Log
  await activityService.createActivity({
    userId: userId.toString(),
    organizationId: orgId || 'global',
    type: 'other',
    title: 'Appointment Set for Lead',
    description: `Scheduled ${lead.firstName}'s appointment for ${date} at ${time}`,
    metadata: { leadId: lead._id.toString(), date, time }
  });

  logger.info({ leadId: lead._id, userId, date, time }, 'Appointment set for lead');

  // 3. Socket broadcast
  const io = getSocketIO();
  if (io) {
    io.to(`org:${orgId}`).emit('lead:update', lead);
  }

  res.json(new ApiResponse(200, lead, 'Appointment saved and synced successfully'));
});

export const getThreadMessages = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req.user as IUser)._id;

  const lead = await Lead.findOne({ _id: id, organizationId: req.orgId });
  if (!lead || !lead.threadId) {
    return res.status(404).json(new ApiResponse(404, null, 'Lead or thread not found'));
  }

  try {
    const threadCacheKey = `lead:thread:${id}`;
    const cachedThread = await cacheService.get(threadCacheKey);
    if (cachedThread) {
      return res.json(new ApiResponse(200, cachedThread, 'Thread messages fetched (Cached)'));
    }

    const config = await OrgLeadConfig.findOne({ organizationId: req.orgId, isActive: true });
    const oauth2Client = await getCentralOAuth2Client(req.orgId as string);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const threadData = await withRetry(() => gmail.users.threads.get({
      userId: 'me',
      id: lead.threadId!,
      format: 'full',
    }));

    const user = await User.findById(userId);

    const messages = (threadData.data.messages || [])
      .filter((msg: any) => msg.id !== lead.messageId)
      .map((msg: any) => {
        const hdrs = msg.payload?.headers || [];
        const getHeader = (name: string) =>
          hdrs.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const from = getHeader('from');
        const email = from.match(/([^\s<]+@[^\s>]+)/)?.[0] || '';
        const sender = from.replace(/<[^>]*>/g, '').trim() || email;

        let body = '';
        if (msg.payload?.parts) {
          const textPart = msg.payload.parts.find((p: any) => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        } else if (msg.payload?.body?.data) {
          body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
        }

        return {
          id: msg.id,
          messageId: msg.id,
          sender,
          senderEmail: email,
          message: body,
          timestamp: new Date(parseInt(msg.internalDate || Date.now())),
          isOwn: email === user?.email || (config?.gmailAddress === email),
        };
      });

    await cacheService.set(threadCacheKey, { messages }, 1800); // 30 mins
    res.json(new ApiResponse(200, { messages }, 'Thread messages fetched'));
  } catch (error: any) {
    console.error('[THREAD] Error fetching thread messages:', error);
    res.status(400).json(new ApiResponse(400, null, 'Failed to fetch thread messages'));
  }
});