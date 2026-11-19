/**
 * socket.io namespace "/deal-desk".
 *
 * Auth mirrors crmAuth: a CRM session token (handshake auth.token, ?t=, or
 * the crm_token cookie) or a main-app access token whose user is linked to
 * a CRM account by email. Sockets join their org staff room (if they are a
 * reviewer / FM / manager) and their own user room; deal rooms are joined
 * on demand after an access check.
 */
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import tokenService from '../services/token.service';
import { CRM_JWT_SECRET, activeCrmSession } from '../middleware/crmAuth.middleware';
import DealDeskDeal from '../models/DealDeskDeal.model';
import { Actor, getSettings, rolesFor, canViewDeal } from '../services/dealDesk/access';
import { rooms, setDealDeskNamespace } from '../services/dealDesk/realtime';

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export async function resolveDealDeskActor(token: string): Promise<Actor> {
  let peek: any = null;
  try {
    peek = jwt.decode(token);
  } catch {
    /* fall through */
  }

  if (peek?.type === 'crm') {
    const decoded = jwt.verify(token, CRM_JWT_SECRET) as { id: string; type: string; sid?: string };
    if (decoded.sid) await activeCrmSession(token);
    const u: any = await CrmUser.findById(decoded.id).select('fullName email role organizationId isActive').lean();
    if (!u || !u.isActive) throw new Error('CRM account inactive');
    return { id: String(u._id), name: u.fullName, email: u.email, role: u.role, orgId: String(u.organizationId) };
  }

  const payload: any = (tokenService as any).verifyAccessToken(token);
  if (!payload?.sub || !payload?.orgId) throw new Error('Invalid token');
  const main: any = await User.findById(payload.sub).select('name email role organizationRole isActive organizationId').lean();
  if (!main || !main.isActive || String(main.organizationId) !== String(payload.orgId)) throw new Error('Account inactive');
  const linked: any = await CrmUser.findOne({ email: String(main.email).toLowerCase(), organizationId: payload.orgId })
    .select('fullName email role organizationId isActive')
    .lean();
  if (linked) {
    if (!linked.isActive) throw new Error('CRM account inactive');
    return { id: String(linked._id), name: linked.fullName, email: linked.email, role: linked.role, orgId: String(linked.organizationId) };
  }
  if (!['employee', 'admin', 'super_admin'].includes(main.role)) throw new Error('Staff account required');
  const role = ['admin', 'super_admin'].includes(main.role) || main.organizationRole === 'admin' ? 'admin' : main.organizationRole === 'manager' ? 'manager' : 'employee';
  return { id: String(main._id), name: main.name, email: main.email, role, orgId: String(payload.orgId) };
}

export function registerDealDeskNamespace(io: any) {
  const nsp = io.of('/deal-desk');

  nsp.use(async (socket: any, next: (err?: Error) => void) => {
    try {
      const hs = socket.handshake || {};
      const token: string | undefined =
        hs.auth?.token || (typeof hs.query?.t === 'string' ? hs.query.t : undefined) || readCookie(hs.headers?.cookie, 'crm_token');
      if (!token) return next(new Error('unauthorized'));
      socket.data.actor = await resolveDealDeskActor(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  nsp.on('connection', async (socket: any) => {
    const actor: Actor = socket.data.actor;
    const joinRooms = async () => {
      const settings = await getSettings(actor.orgId);
      const roles = rolesFor(actor, settings);
      socket.data.roles = roles;
      socket.join(rooms.user(actor.id));
      if (roles.isStaff) socket.join(rooms.staff(actor.orgId));
      else socket.leave(rooms.staff(actor.orgId));
      socket.emit('ready', { actor: { id: actor.id, name: actor.name }, roles });
    };
    await joinRooms().catch((err) => console.error('[deal-desk] join failed', err));

    socket.on('roles:refresh', () => joinRooms().catch(() => {}));

    socket.on('deal:watch', async (payload: { dealId?: string }, ack?: (r: { ok: boolean }) => void) => {
      try {
        const dealId = String(payload?.dealId || '');
        if (!mongoose.isValidObjectId(dealId)) return ack?.({ ok: false });
        const deal: any = await DealDeskDeal.findOne({ _id: dealId, organizationId: actor.orgId }).select('salesperson createdBy').lean();
        if (!deal || !canViewDeal(actor, socket.data.roles, deal)) return ack?.({ ok: false });
        socket.join(rooms.deal(dealId));
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });

    socket.on('deal:unwatch', (payload: { dealId?: string }) => {
      if (payload?.dealId) socket.leave(rooms.deal(String(payload.dealId)));
    });

    socket.on('deal:typing', (payload: { dealId?: string }) => {
      if (!payload?.dealId || !socket.rooms.has(rooms.deal(String(payload.dealId)))) return;
      socket.to(rooms.deal(String(payload.dealId))).emit('deal:typing', { dealId: payload.dealId, userId: actor.id, name: actor.name });
    });
  });

  setDealDeskNamespace(nsp);
  return nsp;
}
