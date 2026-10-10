import { CallLog } from '../models/communication.model';
import { RoutingConfig, IvrRoutingState } from '../models/CallRoutingConfig.model';
import { routingGroupRecipients } from './callRoutingConfig.service';
import * as telnyx from './telnyx.service';
import { getSocketIO } from '../utils/socketEmitter';
import Lead from '../models/lead.model';

export interface IvrCallbacks {
  missed: (call: any) => Promise<void>;
}

const timers = new Map<string, NodeJS.Timeout>();

export function clearIvrTimer(callId: string): void {
  const timer = timers.get(callId);
  if (timer) clearTimeout(timer);
  timers.delete(callId);
}

export function emitIvrCall(call: any, event = 'comm:call:update'): void {
  const io = getSocketIO();
  if (!io) return;
  const payload = { call: call.toObject ? call.toObject() : call, orgId: String(call.orgId) };
  if (call.routing?.allOrg) io.to(`org:${call.orgId}`).emit(event, payload);
  else {
    const ids: string[] = event === 'comm:call:incoming' ? call.routing?.recipientIds || [] : call.routing?.notifiedIds || [];
    const rooms = [...new Set(ids.flatMap(id => [`user:${id}`, `crm-user:${id}`]))];
    if (rooms.length) io.to(rooms).emit(event, payload);
  }
}

function emitRouteChange(previous: any, next: any): void {
  const io = getSocketIO();
  const rooms = (previous.routing?.recipientIds || []).flatMap((id: string) => [`user:${id}`, `crm-user:${id}`]);
  if (rooms.length) io?.to(rooms).emit('comm:call:removed', { callId: String(next._id), orgId: String(next.orgId) });
  emitIvrCall(next, 'comm:call:incoming');
}

function state(payload: any): any {
  try { return JSON.parse(Buffer.from(payload?.client_state || '', 'base64').toString('utf8')); }
  catch { return null; }
}

function arm(call: any, callbacks: IvrCallbacks): void {
  clearIvrTimer(String(call._id));
  if (!call.routing?.deadline) return;
  const delay = Math.max(1, new Date(call.routing.deadline).getTime() - Date.now());
  const timer = setTimeout(() => {
    timers.delete(String(call._id));
    expireIvr(call._id, call.routing.revision, callbacks).catch(error => console.error('[ivr] Timeout failed', error));
  }, delay);
  timer.unref();
  timers.set(String(call._id), timer);
}

async function advance(call: any, stage: IvrRoutingState['stage'], reason: string, values: Record<string, unknown> = {}): Promise<any> {
  return CallLog.findOneAndUpdate({
    _id: call._id, orgId: call.orgId, 'routing.revision': call.routing.revision,
    status: { $in: ['ivr', 'ringing', 'answering'] },
  }, {
    $set: { 'routing.stage': stage, ...values },
    $inc: { 'routing.revision': 1 },
    $push: { 'routing.history': { stage, reason, at: new Date() } },
  }, { new: true });
}

async function finishMissed(call: any, callbacks: IvrCallbacks): Promise<void> {
  const final = await advance(call, 'terminal', 'final-unanswered', {
    status: 'missed', endedAt: new Date(), 'routing.deadline': null,
  });
  if (!final) return;
  clearIvrTimer(String(call._id));
  emitIvrCall(final);
  await callbacks.missed(final);
}

async function route(call: any, stage: 'selected' | 'reception' | 'all-org', groupId: string | null, reason: string, callbacks: IvrCallbacks): Promise<void> {
  const lock = await advance(call, 'routing', reason, { status: 'ivr', 'routing.deadline': new Date(Date.now() + 20000) });
  if (!lock) return;
  clearIvrTimer(String(call._id));
  arm(lock, callbacks);
  if (call.status === 'answering' && call.agentLegCallControlId) {
    await telnyx.hangupCall(call.agentLegCallControlId).catch(() => {});
  }
  let ids: string[] = [];
  try { ids = stage === 'all-org' ? [] : await routingGroupRecipients(String(call.orgId), groupId); }
  catch (error) { console.error('[ivr] Group lookup failed', error); }
  if (!ids.length && stage !== 'all-org') {
    if (stage === 'selected') return route(lock, 'reception', lock.routing.config.receptionGroupId, 'selected-group-unavailable', callbacks);
    if (lock.routing.config.allOrgFallback) return route(lock, 'all-org', null, 'reception-unavailable', callbacks);
    return finishMissed(lock, callbacks);
  }
  const next = await advance(lock, stage, reason, {
    status: 'ringing', answeredBy: null, agentLegCallControlId: null, 'routing.targetGroupId': groupId,
    'routing.recipientIds': ids, 'routing.allOrg': stage === 'all-org',
    'routing.notifiedIds': [...new Set([...(lock.routing.notifiedIds || []), ...ids])],
    'routing.deadline': new Date(Date.now() + lock.routing.config.ringTimeoutSeconds * 1000),
  });
  if (!next) return;
  emitRouteChange(call, next);
  arm(next, callbacks);
  await telnyx.speakIvr(next.providerCallControlId, 'Please hold while we connect your call.', {
    kind: 'ivr-hold', callLogId: String(next._id), revision: next.routing.revision,
  }).catch(error => console.error('[ivr] Hold announcement failed', error));
}

async function menu(call: any, callbacks: IvrCallbacks, initial = false): Promise<void> {
  arm(call, callbacks);
  try {
    await telnyx.gatherIvr(call.providerCallControlId, call.routing.config.greeting,
      call.routing.config.options.map((option: any) => option.digit).join(''), {
        kind: 'ivr-menu', callLogId: String(call._id), revision: call.routing.revision,
      });
  } catch (error) {
    console.error('[ivr] Gather failed; routing to reception', error);
    await route(call, initial ? 'all-org' : 'reception', initial ? null : call.routing.config.receptionGroupId,
      initial ? 'legacy-initialization-fallback' : 'gather-failed', callbacks);
  }
}

export async function initializeIvr(call: any, config: RoutingConfig, callbacks: IvrCallbacks): Promise<boolean> {
  const routing: IvrRoutingState = {
    config, stage: 'initializing', revision: 0, attempts: 0, recipientIds: [], notifiedIds: [], allOrg: false,
    deadline: new Date(Date.now() + 20000), history: [{ stage: 'initializing', reason: 'inbound', at: new Date() }],
  };
  const initial = await CallLog.findOneAndUpdate({ _id: call._id, status: 'ivr' }, { $set: { routing } }, { new: true });
  if (!initial) return true;
  arm(initial, callbacks);
  try {
    await telnyx.answerCall(call.providerCallControlId, { kind: 'ivr-customer', callLogId: String(call._id) });
  } catch (error) {
    clearIvrTimer(String(call._id));
    console.error('[ivr] Answer failed; using legacy inbound flow', error);
    await route(initial, 'all-org', null, 'legacy-initialization-fallback', callbacks);
    return true;
  }
  const ready = await advance(initial, 'menu', 'customer-leg-answered', {
    'routing.customerAnswered': true, 'routing.deadline': new Date(Date.now() + 60000),
  });
  if (ready) await menu(ready, callbacks, true);
  return true;
}

export async function handleIvrGather(payload: any, callbacks: IvrCallbacks): Promise<void> {
  const tag = state(payload);
  if (tag?.kind !== 'ivr-menu' || !Number.isInteger(tag.revision)) return;
  const call = await CallLog.findOne({ providerCallControlId: payload.call_control_id, status: 'ivr', 'routing.stage': 'menu', 'routing.revision': tag.revision });
  if (!call || String(call._id) !== tag.callLogId) return;
  const option = call.routing.config.options.find((entry: any) => entry.digit === payload.digits);
  if (!option || (payload.status && payload.status !== 'valid')) return retryOrReception(call, callbacks);
  const selected = await advance(call, 'routing', 'digit-selected', {
    'routing.selectedDigit': option.digit, 'routing.selectedLabel': option.label,
    'routing.type': option.type, 'routing.language': option.language,
    'routing.leadLocation': option.type === 'location' ? option.leadLocation : '',
    'routing.deadline': new Date(Date.now() + 20000),
  });
  if (!selected) return;
  arm(selected, callbacks);
  if (option.type === 'location' && option.leadLocation && call.leadId) {
    const lead = await Lead.findOneAndUpdate({ _id: call.leadId, organizationId: call.orgId }, { $set: { location: option.leadLocation } }, { new: true });
    if (lead) getSocketIO()?.to(`org:${call.orgId}`).emit('lead:update', lead.toObject());
  }
  return route(selected, option.type === 'language' && option.digit === '0' ? 'reception' : 'selected',
    option.type === 'language' && option.digit === '0' ? selected.routing.config.receptionGroupId : option.groupId,
    'option-selected', callbacks);
}

async function retryOrReception(call: any, callbacks: IvrCallbacks): Promise<void> {
  if (call.routing.attempts < call.routing.config.retryCount) {
    const next = await advance(call, 'menu', 'invalid-or-no-input', {
      'routing.attempts': call.routing.attempts + 1, 'routing.deadline': new Date(Date.now() + 60000),
    });
    if (next) await menu(next, callbacks);
  } else await route(call, 'reception', call.routing.config.receptionGroupId, 'menu-retries-exhausted', callbacks);
}

export async function expireIvr(callId: string, revision: number, callbacks: IvrCallbacks): Promise<void> {
  const call = await CallLog.findOne({ _id: callId, 'routing.revision': revision, status: { $in: ['ivr', 'ringing', 'answering'] } });
  if (!call) return;
  if (call.routing.stage === 'menu') return retryOrReception(call, callbacks);
  if (call.routing.stage === 'selected' || ['initializing', 'routing'].includes(call.routing.stage)) {
    return route(call, 'reception', call.routing.config.receptionGroupId, 'route-timeout', callbacks);
  }
  if (call.routing.stage === 'reception' && call.routing.config.allOrgFallback) {
    return route(call, 'all-org', null, 'reception-timeout', callbacks);
  }
  await finishMissed(call, callbacks);
}

export async function recoverIvrCalls(callbacks: IvrCallbacks, orgId?: string): Promise<void> {
  const overdue = await CallLog.find({ ...(orgId ? { orgId } : {}), status: { $in: ['ivr', 'ringing', 'answering'] }, 'routing.deadline': { $lte: new Date() } }).limit(50);
  for (const call of overdue) await expireIvr(String(call._id), call.routing.revision, callbacks);
}

export async function canReceiveIvrCall(call: any, userId: string): Promise<boolean> {
  if (!call.routing) return true;
  if (call.status !== 'ringing') return false;
  if (call.routing.allOrg) return true;
  if (!(call.routing.recipientIds || []).includes(String(userId))) return false;
  const current = await routingGroupRecipients(String(call.orgId), call.routing.targetGroupId);
  return current.includes(String(userId));
}

export async function ivrAgentFailed(call: any, callbacks: IvrCallbacks): Promise<void> {
  if (!call.routing) return;
  await expireIvr(String(call._id), call.routing.revision, callbacks);
}
