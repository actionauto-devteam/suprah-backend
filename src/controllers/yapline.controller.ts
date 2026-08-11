import { Request, Response } from 'express';
import crypto from 'crypto';
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

/* ─── ICE configuration ──────────────────────────────────────────────────────
 * Remote-team requirement: STUN alone only works when two peers can reach each
 * other directly. Home routers, mobile hotspots, corporate firewalls and
 * carrier-grade NAT all break that, which is why voice worked in the office
 * and died between houses. TURN fixes it by relaying the media through a
 * server both sides CAN reach.
 *
 * Credentials are minted here rather than baked into the bundle, because a
 * TURN secret shipped to the browser is a TURN server anyone can use for free.
 *
 * Supported setups, in priority order:
 *   1. TURN_SECRET       → coturn `use-auth-secret`. We derive ephemeral
 *                          username/password pairs (HMAC-SHA1, RFC 5766 REST)
 *                          valid for TURN_TTL seconds. Recommended.
 *   2. TURN_USERNAME/... → static long-term credentials. Simpler to stand up,
 *                          but the same pair for everyone forever.
 *   3. neither           → STUN only, with a warning in the payload so the
 *                          client can tell the user remote calls may fail.
 * ------------------------------------------------------------------------ */

const STUN_URLS = (
  process.env.STUN_URLS ||
  'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 24h by default. Long-lived on purpose: the client rotates credentials into
// live peer connections well before expiry, so a line left open all day never
// hits an expired relay mid-conversation.
const TURN_TTL = Number(process.env.TURN_TTL || 86400); // seconds

/**
 * coturn REST credentials: username is "<expiry>:<userId>", password is the
 * base64 HMAC-SHA1 of that username keyed with the shared secret. coturn
 * validates it without any per-user database.
 */
function ephemeralTurnCredentials(secret: string, userId: string) {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${expiry}:${userId}`;
  const credential = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');
  return { username, credential, expiry };
}

/** GET /api/crm/yapline/ice — ICE servers for this user's peer connections */
const getIceConfig = asyncHandler(async (req: Request, res: Response) => {
  const userId = String(req.crmUser!._id);
  const iceServers: any[] = [{ urls: STUN_URLS }];

  let ttl = TURN_TTL;
  let hasTurn = false;

  if (TURN_URLS.length) {
    if (process.env.TURN_SECRET) {
      const { username, credential } = ephemeralTurnCredentials(
        process.env.TURN_SECRET,
        userId
      );
      iceServers.push({ urls: TURN_URLS, username, credential });
      hasTurn = true;
    } else if (process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
      iceServers.push({
        urls: TURN_URLS,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_PASSWORD,
      });
      hasTurn = true;
      ttl = 12 * 3600; // static creds don't expire; refresh occasionally anyway
    }
  }

  res.json(
    new ApiResponse(
      200,
      {
        iceServers,
        // Client refreshes shortly before this elapses so long calls don't
        // lose the ability to open new peer connections mid-session.
        ttl,
        hasTurn,
      },
      'YapLine ICE configuration'
    )
  );
});

const yapLineController = {
  getActiveSessions,
  getRecentActivity,
  getIceConfig,
};

export default yapLineController;