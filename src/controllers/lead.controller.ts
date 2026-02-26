// Controller for handling ADF XML data and Leads
import { Request, Response } from 'express';
import Lead from '../models/lead.model';
import { parseStringPromise } from 'xml2js';
import User, { IUser } from '../models/User.model';
import AuditLog from '../models/AuditLog.model';
import { google } from 'googleapis';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';

// Handle incoming ADF XML (Auto-lead Data Format)
export const receiveADF = async (req: Request, res: Response) => {
  try {
    // Access the raw body captured in server.ts
    let xmlData = (req as any).rawBody || req.body;

    if (!xmlData || typeof xmlData !== 'string') {
      // Fallback: sometimes body parsers might have already parsed it, 
      // or it's empty.
      return res.status(400).json({ message: 'No valid XML data received' });
    }

    // Parse XML to JSON
    const result = await parseStringPromise(xmlData, {
      explicitArray: false,
      ignoreAttrs: false,
      mergeAttrs: true
    });

    const prospect = result.adf?.prospect;
    if (!prospect) {
      return res.status(400).json({ message: 'Invalid ADF format' });
    }

    const customer = prospect.customer?.contact;
    const { vehicle } = prospect;

    // Extract Name (ADF names can be complex)
    let firstName = 'Unknown';
    let lastName = '';

    if (customer?.name) {
      if (Array.isArray(customer.name)) {
        firstName = customer.name.find((n: any) => n.part === 'first')?._ || firstName;
        lastName = customer.name.find((n: any) => n.part === 'last')?._ || lastName;
      } else if (customer.name.part === 'full') {
        const parts = customer.name._.split(' ');
        firstName = parts[0];
        lastName = parts.slice(1).join(' ');
      } else {
        firstName = customer.name._ || customer.name;
      }
    }

    // Create the Lead
    const newLead = new Lead({
      firstName,
      lastName,
      email: customer?.email?._ || customer?.email,
      phone: customer?.phone?._ || customer?.phone,
      vehicle: {
        year: vehicle?.year?._ || vehicle?.year,
        make: vehicle?.make?._ || vehicle?.make,
        model: vehicle?.model?._ || vehicle?.model,
      },
      comments: `Request Date: ${prospect.requestdate}`,
      source: 'ADF Email'
    });

    await newLead.save();
    console.log(`[ADF] New Lead Saved: ${firstName} ${lastName}`);

    await AuditLog.create({
      entityType: 'Lead',
      entityId: newLead._id,
      action: 'CREATE',
      reason: 'New Lead via ADF/XML',
      changes: { firstName, lastName, source: 'ADF Email' }
    });

    res.status(200).send('Lead processed successfully');
  } catch (error) {
    console.error('Error processing ADF:', error);
    res.status(500).send('Internal Server Error');
  }
};

// Get all leads for the frontend sidebar - FILTERED BY USER (not organization)
// Each user sees ONLY the leads they synced themselves
export const getAllLeads = async (req: Request, res: Response) => {
  try {
    const userId = (req.user as IUser)._id; // Get current user ID
    // const orgId = (req as any).orgId; // COMMENTED: For organization-wide sharing later
    
    if (!userId) {
      return res.status(400).json({ message: 'User not found' });
    }
    
    // Filter by createdBy (user who synced the lead) - USER-SPECIFIC, not organization-wide
    const leads = await Lead.find({ createdBy: userId }).sort({ createdAt: -1 });
    res.json(leads);
  } catch (error) {
    console.error('[ERROR] Error fetching leads:', error);
    res.status(500).json({ message: 'Error fetching leads' });
  }
};

// Update lead status - USER-SPECIFIC (user can only update their own leads)
export const updateLead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = (req.user as IUser)._id;
    // const orgId = (req as any).orgId; // COMMENTED: For organization-wide sharing later

    const lead = await Lead.findOneAndUpdate(
      { _id: id, createdBy: userId },
      { status },
      { new: true }
    );



    if (lead) {
      await AuditLog.create({
        entityType: 'Lead',
        entityId: lead._id,
        action: 'UPDATE',
        reason: 'Lead status updated',
        performedBy: (req.user as any)?._id,
        changes: { status }
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

// Create a new inquiry (manual/test entry) - USER-SPECIFIC
export const createInquiry = async (req: Request, res: Response) => {
  try {
    console.log('[DEBUG] createInquiry called with body:', req.body);

    const { firstName, lastName, email, phone, vehicle, comments, source } = req.body;
    // const orgId = (req as any).orgId; // COMMENTED: For organization-wide sharing later
    const userId = (req.user as IUser)._id;

    // Validate required fields
    if (!firstName || !email || !phone) {
      console.log('[DEBUG] Missing required fields:', { firstName, email, phone });
      return res.status(400).json({
        message: 'Missing required fields: firstName, email, phone',
        received: { firstName, email, phone }
      });
    }

    const newLead = new Lead({
      // organization: orgId, // COMMENTED: For organization-wide sharing later
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
      source: source || 'Manual Entry (Test)',
      status: 'New',
    });

    const savedLead = await newLead.save();
    console.log(`[SUCCESS] New Test Inquiry Created: ${firstName} ${lastName} (ID: ${savedLead._id})`);

    await AuditLog.create({
      entityType: 'Lead',
      entityId: savedLead._id,
      action: 'CREATE',
      reason: 'New Lead Manual Entry',
      performedBy: (req.user as any)?._id,
      changes: { firstName, lastName, source }
    });

    res.status(201).json({
      success: true,
      message: 'Test inquiry created successfully',
      data: savedLead
    });
  } catch (error) {
    console.error('[ERROR] Error creating inquiry:', error);
    res.status(500).json({
      message: 'Error creating inquiry',
      error: process.env.NODE_ENV === 'development' ? error : 'Internal server error'
    });
  }
};

// Mark lead as read - USER-SPECIFIC
export const markAsRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req.user as IUser)._id;
    // const orgId = (req as any).orgId; // COMMENTED: For organization-wide sharing later
    
    const lead = await Lead.findOneAndUpdate(
      { _id: id, createdBy: userId },
      { isRead: true },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ message: 'Inquiry not found' });
    }

    res.json(lead);
  } catch (error) {
    console.error('[ERROR] Error marking as read:', error);
    res.status(500).json({ message: 'Error marking inquiry as read' });
  }
};

// Mark lead as pending - USER-SPECIFIC
export const markAsPending = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req.user as IUser)._id;
    // const orgId = (req as any).orgId; // COMMENTED: For organization-wide sharing later
    
    const lead = await Lead.findOneAndUpdate(
      { _id: id, createdBy: userId },
      { isPending: true },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ message: 'Inquiry not found' });
    }

    res.json(lead);
  } catch (error) {
    console.error('[ERROR] Error marking as pending:', error);
    res.status(500).json({ message: 'Error marking inquiry as pending' });
  }
};

// Reply to an inquiry (send email) - USER-SPECIFIC
export const replyToInquiry = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { message } = req.body
    const userId = (req.user as IUser)._id

    if (!message) {
      return res.status(400).json({ message: 'Reply message is required' })
    }

    const lead = await Lead.findOneAndUpdate(
      { _id: id, createdBy: userId },
      {
        status: 'Contacted',
        isRead: true,
      },
      { new: true }
    )

    if (!lead) {
      return res.status(404).json({ message: 'Inquiry not found' })
    }

    if (lead) {
      await AuditLog.create({
        entityType: 'Lead',
        entityId: lead._id,
        action: 'UPDATE',
        reason: 'Lead replied to',
        performedBy: userId,
        changes: { status: 'Contacted', isRead: true, message }
      })

      try {
        const { google } = require('googleapis')
        const user = await User.findById(userId)
          .select('+googleCalendar.accessToken +googleCalendar.refreshToken +googleCalendar.expiryDate')

        if (user?.googleCalendar?.connected && user.googleCalendar.accessToken) {
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
          )

          oauth2Client.setCredentials({
            access_token: user.googleCalendar.accessToken,
            refresh_token: user.googleCalendar.refreshToken,
            expiry_date: user.googleCalendar.expiryDate
          })

          const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

          const headers = [
            `From: ${user.email}`,
            `To: ${lead.senderEmail || lead.email}`,
            `Subject: Re: ${lead.subject || 'Inquiry Response'}`,
            `In-Reply-To: ${lead.messageId || ''}`,
            `References: ${lead.threadId || ''}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit'
          ].filter(h => !h.includes('In-Reply-To: undefined') && !h.includes('References: undefined')).join('\n')

          const emailBody = [headers, '', message].join('\n')
          const encodedMessage = Buffer.from(emailBody).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

          await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
              raw: encodedMessage,
              threadId: lead.threadId
            }
          })

          console.log(`[REPLY] Email sent to ${lead.email}`)
        }
      } catch (gmailError) {
        console.error('[REPLY] Failed to send Gmail reply:', gmailError)
      }
    }

    res.json({
      success: true,
      message: 'Reply sent successfully',
      data: lead
    })
  } catch (error) {
    console.error('[ERROR] Error replying to inquiry:', error)
    res.status(500).json({ message: 'Error sending reply' })
  }
}

// Sync inquiries from Gmail
export const syncGmailInquiries = asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req.user as IUser)._id.toString();
    console.log(`[SYNC] Starting sync for user: ${userId}`);

    // Get user with Gmail tokens
    const user = await User.findById(userId)
      .select('+googleCalendar.accessToken +googleCalendar.refreshToken +googleCalendar.expiryDate');

    console.log(`[SYNC] User found:`, {
      hasUser: !!user,
      googleCalendarConnected: user?.googleCalendar?.connected,
      hasAccessToken: !!user?.googleCalendar?.accessToken,
      hasRefreshToken: !!user?.googleCalendar?.refreshToken,
    });

    if (!user) {
      return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    if (!user?.googleCalendar?.connected) {
      return res.status(400).json(
        new ApiResponse(400, null, 'Gmail not connected. Please connect your Google account first.')
      );
    }

    if (!user.googleCalendar.accessToken) {
      return res.status(400).json(
        new ApiResponse(400, null, 'Gmail access token missing. Please reconnect your Google account.')
      );
    }

    // Create OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date: user.googleCalendar.expiryDate
    });

    // Get Gmail client
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Fetch emails (from inbox)
    console.log('[SYNC] Fetching emails from Gmail...');
    let response;
    try {
      response = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 500,
        q: 'in:inbox'
      });
    } catch (gmailError: any) {
      console.error(`[SYNC] Gmail API error:`, gmailError.message);
      throw new Error(`Gmail API error: ${gmailError.message}`);
    }

    const messages = response.data.messages || [];
    console.log(`[SYNC] Found ${messages.length} emails in inbox`);

    let syncedCount = 0;
    const errors: string[] = [];

    // Process each message
    for (const message of messages) {
      try {
        const details = await gmail.users.messages.get({
          userId: 'me',
          id: message.id!,
          format: 'full'
        });

        const headers = details.data.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const from = getHeader('from');
        const subject = getHeader('subject');
        const email = from.match(/([^\s<]+@[^\s>]+)/)?.[0] || '';
        const senderName = from.replace(/<[^>]*>/g, '').trim() || email;

        // Extract body
        let body = '';
        if (details.data.payload?.parts) {
          const textPart = details.data.payload.parts.find((p: any) => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        } else if (details.data.payload?.body?.data) {
          body = Buffer.from(details.data.payload.body.data, 'base64').toString('utf-8');
        }

        if (!email) {
          errors.push(`Message ${message.id}: Could not extract email address`);
          continue;
        }

        if (email.toLowerCase() === user.email.toLowerCase()) {
          console.log(`[SYNC] Skipping own email: ${email}`);
          continue;
        }

        // Check if this thread already exists for THIS USER
        const userId = (req.user as IUser)._id;
        const existingLead = await Lead.findOne({ 
          createdBy: userId, 
          threadId: details.data.threadId 
        });

        if (!existingLead) {
          // Extract name from sender (e.g., "John Doe <john@email.com>" → "John Doe")
          const nameParts = senderName.split(' ').filter(p => p.length > 0);
          const firstName = nameParts[0] || email.split('@')[0];
          const lastName = nameParts.slice(1).join(' ') || '';

          // Create new lead from email - ASSOCIATED WITH USER ONLY (not organization)
          const newLead = new Lead({
            // organization: orgId, // COMMENTED: For organization-wide sharing later
            createdBy: userId,
            firstName,
            lastName,
            email,
            senderName,
            senderEmail: email,
            subject,
            body: body.substring(0, 500), // Limit to 500 chars
            threadId: details.data.threadId,
            messageId: message.id,
            source: 'Gmail Inquiry',
            status: 'New',
            isRead: false,
            vehicle: {
              year: '',
              make: '',
              model: ''
            }
          });

          await newLead.save();
          syncedCount++;
          console.log(`[SYNC] Created lead from email: ${email}`);

          await AuditLog.create({
            entityType: 'Lead',
            entityId: newLead._id,
            action: 'CREATE',
            reason: 'New Lead via Gmail Sync',
            performedBy: user._id,
            changes: { email, subject }
          });
        }
      } catch (error) {
        console.error(`[SYNC] Error processing message ${message.id}:`, error);
        errors.push(`Message ${message.id}: Processing failed`);
      }
    }

    res.json(
      new ApiResponse(200, { syncedCount, totalFound: messages.length, errors: errors.length > 0 ? errors : undefined }, `Gmail sync completed. ${syncedCount} new inquiries added.`)
    );
  } catch (error: any) {
    console.error('[SYNC] Unhandled error in sync:', error);
    throw error;
  }
});

export const setAppointmentForLead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { date, time, notes, locationOrVehicle } = req.body;
  const userId = (req.user as IUser)._id;

  const lead = await Lead.findOneAndUpdate(
    { _id: id, createdBy: userId },
    {
      status: 'Appointment Set',
      appointment: {
        date: new Date(date),
        time,
        notes: notes || '',
        location: locationOrVehicle || ''
      }
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
    changes: { status: 'Appointment Set', appointment: { date, time, notes, locationOrVehicle } }
  });

  res.json(new ApiResponse(200, lead, 'Appointment saved successfully'));
});

export const getThreadMessages = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req.user as IUser)._id;

  const lead = await Lead.findOne({ _id: id, createdBy: userId });

  if (!lead || !lead.threadId) {
    return res.status(404).json(new ApiResponse(404, null, 'Lead or thread not found'));
  }

  try {
    const user = await User.findById(userId)
      .select('+googleCalendar.accessToken +googleCalendar.refreshToken +googleCalendar.expiryDate');

    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      return res.status(400).json(new ApiResponse(400, null, 'Gmail not connected'));
    }

    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: user.googleCalendar.accessToken,
      refresh_token: user.googleCalendar.refreshToken,
      expiry_date: user.googleCalendar.expiryDate
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const threadData = await gmail.users.threads.get({
      userId: 'me',
      id: lead.threadId,
      format: 'full'
    });

    const messages = (threadData.data.messages || [])
      .filter((msg: any) => msg.id !== lead.messageId)
      .map((msg: any) => {
        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

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
          isOwn: email === user.email
        };
      });

    res.json(new ApiResponse(200, { messages }, 'Thread messages fetched'));
  } catch (error: any) {
    console.error('[THREAD] Error fetching thread messages:', error);
    res.status(400).json(new ApiResponse(400, null, 'Failed to fetch thread messages'));
  }
});