import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import { IUser } from '../models/User.model';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip HTML tags and decode entities for clean TTS reading */
function cleanForSpeech(html: string): string {
  if (!html) return '';
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/<\/p>/gi, '. ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a natural-sounding TTS script from a lead/message */
function buildSpeechScript(lead: any): string {
  const parts: string[] = [];

  const sender = lead.senderName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Unknown sender';
  parts.push(`Message from ${sender}.`);

  if (lead.subject) {
    parts.push(`Subject: ${lead.subject}.`);
  }

  const body = cleanForSpeech(lead.body || '');
  if (body) {
    // Truncate very long messages for TTS
    const truncated = body.length > 800 ? body.substring(0, 800) + '... Message truncated.' : body;
    parts.push(truncated);
  }

  if (lead.appointment) {
    const apptDate = lead.appointment.date
      ? new Date(lead.appointment.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : '';
    if (apptDate) {
      parts.push(`Appointment scheduled for ${apptDate} at ${lead.appointment.time || 'unspecified time'}.`);
    }
  }

  return parts.join(' ');
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * Prepare a lead message for TTS reading
 * GET /api/supraleo/prepare-message/:leadId
 *
 * Returns the speech script, lead metadata, and reply context
 * so the frontend can read it aloud and know where to send replies.
 */
const prepareMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id;
  const { leadId } = req.params;

  if (!leadId) {
    throw new ApiError(400, 'Lead ID is required');
  }

  const lead = await Lead.findOne({ _id: leadId, createdBy: userId });

  if (!lead) {
    throw new ApiError(404, 'Lead not found');
  }

  const speechScript = buildSpeechScript(lead);

  const result = {
    leadId: lead._id.toString(),
    speechScript,
    sender: {
      name: lead.senderName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
      email: lead.senderEmail || lead.email,
    },
    subject: lead.subject || '(No subject)',
    status: lead.status,
    hasThread: !!lead.threadId,
    canReply: lead.status !== 'Closed',
    snippet: cleanForSpeech(lead.body || '').substring(0, 200),
    receivedAt: lead.createdAt,
  };

  res.json(new ApiResponse(200, result, 'Message prepared for speech'));
});

/**
 * Prepare a thread message for TTS reading
 * POST /api/supraleo/prepare-thread-message
 *
 * For reading individual thread messages (not the lead itself).
 * Accepts the message content directly since thread messages
 * are fetched from Gmail on-the-fly.
 */
const prepareThreadMessage = asyncHandler(async (req: Request, res: Response) => {
  const { sender, message, subject } = req.body;

  if (!message) {
    throw new ApiError(400, 'Message content is required');
  }

  const cleanMessage = cleanForSpeech(message);
  const parts: string[] = [];

  if (sender) {
    parts.push(`Message from ${sender}.`);
  }
  if (subject) {
    parts.push(`Subject: ${subject}.`);
  }

  const truncated = cleanMessage.length > 800
    ? cleanMessage.substring(0, 800) + '... Message truncated.'
    : cleanMessage;
  parts.push(truncated);

  res.json(new ApiResponse(200, {
    speechScript: parts.join(' '),
    snippet: cleanMessage.substring(0, 200),
  }, 'Thread message prepared for speech'));
});

/**
 * Get Supra Leo AI status / capabilities
 * GET /api/supraleo/status
 *
 * Returns what features are available for the current user.
 * This endpoint can be extended as more AI features are added.
 */
const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id;

  // Count user's leads for context
  const leadCount = await Lead.countDocuments({ createdBy: userId });
  const unreadCount = await Lead.countDocuments({ createdBy: userId, isRead: false });

  res.json(new ApiResponse(200, {
    version: '1.0.0',
    features: {
      messageReading: true,
      voiceReply: true,
      voiceCommands: true,
      // Future features (placeholders)
      crmNavigation: false,
      appointmentCreation: false,
      vehicleLookup: false,
      reportGeneration: false,
    },
    context: {
      totalLeads: leadCount,
      unreadLeads: unreadCount,
    },
    ttsEngine: 'web-speech-api',
    sttEngine: 'web-speech-api',
  }, 'Supra Leo AI status'));
});

export default {
  prepareMessage,
  prepareThreadMessage,
  getStatus,
};