import { Request, Response, NextFunction } from 'express';
import Lead from '../models/lead.model';
import { parseStringPromise } from 'xml2js';
import User, { IUser } from '../models/User.model';
import AuditLog from '../models/AuditLog.model';
import { google } from 'googleapis';
import { asyncHandler } from '../utils/asyncHandler';
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
import SystemConfig from '../models/SystemConfig.model';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const CENTRAL_EMAIL = process.env.CENTRAL_INGESTION_EMAIL || 'actionautoutah.dev@gmail.com';

/**
 * STRICT SOURCE FILTER — only leads from this address are ingested.
 * All other senders are silently ignored during Gmail sync.
 */
const LEADS_SOURCE_EMAIL = 'leads@dealerscloud.com';

async function getCentralOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.CENTRAL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    process.env.CENTRAL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
    process.env.CENTRAL_GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI,
  );

  // Try to load tokens from SystemConfig first
  const config = await SystemConfig.findOne({ key: 'central_gmail_tokens' });
  let credentials = {
    access_token: process.env.CENTRAL_GMAIL_ACCESS_TOKEN,
    refresh_token: process.env.CENTRAL_GMAIL_REFRESH_TOKEN,
    expiry_date: Number(process.env.CENTRAL_GMAIL_EXPIRY_DATE) || undefined,
  };

  if (config) {
    console.log('[CENTRAL-AUTH] Using persistent tokens from database');
    credentials = { ...credentials, ...(config.value as any) };
  } else {
    console.log('[CENTRAL-AUTH] Using tokens from environment variables');
  }

  oauth2Client.setCredentials(credentials);

  // Persistence listener: update database when tokens are refreshed
  oauth2Client.on('tokens', async (tokens) => {
    try {
      console.log('[CENTRAL-AUTH] Tokens refreshed, updating database...');
      await SystemConfig.findOneAndUpdate(
        { key: 'central_gmail_tokens' },
        {
          key: 'central_gmail_tokens',
          value: tokens,
          description: 'OAuth2 tokens for centralized Gmail lead ingestion'
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      console.error('[CENTRAL-AUTH] Failed to persist refreshed tokens:', err);
    }
  });

  return oauth2Client;
}

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

    const newLead = new Lead({
      organizationId: req.query.orgId || req.body.organizationId || 'global',
      firstName: adfData.firstName,
      lastName: adfData.lastName,
      email: adfData.email,
      phone: adfData.phone,
      vehicle: adfData.vehicle,
      comments: adfData.comments,
      parsedContent: adfData.parsedContent,
      channel: 'adf',
      source: adfData.source || 'ADF Email',
      senderEmail: LEADS_SOURCE_EMAIL,
      centralIngestion: true,
    });

    await newLead.save();
    console.log(`[ADF] New Lead Saved: ${adfData.firstName} ${adfData.lastName}`);

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

    await AuditLog.create({
      entityType: 'Lead',
      entityId: newLead._id,
      action: 'CREATE',
      reason: 'New Lead via ADF/XML webhook',
      changes: {
        firstName: adfData.firstName,
        lastName: adfData.lastName,
        source: 'ADF Email',
        channel: 'adf',
      },
    });

    res.status(200).send('Lead processed successfully');
  } catch (error) {
    console.error('Error processing ADF:', error);
    res.status(500).send('Internal Server Error');
  }
};

// ─────────────────────────────────────────────────────────────
// Get all leads — FILTERED BY USER
//
// CHANGES FROM ORIGINAL:
//  1. Removed the $or across senderEmail/centralIngestion — the source
//     filter is enforced at write-time so it is not needed at read-time.
//     This eliminates the full collection scan that caused the 30s timeout.
//  2. Added .lean() — returns plain JS objects instead of full Mongoose
//     documents (3–5× faster, much less memory on large collections).
//  3. Added .select() — omits the 'body' field (up to 2 KB per lead)
//     from the list response; it is fetched on demand in the detail view.
//
// REQUIRED INDEXES (add to your Lead model or a migration):
//   LeadSchema.index({ createdBy: 1, createdAt: -1 });
//   LeadSchema.index({ createdBy: 1, status: 1 });
// ─────────────────────────────────────────────────────────────
export const getAllLeads = async (req: Request, res: Response) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(400).json({ message: 'Organization context missing' });
    }

    const leads = await Lead.find({ organizationId: orgId })
      .select(
        'firstName lastName email phone senderEmail senderName subject ' +
        'parsedContent threadId messageId isRead isPending channel ' +
        'source status vehicle comments appointment createdAt updatedAt ' +
        'centralIngestion labels'
        // 'body' intentionally omitted — fetched on demand in the detail view
      )
      .sort({ createdAt: -1 })
      .lean();

    res.json(leads);
  } catch (error) {
    console.error('[ERROR] Error fetching leads:', error);
    res.status(500).json({ message: 'Error fetching leads' });
  }
};

// ─────────────────────────────────────────────────────────────
// Update lead status — USER-SPECIFIC
// ─────────────────────────────────────────────────────────────
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

      await AuditLog.create({
        entityType: 'Lead',
        entityId: lead._id,
        action: 'UPDATE',
        reason: 'Lead status updated',
        performedBy: (req.user as any)?._id,
        changes: { status },
      });
    }

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: 'Error updating lead' });
  }
};

// ─────────────────────────────────────────────────────────────
// Create a new inquiry (manual/test entry) — USER-SPECIFIC
// ─────────────────────────────────────────────────────────────
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

    await AuditLog.create({
      entityType: 'Lead',
      entityId: savedLead._id,
      action: 'CREATE',
      reason: 'New Lead Manual Entry',
      performedBy: (req.user as any)?._id,
      changes: { firstName, lastName, source, channel: detectedChannel },
    });

    res.status(201).json({ success: true, message: 'Inquiry created successfully', data: savedLead });
  } catch (error) {
    console.error('[ERROR] Error creating inquiry:', error);
    res.status(500).json({
      message: 'Error creating inquiry',
      error: process.env.NODE_ENV === 'development' ? error : 'Internal server error',
    });
  }
};

// ─────────────────────────────────────────────────────────────
// Mark as read / pending — USER-SPECIFIC
// ─────────────────────────────────────────────────────────────
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
      { isPending: true },
      { new: true }
    );
    if (!lead) return res.status(404).json({ message: 'Inquiry not found' });
    res.json(lead);
  } catch (error) {
    console.error('[ERROR] Error marking as pending:', error);
    res.status(500).json({ message: 'Error marking inquiry as pending' });
  }
};

// ─────────────────────────────────────────────────────────────
// Reply to an inquiry — sends via centralized account
// ─────────────────────────────────────────────────────────────
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

    await AuditLog.create({
      entityType: 'Lead',
      entityId: lead._id,
      action: 'UPDATE',
      reason: 'Lead replied to',
      performedBy: userId,
      changes: { status: 'Contacted', isRead: true, message },
    });

    // Send reply via centralized Gmail account
    try {
      const oauth2Client = await getCentralOAuth2Client();
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const user = await User.findById(userId);
      const senderDisplay = user?.email || CENTRAL_EMAIL;

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

    res.json({ success: true, message: 'Reply sent successfully', data: lead });
  } catch (error) {
    console.error('[ERROR] Error replying to inquiry:', error);
    res.status(500).json({ message: 'Error sending reply' });
  }
};

// ─────────────────────────────────────────────────────────────
// Helper: fetch ALL Gmail message IDs with pagination
// Loops through all pages so no emails are missed.
// ─────────────────────────────────────────────────────────────
async function fetchAllMessageIds(
  gmail: any,
  query: string,
  maxPerPage = 500,
): Promise<{ id: string }[]> {
  const all: { id: string }[] = [];
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

    if (!process.env.CENTRAL_GMAIL_REFRESH_TOKEN && !process.env.CENTRAL_GMAIL_ACCESS_TOKEN) {
      return res.status(400).json(
        new ApiResponse(400, null, 'Centralized Gmail account not configured. Please set CENTRAL_GMAIL_* environment variables.')
      );
    }

    const oauth2Client = await getCentralOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // ── STRICT FILTER + full pagination — no emails missed ──
    console.log(`[CENTRAL-SYNC] Fetching all emails from: ${LEADS_SOURCE_EMAIL}`);
    let messages: { id: string }[];
    try {
      messages = await fetchAllMessageIds(gmail, `in:inbox from:${LEADS_SOURCE_EMAIL}`);
    } catch (gmailError: any) {
      console.error(`[CENTRAL-SYNC] Gmail API error:`, gmailError.message);
      throw new Error(`Gmail API error: ${gmailError.message}`);
    }

    console.log(`[CENTRAL-SYNC] Found ${messages.length} total emails from ${LEADS_SOURCE_EMAIL}`);

    // Pre-fetch all threadIds already stored for this user to avoid per-message DB queries
    const existingThreadIds = new Set(
      (await Lead.find({ organizationId: req.orgId, threadId: { $exists: true, $ne: null } })
        .select('threadId')
        .lean()).map((l: any) => l.threadId)
    );

    let syncedCount = 0;
    const errors: string[] = [];

    for (const message of messages) {
      try {
        const details = await gmail.users.messages.get({
          userId: 'me',
          id: message.id!,
          format: 'full',
        });

        // Skip already-synced threads without hitting DB again
        if (existingThreadIds.has(details.data.threadId)) continue;

        const headers = details.data.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const from = getHeader('from');
        const subject = getHeader('subject');
        const emailAddr = from.match(/([^\s<]+@[^\s>]+)/)?.[0] || '';
        const senderName = from.replace(/<[^>]*>/g, '').trim() || emailAddr;

        // ── HARD GUARD: double-check sender even though query already filters ──
        if (emailAddr.toLowerCase() !== LEADS_SOURCE_EMAIL.toLowerCase()) {
          console.log(`[CENTRAL-SYNC] Skipping non-leads email from: ${emailAddr}`);
          continue;
        }

        // Extract body
        let body = '';
        if (details.data.payload?.parts) {
          const textPart = details.data.payload.parts.find((p: any) => p.mimeType === 'text/plain');
          const htmlPart = details.data.payload.parts.find((p: any) => p.mimeType === 'text/html');
          const part = textPart || htmlPart;
          if (part?.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          // Check nested parts (multipart/alternative inside multipart/mixed)
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

        // ── Parse email body: detect ADF, classify channel ──
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

        await newLead.save();
        existingThreadIds.add(details.data.threadId);
        syncedCount++;
        console.log(`[CENTRAL-SYNC] Created lead: ${firstName} ${lastName} [${parsed.channel}] — ${leadEmail}`);

        await AuditLog.create({
          entityType: 'Lead',
          entityId: newLead._id,
          action: 'CREATE',
          reason: `New Lead via Centralized Sync (${parsed.channel}) from ${LEADS_SOURCE_EMAIL}`,
          performedBy: userId,
          changes: { email: leadEmail, subject, channel: parsed.channel, senderEmail: LEADS_SOURCE_EMAIL },
        });

      } catch (error) {
        console.error(`[CENTRAL-SYNC] Error processing message ${message.id}:`, error);
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

// ─────────────────────────────────────────────────────────────
// DEPRECATED: Per-user Gmail sync (kept for backward compat)
// ─────────────────────────────────────────────────────────────
export const syncGmailInquiries = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  console.log('[SYNC] Legacy syncGmailInquiries called — redirecting to centralized sync');
  return syncCentralGmail(req, res, next);
});

// ─────────────────────────────────────────────────────────────
// Centralized ingestion status check
// ─────────────────────────────────────────────────────────────
export const getCentralSyncStatus = asyncHandler(async (req: Request, res: Response) => {
  const configured = !!(process.env.CENTRAL_GMAIL_REFRESH_TOKEN || process.env.CENTRAL_GMAIL_ACCESS_TOKEN);
  const email = configured ? CENTRAL_EMAIL : null;

  res.json(
    new ApiResponse(
      200,
      { connected: configured, email, leadsSourceEmail: LEADS_SOURCE_EMAIL },
      configured ? 'Centralized ingestion active' : 'Not configured'
    )
  );
});

// ─────────────────────────────────────────────────────────────
// Appointments
// ─────────────────────────────────────────────────────────────
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

  await AuditLog.create({
    entityType: 'Lead',
    entityId: lead._id,
    action: 'UPDATE',
    reason: 'Appointment set from inquiry page',
    performedBy: userId,
    changes: { status: 'Appointment Set', appointment: { date, time, notes, locationOrVehicle } },
  });

  res.json(new ApiResponse(200, lead, 'Appointment saved successfully'));
});

// ─────────────────────────────────────────────────────────────
// Thread messages — fetched from centralized account
// ─────────────────────────────────────────────────────────────
export const getThreadMessages = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req.user as IUser)._id;

  const lead = await Lead.findOne({ _id: id, organizationId: req.orgId });
  if (!lead || !lead.threadId) {
    return res.status(404).json(new ApiResponse(404, null, 'Lead or thread not found'));
  }

  try {
    const oauth2Client = await getCentralOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const threadData = await gmail.users.threads.get({
      userId: 'me',
      id: lead.threadId,
      format: 'full',
    });

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
          isOwn: email === CENTRAL_EMAIL || email === user?.email,
        };
      });

    res.json(new ApiResponse(200, { messages }, 'Thread messages fetched'));
  } catch (error: any) {
    console.error('[THREAD] Error fetching thread messages:', error);
    res.status(400).json(new ApiResponse(400, null, 'Failed to fetch thread messages'));
  }
});