import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';
import { CRM_JWT_SECRET } from '../middleware/crmAuth.middleware';
import { pulseOrgRoom } from '../services/pulse360.service';

/**
 * Suprah Pulse360 — socket rooms.
 *
 * Per-user delivery reuses the existing `user:{id}` room, which every client
 * already joins, so alerts need no new plumbing at all.
 *
 * The org room is separate and gated: it carries other people's health scores
 * and is only for admins and managers viewing the Pulse360 dashboard. The
 * client asks to join with `pulse:join`; the server verifies the token and the
 * role before honouring it, because a client-supplied orgId is not a
 * credential.
 */

export function registerPulse360Socket(io: Server) {
  io.on('connection', (socket: Socket) => {
    socket.on('pulse:join', async (payload: { token?: string } = {}) => {
      try {
        const token =
          payload.token ||
          (socket.handshake.auth as any)?.token ||
          (socket.handshake.query?.token as string | undefined);

        if (!token) {
          socket.emit('pulse:join:denied', { reason: 'No token supplied' });
          return;
        }

        const decoded = jwt.verify(token, CRM_JWT_SECRET) as { id?: string; type?: string };
        if (decoded?.type !== 'crm' || !decoded.id) {
          socket.emit('pulse:join:denied', { reason: 'Not a CRM token' });
          return;
        }

        const user = await CrmUser.findById(decoded.id).select('role organizationId isActive').lean();
        if (!user || !user.isActive) {
          socket.emit('pulse:join:denied', { reason: 'Account inactive' });
          return;
        }
        if (!['admin', 'manager'].includes(user.role)) {
          socket.emit('pulse:join:denied', { reason: 'Manager access required' });
          return;
        }

        const room = pulseOrgRoom(String(user.organizationId));
        await socket.join(room);
        socket.emit('pulse:join:ok', { room });
      } catch (error) {
        socket.emit('pulse:join:denied', { reason: 'Token verification failed' });
      }
    });

    socket.on('pulse:leave', async (payload: { organizationId?: string } = {}) => {
      if (payload.organizationId) {
        await socket.leave(pulseOrgRoom(payload.organizationId));
      }
    });
  });
}

export default registerPulse360Socket;
