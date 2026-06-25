import { Request, Response, NextFunction } from 'express';
import appointmentService from '../services/appointment.service';
import googleCalendarService from '../services/googleCalendar.service';
import Lead from '../models/lead.model';
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
import customerService from '../services/customer.service';
import { ApiError } from '../utils/ApiError';
import CrmUser from '../models/CrmUser.model';

/**
 * STRICT SOURCE FILTER — only leads from this address are ingested.
 */
const LEADS_SOURCE_EMAIL = 'leads@dealerscloud.com';
const DEFAULT_UNANSWERED_THRESHOLD_MINUTES = Number(process.env.CRM_UNANSWERED_INQUIRY_THRESHOLD_MINUTES || 60);
const UNANSWERED_LEAD_STATUSES = ['New', 'Pending'];

function parseReminderThreshold(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UNANSWERED_THRESHOLD_MINUTES;
  return Math.min(Math.max(Math.round(parsed), 5), 1440);
}

function leadCustomerName(lead: any) {
  return `${lead.firstName || 'Unknown'} ${lead.lastName || ''}`.trim();
}

function leadLastCustomerActivityAt(lead: any) {
  return lead.followUp?.lastCustomerActivityAt || lead.createdAt || lead.updatedAt;
}

function serializeUnansweredLead(lead: any, now = Date.now()) {
  const lastActivity = leadLastCustomerActivityAt(lead);
  const lastActivityTime = lastActivity ? new Date(lastActivity).getTime() : now;

  return {
    _id: lead._id.toString(),
    customerName: leadCustomerName(lead),
    email: lead.email,
    phone: lead.phone,
    subject: lead.subject,
    source: lead.source,
    channel: lead.channel,
    status: lead.status,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    lastCustomerActivityAt: lastActivity,
    lastReminderSentAt: lead.followUp?.lastReminderSentAt || null,
    reminderCount: lead.followUp?.reminderCount || 0,
    minutesUnanswered: Math.max(0, Math.floor((now - lastActivityTime) / 60000)),
  };
}

async function getCrmReminderTargets(orgId: string, lead: any) {
  const crmUsers = await CrmUser.find({ organizationId: orgId, isActive: true })
    .select('_id')
    .lean();
  const targetIds = crmUsers.map((crmUser: any) => crmUser._id.toString());
  if (lead.createdBy) targetIds.push(lead.createdBy.toString());
  return Array.from(new Set(targetIds));
}

function buildUnansweredReminderQuery(orgId: string, cutoff: Date) {
  return {
    organizationId: orgId,
    status: { $in: UNANSWERED_LEAD_STATUSES },
    $or: [
      { 'followUp.lastCustomerActivityAt': { $lte: cutoff } },
      {
        'followUp.lastCustomerActivityAt': { $exists: false },
        createdAt: { $lte: cutoff },
      },
    ],
  };
}

// ─── Cached system user lookup ────────────────────────────────────────────────
// Cached in-process to avoid a DB round-trip on every single lead ingested.
// Cleared on process restart only.
let _cachedSystemUserId: string | null = null;

async function getSystemUserId(orgId?: string): Promise<string | null> {
  if (_cachedSystemUserId) return _cachedSystemUserId;

  // Priority: super_admin → admin → any user in the system
  const user =
    await User.findOne({ role: 'super_admin' }).select('_id').lean() ||
    await User.findOne({ role: 'admin' }).select('_id').lean() ||
    await User.findOne({}).select('_id').lean();

  if (user) {
    _cachedSystemUserId = (user as any)._id.toString();
    return _cachedSystemUserId;
  }

  logger.error({ orgId }, '[AUTO-SYNC] No system user found — cannot sync leads to customers');
  return null;
}

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
      await cacheService.set(cacheKey, orgConfig, 3600);
    }
  }

  if (orgConfig && orgConfig.gmailConnected && orgConfig.refreshToken) {
    const isCached = !!(await cacheService.get(cacheKey));
    console.log(`[CENTRAL-AUTH] Using tokens from OrgLeadConfig for org: ${orgId}${isCached ? ' (Cached)' : ''}`);

    oauth2Client.setCredentials({
      access_token: orgConfig.accessToken ? decrypt(orgConfig.accessToken) : undefined,
      refresh_token: decrypt(orgConfig.refreshToken),
      expiry_date: orgConfig.expiryDate,
    });
  } else {
    console.error(`[CENTRAL-AUTH] ERROR: No Gmail credentials found for organization: ${orgId}`);
    throw new Error('Please connect your email leads into the CRM settings.');
  }

  oauth2Client.on('tokens', async (tokens) => {
    try {
      console.log(`[CENTRAL-AUTH] Tokens refreshed for org ${orgId}, updating OrgLeadConfig...`);
      const update: any = { expiryDate: tokens.expiry_date };
      if (tokens.access_token) update.accessToken = encrypt(tokens.access_token);
      if (tokens.refresh_token) update.refreshToken = encrypt(tokens.refresh_token);
      await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: update });
      await cacheService.del(`config:org:${orgId}`);
    } catch (err) {
      console.error('[CENTRAL-AUTH] Failed to persist refreshed tokens:', err);
    }
  });

  return oauth2Client;
}

/**
 * Sends a plain-text reply to a lead via the org's centralized Gmail account,
 * threading it onto the original inquiry when possible. Shared by single-reply
 * and bulk-reply flows so the MIME/threading logic only lives in one place.
 */
async function sendLeadReplyEmail(lead: any, message: string, userId: any, orgId: string) {
  const config = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true });
  const oauth2Client = await getCentralOAuth2Client(orgId);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const replyingUser = await User.findById(userId);
  const senderDisplay = replyingUser?.email || config?.gmailAddress || 'actionautoutah.dev@gmail.com';

  const recipientEmail = lead.senderEmail || lead.email;
  const emailHeaders = [
    `From: ${senderDisplay}`,
    `To: ${recipientEmail}`,
    `Subject: Re: ${lead.subject || 'Inquiry Response'}`,
    ...(lead.messageId ? [`In-Reply-To: ${lead.messageId}`] : []),
    ...(lead.threadId ? [`References: ${lead.threadId}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ].join('\n');

  const emailBody = [emailHeaders, '', message].join('\n');
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
}

/**
 * Records a status transition on a lead's audit trail. Caller is responsible
 * for saving the document afterwards (or this can be combined with other
 * field updates in the same .save()).
 */
function pushStatusHistory(lead: any, from: string, to: string, userId: any, reason?: string) {
  if (from === to) return;
  lead.statusHistory = lead.statusHistory || [];
  lead.statusHistory.push({
    from,
    to,
    changedAt: new Date(),
    changedBy: userId,
    reason: reason || undefined,
  });
}

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

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SYNC: Convert Lead to Customer immediately on lead creation.
// Non-fatal — a sync failure NEVER blocks lead creation.
// ─────────────────────────────────────────────────────────────────────────────
async function autoSyncLeadToCustomer(
  orgId: string,
  leadId: string,
  firstName: string,
  lastName: string,
  email: string,
  phone: string,
  vehicleInfo?: { year?: string; make?: string; model?: string },
  channel?: string,
  comments?: string,
  source?: string,
): Promise<void> {
  try {
    // Guard: skip leads with no email — no useful customer record possible
    if (!email || !email.trim()) {
      logger.warn({ leadId }, '[AUTO-SYNC] Skipping — lead has no email');
      return;
    }

    const systemUserId = await getSystemUserId(orgId);
    if (!systemUserId) {
      // Logged inside getSystemUserId; just bail silently here
      return;
    }

    logger.info({ leadId, email, orgId }, '[AUTO-SYNC] Syncing lead to customer database');

    await customerService.upsertFromLead({
      organizationId: orgId,
      createdBy: systemUserId,
      leadId,
      firstName: (firstName || 'Unknown').trim(),
      lastName: (lastName || '').trim(),
      email: email.trim(),
      phone: (phone || '').trim(),
      vehicleInterest: vehicleInfo
        ? { year: vehicleInfo.year, make: vehicleInfo.make, model: vehicleInfo.model }
        : undefined,
      channel,
      comments,
      source,
    });

    logger.info({ leadId, email }, '[AUTO-SYNC] Lead successfully synced to customer credentials');
  } catch (error) {
    logger.error({ error, leadId, orgId }, '[AUTO-SYNC] Lead-to-customer sync failed (non-fatal)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle incoming ADF XML (public endpoint for email webhooks)
// ─────────────────────────────────────────────────────────────────────────────
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
    const config = (req as any).orgLeadConfig;

    const systemUserId = await getSystemUserId(orgId as string);
    if (!systemUserId) {
      console.error('[ADF-ERROR] No administrative user found to associate with lead creation');
      return res.status(500).json({ message: 'Internal server error: No administrative context' });
    }

    const newLead = new Lead({
      organizationId: orgId,
      createdBy: systemUserId,
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
      followUp: {
        lastCustomerActivityAt: new Date(),
        reminderCount: 0,
        reminderHistory: [],
      },
    });

    await newLead.save();
    console.log(`[ADF] New Lead Saved: ${adfData.firstName} ${adfData.lastName}`);

    // ✨ AUTO-SYNC: Immediately add to customer database
    await autoSyncLeadToCustomer(
      orgId as string,
      newLead._id.toString(),
      adfData.firstName,
      adfData.lastName,
      adfData.email,
      adfData.phone,
      adfData.vehicle,
      'adf',
      adfData.comments,
      adfData.source || 'ADF Email'
    );

    const io = getSocketIO();
    if (io) {
      const orgIdString = req.query.orgId || req.body.organizationId || 'global';
      io.to(`org:${orgIdString}`).emit('lead:new', newLead);
    }

    const vehicleInterest = adfData.vehicle
      ? `${adfData.vehicle.year} ${adfData.vehicle.make} ${adfData.vehicle.model}`.trim()
      : undefined;

    const { title, message } = notificationTemplates.new_lead({
      customerName: `${adfData.firstName} ${adfData.lastName}`.trim(),
      source: 'ADF Email',
      vehicleInterest: vehicleInterest || undefined,
    });

    await notifyOrgAdmins(
      orgId as string,
      'new_lead',
      title,
      message,
      {
        leadId: newLead._id.toString(),
        customerName: `${adfData.firstName} ${adfData.lastName}`.trim(),
        email: adfData.email,
        source: 'ADF Email',
        channel: 'adf',
      }
    );

    await activityService.createActivity({
      userId: systemUserId,
      organizationId: orgId || 'global',
      type: 'other',
      title: 'New Lead Ingested',
      description: `New lead ${adfData.firstName} ${adfData.lastName} from ${newLead.source}`,
      metadata: { leadId: newLead._id.toString(), channel: 'adf' },
      ipAddress: req.ip,
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
        'centralIngestion labels followUp statusHistory'
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

export const getLeadById = async (req: Request, res: Response) => {
  try {
    const orgId = req.orgId;
    const { id } = req.params;

    const lead = await Lead.findOne({ _id: id, organizationId: orgId })
      .select(
        'firstName lastName email phone senderEmail senderName subject ' +
        'parsedContent threadId messageId isRead isPending channel ' +
        'source status vehicle comments appointment createdAt updatedAt ' +
        'centralIngestion labels followUp statusHistory'
      )
      .lean();

    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    res.json(new ApiResponse(200, lead));
  } catch (error) {
    console.error('[ERROR] Error fetching lead by id:', error);
    res.status(500).json({ message: 'Error fetching lead' });
  }
};

export const getUnansweredInquiryReminders = async (req: Request, res: Response) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(400).json({ message: 'Organization context missing' });
    }

    const thresholdMinutes = parseReminderThreshold(req.query.thresholdMinutes);
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const cutoff = new Date(Date.now() - thresholdMinutes * 60000);

    const leads = await Lead.find(buildUnansweredReminderQuery(orgId, cutoff))
      .select(
        'firstName lastName email phone subject channel source status ' +
        'createdAt updatedAt followUp'
      )
      .sort({ 'followUp.lastCustomerActivityAt': 1, createdAt: 1 })
      .limit(limit)
      .lean();

    res.json(new ApiResponse(200, {
      thresholdMinutes,
      count: leads.length,
      reminders: leads.map((lead) => serializeUnansweredLead(lead)),
    }));
  } catch (error) {
    logger.error(error, '[LEAD-REMINDERS] Error fetching unanswered inquiries');
    res.status(500).json({ message: 'Error fetching unanswered inquiry reminders' });
  }
};

export const runUnansweredInquiryReminderCheck = async (req: Request, res: Response) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(400).json({ message: 'Organization context missing' });
    }

    const thresholdMinutes = parseReminderThreshold(req.query.thresholdMinutes || req.body?.thresholdMinutes);
    const limit = Math.min(parseInt((req.query.limit || req.body?.limit) as string) || 25, 50);
    const now = Date.now();
    const cutoff = new Date(now - thresholdMinutes * 60000);

    const leads = await Lead.find(buildUnansweredReminderQuery(orgId, cutoff))
      .select(
        'createdBy firstName lastName email phone subject channel source status ' +
        'createdAt updatedAt followUp'
      )
      .sort({ 'followUp.lastCustomerActivityAt': 1, createdAt: 1 })
      .limit(limit)
      .lean();

    const remindedLeads: any[] = [];
    let notificationCount = 0;

    for (const lead of leads) {
      const lastReminderSentAt = lead.followUp?.lastReminderSentAt
        ? new Date(lead.followUp.lastReminderSentAt).getTime()
        : 0;

      if (lastReminderSentAt > now - thresholdMinutes * 60000) {
        continue;
      }

      const customerName = leadCustomerName(lead);
      const targetUserIds = await getCrmReminderTargets(orgId, lead);
      const notifications = [];

      for (const userId of targetUserIds) {
        const notification = await safeCreateNotification({
          userId,
          organizationId: orgId,
          type: 'crm_task_due',
          title: 'Unanswered customer inquiry',
          message: `${customerName} has not received a response for ${thresholdMinutes}+ minutes.`,
          metadata: {
            reminderKind: 'unanswered_inquiry',
            leadId: lead._id.toString(),
            customerName,
            email: lead.email,
            channel: lead.channel,
            thresholdMinutes,
            route: `/crm/leads?leadId=${lead._id.toString()}`,
          },
        });

        if (notification) {
          notificationCount++;
          notifications.push({
            sentAt: new Date(),
            userId,
            thresholdMinutes,
            notificationId: (notification as any)._id,
            note: 'Automated unanswered inquiry reminder',
          });
        }
      }

      if (notifications.length > 0) {
        await Lead.updateOne(
          { _id: lead._id, organizationId: orgId },
          {
            $set: { 'followUp.lastReminderSentAt': new Date() },
            $inc: { 'followUp.reminderCount': 1 },
            $push: { 'followUp.reminderHistory': { $each: notifications } },
          }
        );
        remindedLeads.push(serializeUnansweredLead(lead, now));
      }
    }

    res.json(new ApiResponse(200, {
      thresholdMinutes,
      scanned: leads.length,
      reminderCount: remindedLeads.length,
      notificationCount,
      reminders: remindedLeads,
    }));
  } catch (error) {
    logger.error(error, '[LEAD-REMINDERS] Error running unanswered inquiry reminders');
    res.status(500).json({ message: 'Error running unanswered inquiry reminder check' });
  }
};

export const updateLead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    const user = req.user || req.crmUser;
    if (!user) throw new ApiError(401, 'Please authenticate');
    const userId = user._id;
    const orgId = req.orgId;

    const lead = await Lead.findOne({ _id: id, organizationId: orgId });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const fromStatus = lead.status;
    const isClosing = status === 'Closed' && fromStatus !== 'Closed';
    const isReopening = fromStatus === 'Closed' && status !== 'Closed';
    if ((isClosing || isReopening) && !(reason && String(reason).trim())) {
      return res.status(400).json({ message: 'A reason is required to close or reopen this ticket.' });
    }

    lead.status = status;
    if (['Contacted', 'Appointment Set', 'Closed'].includes(status)) {
      lead.isPending = false;
      lead.followUp = { ...(lead.followUp as any), lastRepResponseAt: new Date() };
    }
    pushStatusHistory(lead, fromStatus, status, userId, reason);
    await lead.save();

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
      metadata: { leadId: lead._id.toString(), status, reason }
    });

    logger.info({ leadId: lead._id, status, userId }, 'Lead status updated');

    if (isClosing) {
      try {
        const closingMessage = `Hi ${lead.firstName || 'there'},\n\nWe've marked your inquiry as resolved. If you have any more questions, feel free to reply to this email anytime.\n\nThanks!`;
        await sendLeadReplyEmail(lead, closingMessage, userId, orgId as string);
      } catch (emailError) {
        console.error('[STATUS] Failed to send closed-ticket email to customer:', emailError);
      }
    }

    const io = getSocketIO();
    if (io) {
      io.to(`org:${orgId}`).emit('lead:update', lead);
    }

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: 'Error updating lead' });
  }
};

export const createInquiry = async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, phone, vehicle, comments, source, channel } = req.body;
    const user = req.user || req.crmUser;
    if (!user) throw new ApiError(401, 'Please authenticate');
    const userId = user._id;

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
      followUp: {
        lastCustomerActivityAt: new Date(),
        reminderCount: 0,
        reminderHistory: [],
      },
    });

    const savedLead = await newLead.save();

    // ✨ AUTO-SYNC: Immediately add to customer database
    await autoSyncLeadToCustomer(
      req.orgId as string,
      savedLead._id.toString(),
      firstName,
      lastName || '',
      email,
      phone,
      vehicle,
      detectedChannel,
      comments || '',
      source || 'Manual Entry'
    );

    console.log(`[SUCCESS] New Inquiry Created: ${firstName} ${lastName} (ID: ${savedLead._id})`);

    const io = getSocketIO();
    if (io) {
      io.to(`org:${req.orgId}`).emit('lead:new', savedLead);
    }

    if (req.orgId) {
      const vehicleInterest = vehicle
        ? `${vehicle?.year || ''} ${vehicle?.make || ''} ${vehicle?.model || ''}`.trim()
        : undefined;
      const { title, message } = notificationTemplates.new_lead({
        customerName: `${firstName} ${lastName || ''}`.trim(),
        source: source || 'Manual Entry',
        vehicleInterest: vehicleInterest || undefined,
      });

      await notifyOrgAdmins(
        req.orgId as string,
        'new_lead',
        title,
        message,
        {
          leadId: savedLead._id.toString(),
          customerName: `${firstName} ${lastName || ''}`.trim(),
          email,
          source: source || 'Manual Entry',
          channel: detectedChannel,
        }
      );
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
    const user = req.user || req.crmUser;

    const lead = await Lead.findOne({ _id: id, organizationId: orgId });
    if (!lead) return res.status(404).json({ message: 'Inquiry not found' });

    pushStatusHistory(lead, lead.status, 'Pending', user?._id);
    lead.isPending = true;
    lead.status = 'Pending';
    await lead.save();

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
    const user = req.user || req.crmUser;
    if (!user) throw new ApiError(401, 'Please authenticate');
    const userId = user._id;
    const orgId = req.orgId;

    if (!message) {
      return res.status(400).json({ message: 'Reply message is required' });
    }

    const lead = await Lead.findOne({ _id: id, organizationId: orgId });
    if (!lead) {
      return res.status(404).json({ message: 'Inquiry not found' });
    }

    pushStatusHistory(lead, lead.status, 'Contacted', userId);
    lead.status = 'Contacted';
    lead.isRead = true;
    lead.isPending = false;
    lead.followUp = { ...(lead.followUp as any), lastRepResponseAt: new Date() };
    await lead.save();

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
      await sendLeadReplyEmail(lead, message, userId, req.orgId as string);
    } catch (gmailError) {
      console.error('[REPLY] Failed to send reply via centralized account:', gmailError);
    }

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

const MAX_BULK_REPLY_LEADS = 50;

export const bulkReplyToInquiries = async (req: Request, res: Response) => {
  try {
    const { leadIds, message } = req.body;
    const user = req.user || req.crmUser;
    if (!user) throw new ApiError(401, 'Please authenticate');
    const userId = user._id;
    const orgId = req.orgId;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'Reply message is required' });
    }
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ message: 'At least one lead must be selected' });
    }
    if (leadIds.length > MAX_BULK_REPLY_LEADS) {
      return res.status(400).json({ message: `You can reply to at most ${MAX_BULK_REPLY_LEADS} leads at once` });
    }

    const leads = await Lead.find({ _id: { $in: leadIds }, organizationId: orgId });

    const results = await Promise.allSettled(
      leads.map(async (lead) => {
        pushStatusHistory(lead, lead.status, 'Contacted', userId);
        lead.status = 'Contacted';
        lead.isRead = true;
        lead.isPending = false;
        lead.followUp = { ...(lead.followUp as any), lastRepResponseAt: new Date() };
        await lead.save();

        await sendLeadReplyEmail(lead, message, userId, orgId as string);

        await activityService.createActivity({
          userId: userId.toString(),
          organizationId: orgId || 'global',
          type: 'other',
          title: 'Lead Replied (Bulk)',
          description: `Bulk reply sent to lead ${lead.firstName}`,
          metadata: { leadId: lead._id.toString() }
        });

        await cacheService.del(`lead:thread:${lead._id}`);

        const io = getSocketIO();
        if (io) {
          io.to(`org:${orgId}`).emit('lead:update', lead);
        }

        return lead._id.toString();
      })
    );

    const failed: { leadId: string; error: string }[] = [];
    let sent = 0;
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        sent += 1;
      } else {
        failed.push({ leadId: leads[idx]?._id?.toString() || leadIds[idx], error: result.reason?.message || 'Failed to send' });
      }
    });

    logger.info({ orgId, userId, requested: leadIds.length, sent, failed: failed.length }, 'Bulk reply completed');

    res.json({ success: true, sent, failed });
  } catch (error) {
    console.error('[ERROR] Error sending bulk reply:', error);
    res.status(500).json({ message: 'Error sending bulk reply' });
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
          followUp: {
            lastCustomerActivityAt: new Date(),
            reminderCount: 0,
            reminderHistory: [],
          },
        });

        try {
          await newLead.save();

          // ✨ AUTO-SYNC: Immediately add to customer database
          await autoSyncLeadToCustomer(
            req.orgId as string,
            newLead._id.toString(),
            firstName,
            lastName,
            leadEmail,
            leadPhone,
            vehicleInfo,
            parsed.channel,
            comments,
            leadSource
          );

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
            description: `Lead ${firstName} ${lastName} synced from DealersCloud filter`,
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
        mode: connected ? 'organization' : 'unconfigured',
      },
      connected ? 'Lead ingestion active' : 'Not configured'
    )
  );
});

export const setAppointmentForLead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { date, time, notes, locationOrVehicle } = req.body;
  const user = req.user || req.crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');

  const userId = user._id;
  const orgId = req.orgId;

  const crmUser = await CrmUser.exists({ _id: userId });
  if (crmUser) {
    const isConnected = await googleCalendarService.isCrmUserCalendarConnected(userId.toString());
    if (!isConnected) {
      throw new ApiError(401, 'Google Calendar is not connected. Please go to Settings to link your account before scheduling lead appointments.');
    }
  }

  const lead = await Lead.findOne({ _id: id, organizationId: orgId });
  if (!lead) {
    throw new ApiError(404, 'Lead not found');
  }

  const startTime = new Date(date);
  const [hours, minutes] = time.split(':');
  startTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

  const endTime = new Date(startTime);
  endTime.setHours(startTime.getHours() + 1);

  const appointmentData = {
    title: `Appointment: ${lead.firstName} ${lead.lastName || ''}`,
    description: notes || `Lead Appointment for ${lead.firstName}`,
    startTime,
    endTime,
    location: locationOrVehicle || '',
    type: 'in-person' as const,
    entryType: 'appointment' as const,
    participants: [userId.toString()],
    leadId: lead._id.toString(),
    customerBooking: {
      isCustomerBooking: true,
      firstName: lead.firstName,
      lastName: lead.lastName || '',
      email: lead.email || '',
      phone: lead.phone || '',
    },
  };

  const appointment = await appointmentService.createAppointment(
    userId.toString(),
    orgId as string,
    appointmentData
  );

  pushStatusHistory(lead, lead.status, 'Appointment Set', userId);
  lead.status = 'Appointment Set';
  lead.appointment = {
    date: new Date(date),
    time,
    notes: notes || '',
    location: locationOrVehicle || '',
  };
  await lead.save();

  await activityService.createActivity({
    userId: userId.toString(),
    organizationId: orgId || 'global',
    type: 'other',
    title: 'Appointment Set for Lead',
    description: `Scheduled ${lead.firstName}'s appointment for ${date} at ${time}`,
    metadata: { leadId: lead._id.toString(), appointmentId: appointment._id, date, time }
  });

  const io = getSocketIO();
  if (io) {
    io.to(`org:${orgId}`).emit('lead:update', lead);
  }

  res.json(new ApiResponse(200, { lead, appointment }, 'Appointment scheduled and synced successfully'));
});

export const getThreadMessages = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = req.user || req.crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  const userId = user._id;

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

    const threadUser = await User.findById(userId);

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
          isOwn: email === threadUser?.email || (config?.gmailAddress === email),
        };
      });

    await cacheService.set(threadCacheKey, { messages }, 1800);
    res.json(new ApiResponse(200, { messages }, 'Thread messages fetched'));
  } catch (error: any) {
    if (error.message?.includes('connect your email leads') || error.message?.includes('configuration not found')) {
      return res.json(new ApiResponse(200, { messages: [] }, 'Centralized sync not configured'));
    }
    console.error('[THREAD] Error fetching thread messages:', error);
    res.status(400).json(new ApiResponse(400, null, 'Failed to fetch thread messages'));
  }
});

export default {
  receiveADF,
  getAllLeads,
  updateLead,
  createInquiry,
  markAsRead,
  markAsPending,
  replyToInquiry,
  bulkReplyToInquiries,
  syncCentralGmail,
  syncGmailInquiries,
  setAppointmentForLead,
  getThreadMessages,
  getCentralSyncStatus,
};
