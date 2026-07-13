import { Request, Response } from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import fs from 'fs';
import os from 'os';
import path from 'path';
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


const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || '',
  baseURL: 'https://api.groq.com/openai/v1',
});


function buildSystemPrompt(module: string, contextData: any, user: any): string {
  const baseIdentity = `You are Suprah Autrix, the intelligent AI assistant embedded in the Action Auto CRM system. You are sharp, warm, confident, and deeply knowledgeable about automotive sales, lead management, and CRM workflows. You always address the user respectfully and helpfully.

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
You are assisting with Suprah Space (internal team messaging) module.
Available data context: ${JSON.stringify(contextData, null, 2)}

You can help with:
- Summarizing unread conversations and key messages
- Summarizing a conversation over a chosen date range
- Drafting professional internal messages and quick replies
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

      const unreadCount = await SupraSpaceMessage.countDocuments({
        conversationId: { $in: conversations.map((c: any) => c._id) },
        readBy: { $ne: userId },
        isDeleted: false,
      });

      return { conversations: conversations.slice(0, 5), unreadCount };
    }

    case 'biometrics': {
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
        today: { hasClockedIn, hasClockedOut, isLive, logs: todayLogs },
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
        counts: { unread: unreadMsgs.length, activeConversations: conversations.length },
      };
    }

    case 'biometrics': {
      return {
        module: 'biometrics',
        alerts: [{ type: 'info', message: 'Manage your enrolled biometric credentials and SSH keys in the Biometrics module.' }],
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
        counts: { newPostsToday: newPosts.length, newCommentsToday: newComments.length },
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
  if (body) parts.push(body.length > 800 ? body.substring(0, 800) + '... Message truncated.' : body);
  if (lead.appointment) {
    const apptDate = lead.appointment.date
      ? new Date(lead.appointment.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : '';
    if (apptDate) parts.push(`Appointment scheduled for ${apptDate} at ${lead.appointment.time || 'unspecified time'}.`);
  }
  return parts.join(' ');
}

// Builds a plain-text transcript of Suprah Space messages for the AI
function buildTranscript(messages: any[]): string {
  return messages
    .map((m: any) => {
      const who = m.sender?.fullName || 'User';
      const when = new Date(m.createdAt).toLocaleString();
      let body = m.content || '';
      if (!body) {
        if (m.type === 'poll' && m.poll) body = `[Poll] ${m.poll.question}`;
        else if (m.type === 'event' && m.event) body = `[Event] ${m.event.title}`;
        else if (m.type === 'voice') body = '[Voice message]';
        else if (m.type === 'gif') body = '[GIF]';
        else if (m.attachments?.length) body = `[${m.attachments.length} attachment(s)]`;
      }
      return `[${when}] ${who}: ${body}`;
    })
    .join('\n');
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/** POST /api/supraleo/chat */
export const chat = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { message, module = 'general', context: clientContext, stream = false } = req.body;

  if (!message?.trim()) throw new ApiError(400, 'Message is required');
  if (!process.env.GEMINI_API_KEY) throw new ApiError(500, 'AI service not configured');

  let chatDoc = await SupraLeoChat.findOne({ userId: user._id });
  if (!chatDoc) {
    chatDoc = await SupraLeoChat.create({ userId: user._id, organizationId: user.organizationId, messages: [] });
  }

  const moduleContext = await fetchModuleContext(module, user._id.toString(), user.organizationId?.toString() || '');
  const mergedContext = { ...moduleContext, ...clientContext };

  const recentMessages = chatDoc.messages.slice(-30).map((m: any) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  recentMessages.push({ role: 'user', content: message.trim() });

  const systemPrompt = buildSystemPrompt(module, mergedContext, user);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (!process.env.GEMINI_API_KEY) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'AI service not configured' })}\n\n`);
      res.end();
      return;
    }
    let fullResponse = '';
    try {
      const streamResponse = await gemini.chat.completions.create({
        model: GEMINI_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
        stream: true,
      });

      for await (const chunk of streamResponse) {
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          fullResponse += text;
          res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
        }
      }

      chatDoc.messages.push({ role: 'user', content: message.trim(), module: module as any, context: mergedContext, createdAt: new Date() });
      chatDoc.messages.push({ role: 'assistant', content: fullResponse, module: module as any, createdAt: new Date() });
      if (chatDoc.messages.length > 200) chatDoc.messages.splice(0, chatDoc.messages.length - 200);
      await chatDoc.save();

      res.write(`data: ${JSON.stringify({ type: 'done', messageId: chatDoc.messages[chatDoc.messages.length - 1]._id })}\n\n`);
      res.end();
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  } else {
    const response = await gemini.chat.completions.create({
      model: GEMINI_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
      stream: false,
    });
    const assistantText = response.choices[0]?.message?.content || '';
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
 * POST /api/supraleo/summarize
 * Summarize a Suprah Space conversation over an optional date range.
 * Body: { conversationId, from?, to? }
 */
export const summarizeConversation = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { conversationId, from, to } = req.body;

  if (!conversationId) throw new ApiError(400, 'conversationId is required');
  if (!process.env.GEMINI_API_KEY) throw new ApiError(500, 'AI service not configured');

  const conversation = await SupraSpaceConversation.findById(conversationId).lean();
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!(conversation.members || []).map(String).includes(user._id.toString())) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const filter: any = { conversationId, isDeleted: false };
  const range: any = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  if (from || to) filter.createdAt = range;

  const messages = await SupraSpaceMessage.find(filter)
    .populate('sender', 'fullName')
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();

  if (messages.length === 0) {
    return res.json(new ApiResponse(200, { summary: 'There are no messages in the selected date range to summarize.' }, 'Nothing to summarize'));
  }

  const transcript = buildTranscript(messages);
  const convName = conversation.type === 'group' ? (conversation.name || 'this channel') : 'this direct conversation';
  const rangeLabel = from || to
    ? `from ${from ? new Date(from).toLocaleDateString() : 'the beginning'} to ${to ? new Date(to).toLocaleDateString() : 'now'}`
    : 'recently';

  const sumResponse = await gemini.chat.completions.create({
    model: GEMINI_MODEL,
    max_tokens: 900,
    messages: [
      { role: 'system', content: `You are Suprah Autrix, summarizing an internal team conversation in Suprah Space. Produce a concise, well-structured summary using markdown. Include: key discussion points, decisions made, open questions, and any action items (with the responsible person if mentioned). Be factual and do not invent details.` },
      { role: 'user', content: `Summarize the conversation "${convName}" ${rangeLabel}. Here is the transcript (${messages.length} messages):\n\n${transcript.slice(0, 12000)}` },
    ],
    stream: false,
  });
  const summary = sumResponse.choices[0]?.message?.content || 'Unable to generate a summary.';
  res.json(new ApiResponse(200, {
    summary,
    conversationId,
    messageCount: messages.length,
    range: { from: from || null, to: to || null },
  }, 'Conversation summarized'));
});

/**
 * POST /api/supraleo/draft
 * Generate a suggested reply based on the latest messages in a conversation.
 * Body: { conversationId, instruction? }
 */
export const draftReply = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { conversationId, instruction } = req.body;

  if (!conversationId) throw new ApiError(400, 'conversationId is required');
  if (!process.env.GEMINI_API_KEY) throw new ApiError(500, 'AI service not configured');

  const conversation = await SupraSpaceConversation.findById(conversationId).lean();
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!(conversation.members || []).map(String).includes(user._id.toString())) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const recent = await SupraSpaceMessage.find({ conversationId, isDeleted: false })
    .populate('sender', 'fullName')
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  const transcript = buildTranscript(recent.reverse());
  const convName = conversation.type === 'group' ? (conversation.name || 'this channel') : 'this direct conversation';

  const draftResponse = await gemini.chat.completions.create({
    model: GEMINI_MODEL,
    max_tokens: 400,
    messages: [
      { role: 'system', content: `You are Suprah Autrix helping ${user.fullName} reply in the internal team chat "${convName}". Based on the latest messages, write a single, ready-to-send reply in their voice. Return ONLY the reply text — no preamble, no quotes, no explanation.${instruction ? ` Additional instruction: ${instruction}` : ''}` },
      { role: 'user', content: `Latest messages:\n${transcript || '(no messages yet)'}\n\nWrite the best next reply.` },
    ],
    stream: false,
  });
  const draft = (draftResponse.choices[0]?.message?.content || '').trim();
  res.json(new ApiResponse(200, { draft, conversationId }, 'Draft generated'));
});

/**
 * POST /api/supraleo/refine
 * Refine / rewrite a SupraSpace message draft using Gemini (free tier).
 * Body: { text }
 */
export const refineMessage = asyncHandler(async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text?.trim()) throw new ApiError(400, 'text is required');
  if (!process.env.ANTHROPIC_API_KEY) throw new ApiError(500, 'AI service not configured');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are a professional writing assistant. Improve the clarity, tone, and grammar of the message. Keep the original meaning and language (Filipino or English). Return ONLY the improved message — no preamble, no explanation, no quotes.\n\n${text.trim()}`,
    }],
  });

  const refined = response.content[0]?.type === 'text' ? response.content[0].text : '';
  res.json(new ApiResponse(200, { refined }, 'Message refined'));
});

/** GET /api/supraleo/chat/history */
export const getChatHistory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { page = '1', limit = '50', module } = req.query;

  const chatDoc = await SupraLeoChat.findOne({ userId: user._id });
  if (!chatDoc) return res.json(new ApiResponse(200, { messages: [], total: 0, hasMore: false }, 'No history'));

  const allMessages = (chatDoc.messages as any).toObject ? (chatDoc.messages as any).toObject() : [...chatDoc.messages];
  const messages = (module && module !== 'all')
    ? allMessages.filter((m: any) => m.module === module || !m.module || m.module === 'general')
    : allMessages;

  const total = messages.length;
  const pageNum = parseInt(page as string);
  const limitNum = parseInt(limit as string);
  const start = Math.max(0, total - pageNum * limitNum);
  const end = total - (pageNum - 1) * limitNum;
  const paginated = messages.slice(start, end).reverse();

  res.json(new ApiResponse(200, { messages: paginated, total, hasMore: start > 0, page: pageNum }, 'History fetched'));
});

/** DELETE /api/supraleo/chat/history */
export const clearChatHistory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  await SupraLeoChat.findOneAndUpdate(
    { userId: user._id },
    { messages: [], messageCount: 0, lastActivityAt: new Date() }
  );
  res.json(new ApiResponse(200, null, 'Chat history cleared'));
});

/** GET /api/supraleo/reminders/:module */
export const getReminders = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { module } = req.params;
  const validModules = ['appointments', 'timeproof', 'supraspace', 'biometrics', 'feeds'];
  if (!validModules.includes(module)) throw new ApiError(400, `Invalid module. Valid: ${validModules.join(', ')}`);
  const data = await fetchReminders(module, user._id.toString(), user.organizationId?.toString() || '');
  res.json(new ApiResponse(200, data, `Reminders for ${module} fetched`));
});

/** GET /api/supraleo/context/:module */
export const getModuleContext = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { module } = req.params;
  const data = await fetchModuleContext(module, user._id.toString(), user.organizationId?.toString() || '');
  res.json(new ApiResponse(200, { module, data }, 'Module context fetched'));
});

/** GET /api/supraleo/prepare-message/:leadId */
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
    sender: { name: lead.senderName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim(), email: lead.senderEmail || lead.email },
    subject: lead.subject || '(No subject)',
    status: lead.status,
    hasThread: !!lead.threadId,
    canReply: lead.status !== 'Closed',
    snippet: cleanForSpeech(lead.body || '').substring(0, 200),
    receivedAt: lead.createdAt,
  }, 'Message prepared for speech'));
});

/** POST /api/supraleo/prepare-thread-message */
export const prepareThreadMessage = asyncHandler(async (req: Request, res: Response) => {
  const { sender, message, subject } = req.body;
  if (!message) throw new ApiError(400, 'Message content is required');

  const cleanMessage = cleanForSpeech(message);
  const parts: string[] = [];
  if (sender) parts.push(`Message from ${sender}.`);
  if (subject) parts.push(`Subject: ${subject}.`);
  parts.push(cleanMessage.length > 800 ? cleanMessage.substring(0, 800) + '... Message truncated.' : cleanMessage);

  res.json(new ApiResponse(200, { speechScript: parts.join(' '), snippet: cleanMessage.substring(0, 200) }, 'Thread message prepared for speech'));
});

/**
 * POST /api/supraleo/meeting-chat
 * Autrix AI chat scoped to a live call session.
 * Body: { message, transcript?, callTitle?, stream? }
 * The transcript (accumulated STT text from the tray-app) is injected as
 * call context so Autrix can summarize or take notes on the actual conversation.
 */
export const meetingChat = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { message, transcript = '', callTitle = 'Meeting', stream = false } = req.body;

  if (!message?.trim()) throw new ApiError(400, 'Message is required');
  if (!process.env.GEMINI_API_KEY) throw new ApiError(500, 'AI service not configured');

  let chatDoc = await SupraLeoChat.findOne({ userId: user._id });
  if (!chatDoc) {
    chatDoc = await SupraLeoChat.create({ userId: user._id, organizationId: user.organizationId, messages: [] });
  }

  const transcriptSection = transcript?.trim()
    ? `\n\nLIVE CALL TRANSCRIPT (use this as context for all responses):\n"""\n${transcript.trim().slice(0, 10000)}\n"""`
    : '\n\n(No transcript available yet — the call may have just started or transcription is not running.)';

  const systemPrompt = `You are Suprah Autrix, the AI assistant for Action Auto CRM, embedded inside the tray-app during a live call or meeting.

Current user: ${user.fullName || 'Agent'} (Role: ${user.role || 'employee'})
Meeting: ${callTitle}
Current time: ${new Date().toLocaleString()}
${transcriptSection}

Your job during this call:
- Provide real-time meeting summaries when asked
- Take structured notes on key discussion points, decisions, and action items
- Answer questions based strictly on the transcript above
- If a topic was not mentioned in the transcript, say so clearly — do not invent details

Response guidelines:
- Be concise and structured — use bullet points or short paragraphs
- For summaries: cover key topics discussed, decisions made, open questions, action items (with owner if mentioned)
- For notes: format cleanly so the user can copy-paste directly
- Never reveal internal system details`;

  const recentMessages = chatDoc.messages
    .filter((m: any) => m.module === 'meeting')
    .slice(-20)
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  recentMessages.push({ role: 'user', content: message.trim() });

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let fullResponse = '';
    try {
      const streamResponse = await gemini.chat.completions.create({
        model: GEMINI_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
        stream: true,
      });

      for await (const chunk of streamResponse) {
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          fullResponse += text;
          res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
        }
      }

      chatDoc.messages.push({ role: 'user', content: message.trim(), module: 'meeting' as any, createdAt: new Date() });
      chatDoc.messages.push({ role: 'assistant', content: fullResponse, module: 'meeting' as any, createdAt: new Date() });
      if (chatDoc.messages.length > 200) chatDoc.messages.splice(0, chatDoc.messages.length - 200);
      await chatDoc.save();

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  } else {
    const response = await gemini.chat.completions.create({
      model: GEMINI_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
      stream: false,
    });
    const assistantText = response.choices[0]?.message?.content || '';
    chatDoc.messages.push({ role: 'user', content: message.trim(), module: 'meeting' as any, createdAt: new Date() });
    chatDoc.messages.push({ role: 'assistant', content: assistantText, module: 'meeting' as any, createdAt: new Date() });
    if (chatDoc.messages.length > 200) chatDoc.messages.splice(0, chatDoc.messages.length - 200);
    await chatDoc.save();

    res.json(new ApiResponse(200, { message: assistantText, module: 'meeting' }, 'Response generated'));
  }
});

/**
 * POST /api/supraleo/transcribe-chunk
 * Receives a raw audio chunk (WebM/Opus) from the tray-app and transcribes
 * it using Groq Whisper. Returns the transcript text.
 * Expects multipart/form-data with field 'audio'.
 */
export const transcribeChunk = asyncHandler(async (req: Request, res: Response) => {
  if (!process.env.GROQ_API_KEY) {
    return res.json(new ApiResponse(200, { text: '' }, 'Transcription service not configured'));
  }

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return res.json(new ApiResponse(200, { text: '' }, 'Empty chunk'));
  }

  const tmpPath = path.join(os.tmpdir(), `autrix-chunk-${Date.now()}.webm`);
  try {
    fs.writeFileSync(tmpPath, file.buffer);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath) as any,
      model: 'whisper-large-v3',
      language: 'en',
      response_format: 'text',
    });

    const text = typeof transcription === 'string' ? transcription : (transcription as any).text ?? '';
    res.json(new ApiResponse(200, { text: text.trim() }, 'Transcribed'));
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
  }
});

/** GET /api/supraleo/status */
export const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const [leadCount, unreadCount, chatDoc] = await Promise.all([
    Lead.countDocuments({ organizationId: user.organizationId }),
    Lead.countDocuments({ organizationId: user.organizationId, isRead: false }),
    SupraLeoChat.findOne({ userId: user._id }).select('messageCount lastActivityAt'),
  ]);

  res.json(new ApiResponse(200, {
    version: '2.1.0',
    name: 'Suprah Autrix',
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
      conversationSummary: true,
      draftReplies: true,
    },
    context: {
      totalLeads: leadCount,
      unreadLeads: unreadCount,
      chatMessages: chatDoc?.messageCount || 0,
      lastChatActivity: chatDoc?.lastActivityAt || null,
    },
    ttsEngine: 'web-speech-api',
    sttEngine: 'web-speech-api',
    aiModel: GEMINI_MODEL,
  }, 'Suprah Autrix AI status'));
});

export default {
  chat,
  meetingChat,
  transcribeChunk,
  summarizeConversation,
  draftReply,
  refineMessage,
  getChatHistory,
  clearChatHistory,
  getReminders,
  getModuleContext,
  prepareMessage,
  prepareThreadMessage,
  getStatus,
};