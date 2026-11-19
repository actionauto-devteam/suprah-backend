/**
 * Real-time fan-out for the Deal Desk (socket.io namespace "/deal-desk").
 *
 * Rooms:
 *   org:<orgId>:staff   reviewers, FMs and managers — the whole queue
 *   user:<userId>       a person's own deals, offers and alerts
 *   deal:<dealId>       anyone with the deal workspace open (thread, detail)
 */
import { toDealSummary, toMessageDTO } from './serialize';

type Nsp = {
  to: (room: string | string[]) => { emit: (event: string, payload: unknown) => void };
};

let nsp: Nsp | null = null;

export function setDealDeskNamespace(namespace: Nsp) {
  nsp = namespace;
}

export const rooms = {
  staff: (orgId: string) => `org:${orgId}:staff`,
  user: (userId: string) => `user:${userId}`,
  deal: (dealId: string) => `deal:${dealId}`,
};

function safeEmit(targets: string[], event: string, payload: unknown) {
  if (!nsp || !targets.length) return;
  try {
    nsp.to(targets).emit(event, payload);
  } catch (err) {
    console.error('[deal-desk] socket emit failed', event, err);
  }
}

/** Broadcast a deal change to the queue (staff), its salesperson, and open workspaces. */
export function emitDealChanged(deal: any, reason = 'updated') {
  const orgId = String(deal.organizationId);
  const summary = toDealSummary(deal);
  const targets = [rooms.staff(orgId), rooms.deal(String(deal._id))];
  if (deal.salesperson?.id) targets.push(rooms.user(String(deal.salesperson.id)));
  if (deal.createdBy?.id && String(deal.createdBy.id) !== String(deal.salesperson?.id)) targets.push(rooms.user(String(deal.createdBy.id)));
  safeEmit(targets, 'deal:upsert', { reason, deal: summary });
}

export function emitDealMessage(message: any) {
  safeEmit([rooms.deal(String(message.dealId))], 'deal:message', toMessageDTO(message));
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  safeEmit([rooms.user(userId)], event, payload);
}

export function emitToStaff(orgId: string, event: string, payload: unknown) {
  safeEmit([rooms.staff(orgId)], event, payload);
}
