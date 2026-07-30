import { Server as IOServer, Socket } from 'socket.io';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import YapLineSession, { YAPLINE_MAX_ACTIVITY, YapLineActivityType } from '../models/YapLineSession.model';
import logger from '../utils/logger';

/**
 * Suprah YapLine — push-to-talk voice + live screen share over the existing
 * SupraSpace socket (path /socket/supraspace).
 *
 * Architecture:
 *   - Audio & screen video travel peer-to-peer over WebRTC (mesh). The server
 *     never touches media — it only relays SDP/ICE signaling between members
 *     of the same conversation, and broadcasts presence/speaker/screen state.
 *   - A "yap session" per conversation exists while >= 1 participant is
 *     connected. First join creates it (and a YapLineSession doc for history);
 *     last leave/disconnect ends it.
 *   - Privacy: every event is gated on SupraSpaceConversation membership —
 *     exactly the same boundary SupraSpace chat already enforces. Nothing is
 *     ever broadcast org-wide or globally.
 *
 * Rooms used:
 *   yap:{conversationId}  — sockets actively in the session (speaker/screen/peer events)
 *   user:{userId}         — already joined by supraspace.socket.ts; used for
 *                           session-started/-ended/-update fanout so the
 *                           Dashboard widget + auto-listen work on ANY page.
 */

// ─── In-memory live state ────────────────────────────────────────────────────

interface YapParticipant {
  userId: string;
  socketId: string;
  fullName: string;
  username?: string;
  avatar?: string | null;
  listenOnly: boolean;
  speaking: boolean;
  sharingScreen: boolean;
  joinedAt: number;
}

interface YapSessionState {
  conversationId: string;
  conversationName: string | null;
  sessionDocId: string | null;
  memberIds: string[];            // conversation members at session start (fanout targets)
  startedBy: string;
  startedAt: number;
  peak: number;
  participants: Map<string, YapParticipant>; // keyed by userId
  lastSpokeLogAt: Map<string, number>;       // throttle 'spoke' activity entries
}

const sessions = new Map<string, YapSessionState>();

// ─── Public helpers (used by controllers/yapline.controller.ts) ──────────────

export interface YapSessionSummary {
  conversationId: string;
  conversationName: string | null;
  startedBy: string;
  startedAt: number;
  participants: Array<{
    userId: string;
    fullName: string;
    avatar?: string | null;
    speaking: boolean;
    sharingScreen: boolean;
    listenOnly: boolean;
  }>;
  speakingIds: string[];
  screenSharerId: string | null;
}

function summarize(s: YapSessionState): YapSessionSummary {
  const participants = [...s.participants.values()].map((p) => ({
    userId: p.userId,
    fullName: p.fullName,
    avatar: p.avatar ?? null,
    speaking: p.speaking,
    sharingScreen: p.sharingScreen,
    listenOnly: p.listenOnly,
  }));
  return {
    conversationId: s.conversationId,
    conversationName: s.conversationName,
    startedBy: s.startedBy,
    startedAt: s.startedAt,
    participants,
    speakingIds: participants.filter((p) => p.speaking).map((p) => p.userId),
    screenSharerId: participants.find((p) => p.sharingScreen)?.userId ?? null,
  };
}

/** All live sessions (controller filters to the requesting user's conversations). */
export function getActiveYapSessions(): YapSessionSummary[] {
  return [...sessions.values()].map(summarize);
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function isConversationMember(conversationId: string, userId: string): Promise<boolean> {
  if (!conversationId || !userId) return false;
  const exists = await SupraSpaceConversation.exists({
    _id: conversationId,
    members: userId,
    isActive: true,
  });
  return Boolean(exists);
}

function fanoutToMembers(io: IOServer, s: YapSessionState, event: string, payload: any) {
  s.memberIds.forEach((id) => io.to(`user:${id}`).emit(event, payload));
}

function broadcastUpdate(io: IOServer, s: YapSessionState) {
  fanoutToMembers(io, s, 'yapline:session-update', summarize(s));
}

/** Fire-and-forget activity log on the persisted session doc. */
function logActivity(s: YapSessionState, userId: string, name: string, type: YapLineActivityType) {
  if (!s.sessionDocId) return;
  YapLineSession.updateOne(
    { _id: s.sessionDocId },
    {
      $push: {
        activity: { $each: [{ userId, name, type, at: new Date() }], $slice: -YAPLINE_MAX_ACTIVITY },
      },
    }
  ).catch(() => { /* history is best-effort */ });
}

async function endSession(io: IOServer, s: YapSessionState) {
  sessions.delete(s.conversationId);
  fanoutToMembers(io, s, 'yapline:session-ended', { conversationId: s.conversationId });
  if (s.sessionDocId) {
    await YapLineSession.updateOne(
      { _id: s.sessionDocId },
      {
        $set: { isActive: false, endedAt: new Date(), peakParticipants: s.peak },
        $push: {
          activity: {
            $each: [{ userId: s.startedBy, name: 'System', type: 'ended', at: new Date() }],
            $slice: -YAPLINE_MAX_ACTIVITY,
          },
        },
      }
    ).catch((err) => logger.warn({ err }, '[YapLine] Failed to close session doc'));
  }
}

function removeParticipant(io: IOServer, s: YapSessionState, userId: string, reason: 'left' | 'disconnected') {
  const p = s.participants.get(userId);
  if (!p) return;
  s.participants.delete(userId);

  io.to(`yap:${s.conversationId}`).emit('yapline:peer-left', {
    conversationId: s.conversationId,
    userId,
  });
  logActivity(s, userId, p.fullName, 'left');

  if (s.participants.size === 0) {
    void endSession(io, s);
  } else {
    broadcastUpdate(io, s);
  }

  logger.info({ userId, conversationId: s.conversationId, reason }, '[YapLine] Participant removed');
}

// ─── Handler registration (called from supraspace.socket.ts on connection) ──

export function registerYapLineHandlers(io: IOServer, socket: Socket): void {
  const user = (socket as any).crmUser;
  const userId: string = user._id.toString();

  // Conversations this socket has joined — needed for disconnect cleanup.
  const joined = new Set<string>();
  (socket as any).__yapJoined = joined;

  // ── Join (or start) a session ──────────────────────────────────────────
  socket.on(
    'yapline:join',
    async (
      { conversationId, listenOnly }: { conversationId: string; listenOnly?: boolean },
      ack?: (res: any) => void
    ) => {
      try {
        if (!(await isConversationMember(conversationId, userId))) {
          logger.warn({ userId, conversationId }, '[YapLine] Blocked unauthorized join');
          ack?.({ ok: false, error: 'Not a member of this conversation' });
          return;
        }

        let s = sessions.get(conversationId);
        const isNewSession = !s;

        if (!s) {
          const conv = await SupraSpaceConversation.findById(conversationId)
            .select('name type members')
            .lean();
          if (!conv) {
            ack?.({ ok: false, error: 'Conversation not found' });
            return;
          }
          s = {
            conversationId,
            conversationName: (conv as any).name || null,
            sessionDocId: null,
            memberIds: ((conv as any).members || []).map((m: any) => m.toString()),
            startedBy: userId,
            startedAt: Date.now(),
            peak: 0,
            participants: new Map(),
            lastSpokeLogAt: new Map(),
          };
          sessions.set(conversationId, s);

          try {
            const doc = await YapLineSession.create({
              conversationId,
              organizationId: user.organizationId ?? null,
              conversationName: s.conversationName,
              startedBy: userId,
              activity: [{ userId, name: user.fullName, type: 'started', at: new Date() }],
            });
            s.sessionDocId = doc._id.toString();
          } catch (err) {
            logger.warn({ err }, '[YapLine] Session doc create failed (continuing live-only)');
          }
        }

        // Same user joining from a second socket replaces the first — the
        // client tears down old peers when it sees peer-left for itself.
        const prev = s.participants.get(userId);
        if (prev && prev.socketId !== socket.id) {
          io.to(prev.socketId).emit('yapline:replaced', { conversationId });
          const prevSock = io.sockets.sockets.get(prev.socketId);
          prevSock?.leave(`yap:${conversationId}`);
          ((prevSock as any)?.__yapJoined as Set<string> | undefined)?.delete(conversationId);
        }

        const participant: YapParticipant = {
          userId,
          socketId: socket.id,
          fullName: user.fullName,
          username: user.username,
          avatar: user.avatar ?? null,
          listenOnly: !!listenOnly,
          speaking: false,
          sharingScreen: false,
          joinedAt: Date.now(),
        };
        s.participants.set(userId, participant);
        s.peak = Math.max(s.peak, s.participants.size);
        joined.add(conversationId);
        socket.join(`yap:${conversationId}`);

        // Tell existing participants a peer arrived. The NEWCOMER initiates
        // the WebRTC offers (client convention), so existing peers just wait
        // for a signal from this userId.
        socket.to(`yap:${conversationId}`).emit('yapline:peer-joined', {
          conversationId,
          participant: {
            userId,
            fullName: user.fullName,
            avatar: user.avatar ?? null,
            listenOnly: !!listenOnly,
          },
        });

        if (isNewSession) {
          fanoutToMembers(io, s, 'yapline:session-started', summarize(s));
        } else {
          logActivity(s, userId, user.fullName, 'joined');
          broadcastUpdate(io, s);
        }

        ack?.({ ok: true, session: summarize(s) });
        logger.info({ userId, conversationId, listenOnly: !!listenOnly }, '[YapLine] Joined');
      } catch (err: any) {
        logger.error(err, '[YapLine] join error');
        ack?.({ ok: false, error: 'Failed to join YapLine session' });
      }
    }
  );

  // ── Leave ──────────────────────────────────────────────────────────────
  socket.on('yapline:leave', ({ conversationId }: { conversationId: string }) => {
    const s = sessions.get(conversationId);
    joined.delete(conversationId);
    socket.leave(`yap:${conversationId}`);
    if (s && s.participants.get(userId)?.socketId === socket.id) {
      removeParticipant(io, s, userId, 'left');
    }
  });

  // ── WebRTC signaling relay (SDP descriptions + ICE candidates) ─────────
  socket.on(
    'yapline:signal',
    ({ conversationId, to, data }: { conversationId: string; to: string; data: any }) => {
      const s = sessions.get(conversationId);
      if (!s) return;
      const sender = s.participants.get(userId);
      const target = s.participants.get(to);
      // Both ends must be live participants of the same session — this is the
      // guard that keeps signaling (and therefore media) inside the channel.
      if (!sender || sender.socketId !== socket.id || !target) {
        logger.warn({ userId, to, conversationId }, '[YapLine] Blocked signal relay');
        return;
      }
      io.to(target.socketId).emit('yapline:signal', { conversationId, from: userId, data });
    }
  );

  // ── Push-to-talk state ─────────────────────────────────────────────────
  socket.on(
    'yapline:speaking',
    ({ conversationId, speaking }: { conversationId: string; speaking: boolean }) => {
      const s = sessions.get(conversationId);
      const p = s?.participants.get(userId);
      if (!s || !p || p.socketId !== socket.id) return;
      p.speaking = !!speaking;

      io.to(`yap:${conversationId}`).emit('yapline:speaking', {
        conversationId,
        userId,
        fullName: p.fullName,
        speaking: p.speaking,
      });
      broadcastUpdate(io, s);

      // Throttled history entry (one 'spoke' per user per 60s).
      if (speaking) {
        const last = s.lastSpokeLogAt.get(userId) || 0;
        if (Date.now() - last > 60_000) {
          s.lastSpokeLogAt.set(userId, Date.now());
          logActivity(s, userId, p.fullName, 'spoke');
        }
      }
    }
  );

  // ── Screen share state ─────────────────────────────────────────────────
  socket.on(
    'yapline:screen',
    ({ conversationId, sharing }: { conversationId: string; sharing: boolean }) => {
      const s = sessions.get(conversationId);
      const p = s?.participants.get(userId);
      if (!s || !p || p.socketId !== socket.id) return;

      if (sharing) {
        // One screen at a time — the newest share wins; previous sharer is told to stop.
        for (const other of s.participants.values()) {
          if (other.userId !== userId && other.sharingScreen) {
            other.sharingScreen = false;
            io.to(other.socketId).emit('yapline:screen-preempted', { conversationId });
          }
        }
      }
      p.sharingScreen = !!sharing;

      io.to(`yap:${conversationId}`).emit('yapline:screen', {
        conversationId,
        userId,
        fullName: p.fullName,
        sharing: p.sharingScreen,
      });
      broadcastUpdate(io, s);
      logActivity(s, userId, p.fullName, sharing ? 'screen_started' : 'screen_stopped');
    }
  );

  // ── State sync (dock/widget re-mount, reconnect) ───────────────────────
  socket.on('yapline:state-request', async (_payload, ack?: (res: any) => void) => {
    try {
      const all = getActiveYapSessions();
      if (!all.length) {
        ack?.({ ok: true, sessions: [] });
        return;
      }
      const allowed = await SupraSpaceConversation.find({
        _id: { $in: all.map((s) => s.conversationId) },
        members: userId,
        isActive: true,
      }).select('_id').lean();
      const allowedIds = new Set(allowed.map((c: any) => c._id.toString()));
      ack?.({ ok: true, sessions: all.filter((s) => allowedIds.has(s.conversationId)) });
    } catch (err: any) {
      logger.error(err, '[YapLine] state-request error');
      ack?.({ ok: false, sessions: [] });
    }
  });
}

// ─── Disconnect cleanup (called from supraspace.socket.ts) ───────────────────

export function handleYapLineDisconnect(io: IOServer, socket: Socket): void {
  const user = (socket as any).crmUser;
  if (!user) return;
  const userId: string = user._id.toString();
  const joined: Set<string> = (socket as any).__yapJoined || new Set();

  joined.forEach((conversationId) => {
    const s = sessions.get(conversationId);
    if (s && s.participants.get(userId)?.socketId === socket.id) {
      removeParticipant(io, s, userId, 'disconnected');
    }
  });
  joined.clear();
}