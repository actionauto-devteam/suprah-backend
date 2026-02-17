// Controller for handling ADF XML data and Leads
import { Request, Response } from 'express';
import Lead from '../models/lead.model';
import { parseStringPromise } from 'xml2js';
import User, { IUser } from '../models/User.model';
import { google } from 'googleapis';

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
    
    res.status(200).send('Lead processed successfully');
  } catch (error) {
    console.error('Error processing ADF:', error);
    res.status(500).send('Internal Server Error');
  }
};

// Get all leads for the frontend sidebar
export const getAllLeads = async (req: Request, res: Response) => {
  try {
    const leads = await Lead.find().sort({ createdAt: -1 });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching leads' });
  }
};

// Update lead status
export const updateLead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const lead = await Lead.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: 'Error updating lead' });
  }
};

// Create a new inquiry (manual/test entry)
export const createInquiry = async (req: Request, res: Response) => {
  try {
    console.log('[DEBUG] createInquiry called with body:', req.body);
    
    const { firstName, lastName, email, phone, vehicle, comments, source } = req.body;

    // Validate required fields
    if (!firstName || !email || !phone) {
      console.log('[DEBUG] Missing required fields:', { firstName, email, phone });
      return res.status(400).json({ 
        message: 'Missing required fields: firstName, email, phone',
        received: { firstName, email, phone }
      });
    }

    const newLead = new Lead({
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

// Mark lead as read
export const markAsRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findByIdAndUpdate(
      id,
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

// Mark lead as pending
export const markAsPending = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findByIdAndUpdate(
      id,
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

// Reply to an inquiry (send email)
export const replyToInquiry = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ message: 'Reply message is required' });
    }

    const lead = await Lead.findByIdAndUpdate(
      id,
      { 
        status: 'Contacted',
        isRead: true,
      },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ message: 'Inquiry not found' });
    }

    // Future: Send email via Gmail service
    console.log(`[DEBUG] Reply sent to ${lead.email}: ${message}`);

    res.json({
      success: true,
      message: 'Reply sent successfully',
      data: lead
    });
  } catch (error) {
    console.error('[ERROR] Error replying to inquiry:', error);
    res.status(500).json({ message: 'Error sending reply' });
  }
};

// Sync inquiries from Gmail
export const syncGmailInquiries = async (req: Request, res: Response) => {
  try {
    const userId = (req.user as IUser)?._id.toString();
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Get user with Gmail tokens
    const user = await User.findById(userId)
      .select('+googleCalendar.accessToken +googleCalendar.refreshToken +googleCalendar.expiryDate');

    if (!user?.googleCalendar?.connected || !user.googleCalendar.accessToken) {
      return res.status(400).json({ 
        message: 'Gmail not connected. Please connect your Google account first.',
        synced: false 
      });
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

    // Fetch emails (limit to inbox, unseen and unprocessed)
    console.log('[SYNC] Fetching emails from Gmail...');
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread', // Get unread emails as inquiries
      maxResults: 50
    });

    const messages = response.data.messages || [];
    console.log(`[SYNC] Found ${messages.length} unread emails`);

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

        // Check if this email already exists as a lead
        const existingLead = await Lead.findOne({ email });
        if (!existingLead) {
          // Extract name from sender (e.g., "John Doe <john@email.com>" → "John Doe")
          const nameParts = senderName.split(' ').filter(p => p.length > 0);
          const firstName = nameParts[0] || email.split('@')[0];
          const lastName = nameParts.slice(1).join(' ') || '';

          // Create new lead from email
          const newLead = new Lead({
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
        }
      } catch (error) {
        console.error(`[SYNC] Error processing message ${message.id}:`, error);
        errors.push(`Message ${message.id}: Processing failed`);
      }
    }

    res.json({
      success: true,
      message: `Gmail sync completed. ${syncedCount} new inquiries added.`,
      synced: true,
      syncedCount,
      totalFound: messages.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: any) {
    console.error('[SYNC] Error syncing Gmail inquiries:', error);
    res.status(500).json({ 
      message: 'Error syncing Gmail inquiries',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      synced: false
    });
  }
};