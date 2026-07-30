import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import YapLineSession from '../models/YapLineSession.model';
import { getActiveYapSessions } from '../socket/yapline.socket';

/**
 * Suprah YapLine — REST surface.
 *
 * Realtime state (join/leave/speak/screen/signaling) lives entirely on the
 * SupraSpace socket. These endpoints exist for initial paint: the Dashboard
 * widget, the YapLine page, and the store's cold-start hydration all read
 * from here before the socket takes over.
 *
 * Everything is filtered to conversations the requesting CRM user is a
 * member of — the same visibility boundary as SupraSpace itself.
 */

/** Conversation ids (as strings) the user belongs to, optionally limited to a set. */
async function memberConversationIds(userId: any, limitTo?: string[]): Promise<Set<string>> {
  const filter: any = {
    members: userId,
    isActive: true,
    deletedFor: { $ne: userId },
    'metadata.type': { $nin: ['customer_concern', 'customer_call'] },
  };
  if (limitTo) filter._id = { $in: limitTo };
  const convs = await SupraSpaceConversation.find(filter).select('_id').lean();
  return new Set(convs.map((c: any) => c._id.toString()));
}

/** GET /api/crm/yapline/sessions — live sessions visible to this user */
const getActiveSessions = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const live = getActiveYapSessions();

  if (!live.length) {
    return res.json(new ApiResponse(200, [], 'Active YapLine sessions'));
  }

  const allowed = await memberConversationIds(userId, live.map((s) => s.conversationId));
  const visible = live.filter((s) => allowed.has(s.conversationId));

  res.json(new ApiResponse(200, visible, 'Active YapLine sessions'));
});

/** GET /api/crm/yapline/recent?limit= — recent session history + voice activity */
const getRecentActivity = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const limit = Math.min(parseInt((req.query.limit as string) || '10', 10) || 10, 30);

  const allowed = await memberConversationIds(userId);
  if (!allowed.size) {
    return res.json(new ApiResponse(200, [], 'Recent YapLine activity'));
  }

  const docs = await YapLineSession.find({
    conversationId: { $in: [...allowed] },
  })
    .sort({ startedAt: -1 })
    .limit(limit)
    .populate('startedBy', 'fullName username avatar')
    .lean();

  const items = docs.map((d: any) => ({
    _id: d._id,
    conversationId: d.conversationId,
    conversationName: d.conversationName,
    startedBy: d.startedBy,
    startedAt: d.startedAt,
    endedAt: d.endedAt,
    isActive: d.isActive,
    peakParticipants: d.peakParticipants,
    // Newest activity first, trimmed for the widget.
    activity: (d.activity || []).slice(-8).reverse(),
  }));

  res.json(new ApiResponse(200, items, 'Recent YapLine activity'));
});

const yapLineController = {
  getActiveSessions,
  getRecentActivity,
};

export default yapLineController;