import { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import { IUser } from '../models/User.model';
import SupraLeoChat from '../models/SupraLeoChat.model';
import CrmUser from '../models/CrmUser.model';
import TimeLog from '../models/TimeLog.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import Feed from '../models/Feed.model';
import FeedComment from '../models/FeedComment.model';
import Appointment from '../models/Appointment.model';

// ─── Anthropic client ────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

// ─── System prompt builder ───────────────────────────────────────────────────

function buildSystemPrompt(module: string, contextData: any, user: any): string {
  const baseIdentity = `You are Supra Leo, the intelligent AI assistant embedded in the Action Auto CRM system. You are sharp, warm, confident, and deeply knowledgeable about automotive sales, lead management, and CRM workflows. You always address the user respectfully and helpfully.

Current user: ${user?.fullName || 'Agent'} (Role: ${user?.role || 'employee'})
Current module context: ${module}
Current time: ${new Date().toLocaleString()}`;

  const moduleInstructions: Record<string, string> = {
    appointments: `
You are assisting with the Appointments & Leads module.
Available data context: ${JSON.stringify(contextData, null, 2)}

You can help with:
- Summarizing upcoming appointments and leads
- Reading and analyzing lead messages
- Suggesting follow-up strategies for leads
- Drafting professional reply emails to customers
- Identifying scheduling conflicts
- Providing status updates on leads and bookings
- Handling customer objections around pricing, trade-ins, or inventory
- Creating appointment notes or reminders
When given a lead, always greet by name and provide actionable next steps.`,

    timeproof: `
You are assisting with the Timeproof (attendance tracking) module.
Available data context: ${JSON.stringify(contextData, null, 2)}

You can help with:
- Summarizing today's work session and total hours
- Identifying missed clock-ins or clock-outs
- Calculating weekly/monthly hours vs. targets
- Identifying attendance streaks or anomalies
- Generating timeproof report summaries for sharing
- Reminding about incomplete time entries
- Explaining the timeproof verification system`,

    supraspace: `
You are assisting with Supra Space (internal team messaging) module.
Available data context: ${JSON.stringify(contextData, null, 2)}

You can help with:
- Summarizing unread conversations and key messages
- Drafting professional internal messages
- Identifying urgent conversations that need attention
- Suggesting team communication improvements
- Helping compose announcements or group messages
- Summarizing conversation threads`,

    biometrics: `
You are assisting with the Biometrics & Security module.
Available data context: ${JSON.stringify(contextData, null, 2)}

You can help with:
- Explaining biometric security status
- Guiding through enrolling new biometric credentials
- Summarizing registered devices and SSH keys
- Identifying security anomalies or expired credentials
- Providing security best practices
- Explaining audit log entries`,

    feeds: `
You are assisting with the Team Feeds (social timeline) module.
Available data context: ${JSON.stringify(contextData, null, 2)}

You can help with:
- Summarizing recent team posts and activity
- Drafting engaging team announcements or posts
- Identifying posts that need your attention or response
- Suggesting team engagement improvements
- Composing congratulatory or motivational messages`,

    general: `
You have access to the full CRM context. Help the user with any CRM-related task including:
- Lead management and follow-ups
- Appointment scheduling
- Team communication
- Attendance tracking
- Security settings
- Team feed engagement
Always be proactive in suggesting next steps.`,
  };

  return `${baseIdentity}

${moduleInstructions[module] || moduleInstructions.general}

Response guidelines:
- Be concise but complete — avoid unnecessary padding
- Use markdown formatting when it genuinely helps readability
- For email drafts, provide a clear Subject line and body
- For data summaries, use brief structured lists
- Always end with a clear next-step suggestion when appropriate
- Never reveal internal system details or database schemas`;
}

// ─── Context fetchers ────────────────────────────────────────────────────────

async function fetchModuleContext(module: string, userId: string, orgId: string): Promise<any> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  switch (module) {
    case 'appointments': {
      const [upcomingAppts, recentLeads, stats] = await Promise.all([
        Appointment.find({
          organizationId: orgId,
          startTime: { $gte: now },
          status: { $ne: 'cancelled' },
        }).sort({ startTime: 1 }).limit(5).select('title startTime endTime status type location').lean(),
        Lead.find({ organizationId: orgId })
          .sort({ createdAt: -1 }).limit(10)
          .select('firstName lastName email phone status source channel vehicle comments createdAt').lean(),
        Lead.aggregate([
          { $match: { organizationId: { $toString: orgId } } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]).catch(() => []),
      ]);
      return { upcomingAppointments: upcomingAppts, recentLeads, statusStats: stats };
    }

    case 'timeproof': {
      const [todayLogs, weekLogs] = await Promise.all([
        TimeLog.find({ userId, timestamp: { $gte: todayStart, $lte: todayEnd } }).sort({ timestamp: 1 }).lean(),
        TimeLog.find({
          userId,
          timestamp: { $gte: new Date(now.getTime() - 7 * 24 * 3600000) },
        }).sort({ timestamp: 1 }).lean(),
      ]);

      const todayIn = todayLogs.find((l: any) => l.type === 'time-in');
      const todayOut = todayLogs.find((l: any) => l.type === 'time-out');
      const workedMs = todayIn && todayOut
        ? new Date(todayOut.timestamp).getTime() - new Date(todayIn.timestamp).getTime()
        : todayIn
        ? now.getTime() - new Date(todayIn.timestamp).getTime()
        : 0;

      return {
        today: {
          clockedIn: !!todayIn,
          clockedOut: !!todayOut,
          timeIn: todayIn?.timestamp || null,
          timeOut: todayOut?.timestamp || null,
          workedHours: (workedMs / 3600000).toFixed(2),
        },
        weekLogsCount: weekLogs.length,
      };
    }

    case 'supraspace': {
      const conversations = await SupraSpaceConversation.find({
        members: userId,
        isActive: true,
      }).sort({ lastMessageAt: -1 }).limit(10)
        .populate('members', 'fullName username')
        .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'fullName' } })
        .lean();

      // Count unread
      const unreadCount = await SupraSpaceMessage.countDocuments({
        conversationId: { $in: conversations.map((c: any) => c._id) },
        readBy: { $ne: userId },
        isDeleted: false,
      });

      return { conversations: conversations.slice(0, 5), unreadCount };
    }

    case 'biometrics': {
      // Return basic user security info (no sensitive credentials)
      const user = await CrmUser.findById(userId).select('fullName username lastLoginAt').lean();
      return { user, message: 'Biometric credentials are managed client-side via WebAuthn.' };
    }

    case 'feeds': {
      const [recentPosts, recentComments] = await Promise.all([
        Feed.find({ organizationId: orgId, deletedAt: null })
          .sort({ createdAt: -1 }).limit(10)
          .select('authorName authorRole content isEdited createdAt').lean(),
        FeedComment.find({ organizationId: orgId, deletedAt: null })
          .sort({ createdAt: -1 }).limit(5)
          .select('authorName content postId createdAt').lean(),
      ]);
      return { recentPosts, recentComments };
    }

    default:
      return {};
  }
}

// ─── Reminder fetchers ───────────────────────────────────────────────────────

async function fetchReminders(module: string, userId: string, orgId: string): Promise<any> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekEnd = new Date(now.getTime() + 7 * 24 * 3600000);

  switch (module) {
    case 'appointments': {
      const [todayAppts, upcomingAppts, newLeads, pendingLeads] = await Promise.all([
        Appointment.find({
          organizationId: orgId,
          startTime: { $gte: todayStart, $lte: todayEnd },
          status: { $ne: 'cancelled' },
        }).sort({ startTime: 1 }).select('title startTime endTime status type location guestEmails').lean(),
        Appointment.find({
          organizationId: orgId,
          startTime: { $gt: todayEnd, $lte: weekEnd },
          status: { $ne: 'cancelled' },
        }).sort({ startTime: 1 }).limit(10).select('title startTime status type').lean(),
        Lead.find({ organizationId: orgId, status: 'New' })
          .sort({ createdAt: -1 }).limit(10)
          .select('firstName lastName email status source channel createdAt').lean(),
        Lead.find({ organizationId: orgId, status: 'Pending' })
          .sort({ createdAt: -1 }).limit(5)
          .select('firstName lastName email status createdAt').lean(),
      ]);
      return {
        module: 'appointments',
        today: todayAppts,
        upcoming: upcomingAppts,
        newLeads,
        pendingLeads,
        counts: {
          todayAppointments: todayAppts.length,
          upcomingThisWeek: upcomingAppts.length,
          newLeads: newLeads.length,
          pendingLeads: pendingLeads.length,
        },
      };
    }

    case 'timeproof': {
      const todayLogs = await TimeLog.find({
        userId,
        timestamp: { $gte: todayStart, $lte: todayEnd },
      }).sort({ timestamp: 1 }).lean();

      const hasClockedIn = todayLogs.some((l: any) => l.type === 'time-in');
      const hasClockedOut = todayLogs.some((l: any) => l.type === 'time-out');
      const isLive = hasClockedIn && !hasClockedOut;

      const weekLogs = await TimeLog.find({
        userId,
        timestamp: { $gte: new Date(now.getTime() - 7 * 24 * 3600000) },
      }).lean();

      return {
        module: 'timeproof',
        today: {
          hasClockedIn,
          hasClockedOut,
          isLive,
          logs: todayLogs,
        },
        alerts: [
          ...(!hasClockedIn && now.getHours() >= 8 ? [{ type: 'warning', message: 'You have not clocked in today.' }] : []),
          ...(isLive && now.getHours() >= 18 ? [{ type: 'info', message: 'You have been clocked in for a long time. Consider clocking out.' }] : []),
        ],
        weekLogsCount: weekLogs.length,
      };
    }

    case 'supraspace': {
      const conversations = await SupraSpaceConversation.find({
        members: userId,
        isActive: true,
      }).lean();

      const convIds = conversations.map((c: any) => c._id);
      const [unreadMsgs, recentMsgs] = await Promise.all([
        SupraSpaceMessage.find({
          conversationId: { $in: convIds },
          readBy: { $ne: userId },
          isDeleted: false,
          createdAt: { $gte: new Date(now.getTime() - 24 * 3600000) },
        }).sort({ createdAt: -1 }).limit(20)
          .populate('sender', 'fullName')
          .populate('conversationId', 'name type')
          .lean(),
        SupraSpaceMessage.find({
          conversationId: { $in: convIds },
          isDeleted: false,
          createdAt: { $gte: new Date(now.getTime() - 3600000) },
        }).sort({ createdAt: -1 }).limit(5)
          .populate('sender', 'fullName').lean(),
      ]);

      return {
        module: 'supraspace',
        unreadMessages: unreadMsgs,
        recentMessages: recentMsgs,
        counts: {
          unread: unreadMsgs.length,
          activeConversations: conversations.length,
        },
      };
    }

    case 'biometrics': {
      return {
        module: 'biometrics',
        alerts: [
          { type: 'info', message: 'Manage your enrolled biometric credentials and SSH keys in the Biometrics module.' },
        ],
        counts: { credentialsEnrolled: 0 },
      };
    }

    case 'feeds': {
      const [newPosts, newComments] = await Promise.all([
        Feed.find({
          organizationId: orgId,
          deletedAt: null,
          createdAt: { $gte: new Date(now.getTime() - 24 * 3600000) },
        }).sort({ createdAt: -1 }).limit(10)
          .select('authorName authorRole content createdAt').lean(),
        FeedComment.find({
          organizationId: orgId,
          deletedAt: null,
          createdAt: { $gte: new Date(now.getTime() - 24 * 3600000) },
        }).sort({ createdAt: -1 }).limit(10)
          .select('authorName content postId createdAt').lean(),
      ]);

      return {
        module: 'feeds',
        newPosts,
        newComments,
        counts: {
          newPostsToday: newPosts.length,
          newCommentsToday: newComments.length,
        },
      };
    }

    default:
      return { module, message: 'No reminders available for this module.' };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanForSpeech(html: string): string {
  if (!html) return '';
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/<\/p>/gi, '. ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function buildSpeechScript(lead: any): string {
  const parts: string[] = [];
  const sender = lead.senderName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Unknown sender';
  parts.push(`Message from ${sender}.`);
  if (lead.subject) parts.push(`Subject: ${lead.subject}.`);
  const body = cleanForSpeech(lead.body || '');
  if (body) {
    parts.push(body.length > 800 ? body.substring(0, 800) + '... Message truncated.' : body);
  }
  if (lead.appointment) {
    const apptDate = lead.appointment.date
      ? new Date(lead.appointment.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : '';
    if (apptDate) parts.push(`Appointment scheduled for ${apptDate} at ${lead.appointment.time || 'unspecified time'}.`);
  }
  return parts.join(' ');
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /api/supraleo/chat
 * Streaming AI chat with persistent history
 */
export const chat = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { message, module = 'general', context: clientContext, stream = false } = req.body;

  if (!message?.trim()) throw new ApiError(400, 'Message is required');
  if (!process.env.ANTHROPIC_API_KEY) throw new ApiError(500, 'AI service not configured');

  // Get or create chat document for this user
  let chatDoc = await SupraLeoChat.findOne({ userId: user._id });
  if (!chatDoc) {
    chatDoc = await SupraLeoChat.create({
      userId: user._id,
      organizationId: user.organizationId,
      messages: [],
    });
  }

  // Fetch module context
  const moduleContext = await fetchModuleContext(module, user._id.toString(), user.organizationId?.toString() || '');
  const mergedContext = { ...moduleContext, ...clientContext };

  // Build message history (last 30 messages for context window)
  const recentMessages = chatDoc.messages.slice(-30).map((m: any) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Append new user message
  recentMessages.push({ role: 'user', content: message.trim() });

  const systemPrompt = buildSystemPrompt(module, mergedContext, user);

  if (stream) {
    // ── Streaming response ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let fullResponse = '';

    try {
      const stream = anthropic.messages.stream({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: recentMessages,
      });

      for await (const event of stream) {
        console.log('Event:', event.type);
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullResponse += event.delta.text;
          res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
        }
      }

      // Persist to database
      chatDoc.messages.push({ role: 'user', content: message.trim(), module: module as any, context: mergedContext, createdAt: new Date() });
      chatDoc.messages.push({ role: 'assistant', content: fullResponse, module: module as any, createdAt: new Date() });

      // Cap history at 200 messages
     if (chatDoc.messages.length > 200) {
  chatDoc.messages.splice(0, chatDoc.messages.length - 200);
}
      await chatDoc.save();

      res.write(`data: ${JSON.stringify({ type: 'done', messageId: chatDoc.messages[chatDoc.messages.length - 1]._id })}\n\n`);
      res.end();
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  } else {
    // ── Non-streaming response ──
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: recentMessages,
    });

    const assistantText = response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    // Persist
    chatDoc.messages.push({ role: 'user', content: message.trim(), module: module as any, context: mergedContext, createdAt: new Date() });
    chatDoc.messages.push({ role: 'assistant', content: assistantText, module: module as any, createdAt: new Date() });
    if (chatDoc.messages.length > 200) chatDoc.messages.splice(0, chatDoc.messages.length - 200);
    await chatDoc.save();

    res.json(new ApiResponse(200, {
      message: assistantText,
      messageId: chatDoc.messages[chatDoc.messages.length - 1]._id,
      module,
    }, 'Response generated'));
  }
});

/**
 * GET /api/supraleo/chat/history
 * Paginated chat history for the full-screen view
 */
export const getChatHistory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { page = '1', limit = '50', module } = req.query;

  const chatDoc = await SupraLeoChat.findOne({ userId: user._id });
  if (!chatDoc) {
    return res.json(new ApiResponse(200, { messages: [], total: 0, hasMore: false }, 'No history'));
  }

const allMessages = chatDoc.messages.toObject ? chatDoc.messages.toObject() : [...chatDoc.messages];
const messages = (module && module !== 'all')
  ? allMessages.filter((m: any) => m.module === module || !m.module || m.module === 'general')
  : allMessages;

  const total = messages.length;
  const pageNum = parseInt(page as string);
  const limitNum = parseInt(limit as string);
  const start = Math.max(0, total - pageNum * limitNum);
  const end = total - (pageNum - 1) * limitNum;
  const paginated = messages.slice(start, end).reverse();

  res.json(new ApiResponse(200, {
    messages: paginated,
    total,
    hasMore: start > 0,
    page: pageNum,
  }, 'History fetched'));
});

/**
 * DELETE /api/supraleo/chat/history
 * Clear all chat history for the current user
 */
export const clearChatHistory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  await SupraLeoChat.findOneAndUpdate(
    { userId: user._id },
    { messages: [], messageCount: 0, lastActivityAt: new Date() }
  );
  res.json(new ApiResponse(200, null, 'Chat history cleared'));
});

/**
 * GET /api/supraleo/reminders/:module
 * Fetch module-specific reminder data
 */
export const getReminders = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { module } = req.params;

  const validModules = ['appointments', 'timeproof', 'supraspace', 'biometrics', 'feeds'];
  if (!validModules.includes(module)) {
    throw new ApiError(400, `Invalid module. Valid: ${validModules.join(', ')}`);
  }

  const data = await fetchReminders(module, user._id.toString(), user.organizationId?.toString() || '');
  res.json(new ApiResponse(200, data, `Reminders for ${module} fetched`));
});

/**
 * GET /api/supraleo/context/:module
 * Fetch rich module context (used by frontend to inject into AI)
 */
export const getModuleContext = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { module } = req.params;

  const data = await fetchModuleContext(module, user._id.toString(), user.organizationId?.toString() || '');
  res.json(new ApiResponse(200, { module, data }, 'Module context fetched'));
});

/**
 * GET /api/supraleo/prepare-message/:leadId
 * TTS prep for a lead message
 */
export const prepareMessage = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { leadId } = req.params;

  if (!leadId) throw new ApiError(400, 'Lead ID is required');

  const lead = await Lead.findOne({ _id: leadId, organizationId: user.organizationId });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const speechScript = buildSpeechScript(lead);

  res.json(new ApiResponse(200, {
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
  }, 'Message prepared for speech'));
});

/**
 * POST /api/supraleo/prepare-thread-message
 * TTS prep for a thread message
 */
export const prepareThreadMessage = asyncHandler(async (req: Request, res: Response) => {
  const { sender, message, subject } = req.body;

  if (!message) throw new ApiError(400, 'Message content is required');

  const cleanMessage = cleanForSpeech(message);
  const parts: string[] = [];
  if (sender) parts.push(`Message from ${sender}.`);
  if (subject) parts.push(`Subject: ${subject}.`);
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
 * GET /api/supraleo/status
 * Capabilities and context summary
 */
export const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;

  const [leadCount, unreadCount, chatDoc] = await Promise.all([
    Lead.countDocuments({ organizationId: user.organizationId }),
    Lead.countDocuments({ organizationId: user.organizationId, isRead: false }),
    SupraLeoChat.findOne({ userId: user._id }).select('messageCount lastActivityAt'),
  ]);

  res.json(new ApiResponse(200, {
    version: '2.0.0',
    features: {
      messageReading: true,
      voiceReply: true,
      voiceCommands: true,
      persistentChat: true,
      fullScreenChat: true,
      moduleReminders: true,
      crmNavigation: true,
      appointmentSummary: true,
      leadAnalysis: true,
      teamFeedSummary: true,
      timeprofSummary: true,
    },
    context: {
      totalLeads: leadCount,
      unreadLeads: unreadCount,
      chatMessages: chatDoc?.messageCount || 0,
      lastChatActivity: chatDoc?.lastActivityAt || null,
    },
    ttsEngine: 'web-speech-api',
    sttEngine: 'web-speech-api',
    aiModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  }, 'Supra Leo AI status'));
});

export default {
  chat,
  getChatHistory,
  clearChatHistory,
  getReminders,
  getModuleContext,
  prepareMessage,
  prepareThreadMessage,
  getStatus,
};