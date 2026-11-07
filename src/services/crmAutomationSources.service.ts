import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import Vehicle from '../models/Vehicle.model';
import CrmAutomationRun from '../models/CrmAutomationRun.model';
import { CallRecording } from '../models/CallRecording.model';
import { CallLog, CommunicationMessage, Conversation } from '../models/communication.model';
import { CONTACT_RESTRICTED_STATUSES, NURTURE_ELIGIBLE_STATUSES, classifyLeadLifecycle } from '../constants/leadStatus';
import { COMPANY_TZ, zoneOffsetMinutes } from '../utils/companyTimezone';
import { matchesVehicle } from '../utils/vehicleMatch';
import { dialedKey, dialedNumberLocations } from './crmAutomationCalls.service';
import type { EngineEvent } from './crmAutomationEngine.service';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const RECORD_LIMIT = 500;
const VEHICLE_LIMIT = 100;
const VEHICLE_CANDIDATE_LIMIT = 2000;
const VEHICLE_MATCH_LIMIT = 25;
const VEHICLE_LEAD_MAX_AGE_DAYS = 180;
const VOICEMAIL_LOOKBACK_MS = 6 * 60 * MINUTE;
const SELF_MESSAGE_WINDOW_MS = 2 * MINUTE;
const DATE_CANDIDATE_LIMIT = 5000;
export const DATE_RUN_LIMIT = 500;
export const DATE_LATE_LIMIT_MS = 60 * MINUTE;
export const MIN_PRICE_DROP = parseFloat(process.env.PRICE_DROP_EMAIL_MIN_AMOUNT || '250');
const UNIT_MS: Record<string, number> = { minutes: MINUTE, hours: 60 * MINUTE, days: DAY };

function orgIdVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

function fullName(first?: unknown, last?: unknown): string {
  return [first, last].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

export function quietPeriodMs(quietFor: { amount?: number; unit?: string } | null | undefined): number {
  const amount = Number(quietFor?.amount) || 24;
  return amount * (quietFor?.unit === 'days' ? DAY : 60 * MINUTE);
}

export async function collectQuietEvents(orgId: string, since: Date, now: Date, quietMs: number): Promise<EngineEvent[]> {
  const orgIds = orgIdVariants(orgId);
  const from = new Date(since.getTime() - quietMs);
  const to = new Date(now.getTime() - quietMs);
  const conversations = await Conversation.find({ orgId: { $in: orgIds }, lastMessageAt: { $gt: from, $lte: to }, lastDirection: 'outbound' })
    .select('_id leadId customerPhone')
    .limit(RECORD_LIMIT)
    .lean();
  const events: EngineEvent[] = [];
  for (const conversation of conversations as any[]) {
    const last: any = await CommunicationMessage.findOne({ conversationId: conversation._id }).sort({ createdAt: -1 }).select('direction status createdAt leadId').lean();
    if (!last || last.direction !== 'outbound' || last.status === 'failed') continue;
    const at = new Date(last.createdAt);
    if (at <= from || at > to) continue;
    const leadId = String(conversation.leadId || last.leadId || '');
    if (!mongoose.isValidObjectId(leadId)) continue;
    const lead: any = await Lead.findOne({ _id: leadId, organizationId: { $in: orgIds } }).select('firstName lastName phone email status source intakeIdentity followUp.lastCustomerActivityAt').lean();
    if (!lead || lead.source === 'Demo' || lead.intakeIdentity === 'unverified' || classifyLeadLifecycle(lead.status) !== 'active') continue;
    const activity = lead.followUp?.lastCustomerActivityAt ? new Date(lead.followUp.lastCustomerActivityAt) : null;
    if (activity && activity >= at) continue;
    const ownMessage = await CrmAutomationRun.exists({
      organizationId: orgId,
      'contact.leadId': leadId,
      mode: 'live',
      log: { $elemMatch: { status: 'sent', at: { $gte: new Date(at.getTime() - SELF_MESSAGE_WINDOW_MS), $lte: new Date(at.getTime() + SELF_MESSAGE_WINDOW_MS) } } },
    });
    if (ownMessage) continue;
    events.push({
      eventKey: `quiet:${leadId}:${at.getTime()}`,
      triggerAt: new Date(at.getTime() + quietMs),
      leadId,
      phone: String(lead.phone || conversation.customerPhone || ''),
      email: String(lead.email || ''),
      name: fullName(lead.firstName, lead.lastName),
    });
  }
  return events;
}

export async function collectVoicemailEvents(orgId: string, since: Date, now: Date): Promise<EngineEvent[]> {
  const records = await CallRecording.find({
    organizationId: orgId,
    kind: 'voicemail',
    startedAt: { $gt: new Date(since.getTime() - VOICEMAIL_LOOKBACK_MS) },
    updatedAt: { $gt: since, $lte: now },
    'files.0': { $exists: true },
    state: { $nin: ['deleting', 'deleted'] },
  }).select('callLogId leadId files updatedAt').limit(RECORD_LIMIT).lean();
  if (!records.length) return [];
  const calls = await CallLog.find({ _id: { $in: records.map((record: any) => record.callLogId) } }).select('from to customerName leadId').lean();
  const byId = new Map(calls.map((call: any) => [String(call._id), call]));
  const dialed = await dialedNumberLocations(orgId, calls.map((call: any) => String(call.to || '')));
  return records.map((record: any) => {
    const call: any = byId.get(String(record.callLogId)) || {};
    const leadId = record.leadId || call.leadId;
    return {
      eventKey: `voicemail:${record._id}`,
      triggerAt: new Date(record.files?.[0]?.endedAt || record.updatedAt),
      leadId: leadId ? String(leadId) : null,
      phone: String(call.from || ''),
      email: '',
      name: String(call.customerName || ''),
      location: dialed.get(dialedKey(call.to)) || '',
    };
  });
}

function vehicleLabel(vehicle: any): string {
  return [vehicle.year, vehicle.make, vehicle.modelName].filter(Boolean).join(' ');
}

function sameCode(left: unknown, right: unknown): boolean {
  const a = String(left || '').trim().toUpperCase();
  const b = String(right || '').trim().toUpperCase();
  return Boolean(a && b && a === b);
}

async function matchVehicleLeads(orgId: string, vehicle: any, kind: 'added' | 'price', now: Date): Promise<any[]> {
  const candidates = await Lead.find({
    organizationId: { $in: orgIdVariants(orgId) },
    status: { $in: NURTURE_ELIGIBLE_STATUSES },
    createdAt: { $gte: new Date(now.getTime() - VEHICLE_LEAD_MAX_AGE_DAYS * DAY) },
    source: { $ne: 'Demo' },
    intakeIdentity: { $ne: 'unverified' },
    'vehicle.year': { $exists: true, $ne: '' },
    'vehicle.make': { $exists: true, $ne: '' },
    'vehicle.model': { $exists: true, $ne: '' },
    $or: [{ phone: { $exists: true, $ne: '' } }, { email: { $exists: true, $ne: '' } }],
  })
    .select('firstName lastName phone email vehicle createdAt')
    .sort({ createdAt: -1 })
    .limit(VEHICLE_CANDIDATE_LIMIT)
    .lean();
  const matched = (candidates as any[]).filter((lead) => {
    if (kind === 'added') return matchesVehicle(lead.vehicle, vehicle);
    if (sameCode(lead.vehicle?.vin, vehicle.vin) || sameCode(lead.vehicle?.stock, vehicle.stockNumber)) return true;
    if (String(lead.vehicle?.vin || '').trim() || String(lead.vehicle?.stock || '').trim()) return false;
    return matchesVehicle(lead.vehicle, vehicle);
  });
  return matched.slice(0, VEHICLE_MATCH_LIMIT);
}

function vehicleEvent(lead: any, vehicle: any, eventKey: string, triggerAt: Date, price: number | null): EngineEvent {
  return {
    eventKey,
    triggerAt,
    leadId: String(lead._id),
    phone: String(lead.phone || ''),
    email: String(lead.email || ''),
    name: fullName(lead.firstName, lead.lastName),
    vehicle: { id: String(vehicle._id), label: vehicleLabel(vehicle), price: Number.isFinite(price) ? price : null, link: String(vehicle.vdpUrl || '') },
  };
}

const LIVE_VEHICLE = { isDeleted: false, isArchived: { $ne: true }, status: { $ne: 'Sold' } };
const VEHICLE_FIELDS = 'year make modelName vin stockNumber price vdpUrl createdAt priceHistory';

export async function collectVehicleAddedEvents(orgId: string, since: Date, now: Date): Promise<EngineEvent[]> {
  const vehicles = await Vehicle.find({ organizationId: orgId, createdAt: { $gt: since, $lte: now }, ...LIVE_VEHICLE }).select(VEHICLE_FIELDS).limit(VEHICLE_LIMIT).lean();
  const events: EngineEvent[] = [];
  for (const vehicle of vehicles as any[]) {
    for (const lead of await matchVehicleLeads(orgId, vehicle, 'added', now)) {
      events.push(vehicleEvent(lead, vehicle, `vehicle_added:${vehicle._id}:${lead._id}`, new Date(vehicle.createdAt), Number(vehicle.price)));
    }
  }
  return events;
}

export async function collectPriceDropEvents(orgId: string, since: Date, now: Date): Promise<EngineEvent[]> {
  const vehicles = await Vehicle.find({ organizationId: orgId, priceUpdatedAt: { $gt: since }, ...LIVE_VEHICLE }).select(VEHICLE_FIELDS).limit(VEHICLE_LIMIT).lean();
  const events: EngineEvent[] = [];
  for (const vehicle of vehicles as any[]) {
    const drops = (vehicle.priceHistory || []).filter((entry: any) => {
      const at = entry?.changedAt ? new Date(entry.changedAt) : null;
      const before = Number(entry?.previousPrice);
      const after = Number(entry?.newPrice);
      return at && at > since && at <= now && before > 0 && after > 0 && before - after >= MIN_PRICE_DROP;
    });
    if (!drops.length) continue;
    const leads = await matchVehicleLeads(orgId, vehicle, 'price', now);
    for (const drop of drops) {
      const at = new Date(drop.changedAt);
      for (const lead of leads) events.push(vehicleEvent(lead, vehicle, `price_drop:${vehicle._id}:${at.getTime()}:${lead._id}`, at, Number(drop.newPrice)));
    }
  }
  return events;
}

function companyWallTimeUtc(date: string, time: string): Date {
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - zoneOffsetMinutes(new Date(guess), COMPANY_TZ) * MINUTE;
  return new Date(guess);
}

export function dateTriggerTimes(trigger: any, flatSteps: any[]): { at: Date; fireAt: Date; key: string } | null {
  if (!trigger?.date || !/^\d{4}-\d{2}-\d{2}$/.test(trigger.date)) return null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(trigger.time || '')) ? String(trigger.time) : '09:00';
  const at = companyWallTimeUtc(trigger.date, time);
  let lead = 0;
  for (const step of flatSteps) {
    const timing = step?.config?.timing;
    if (timing?.when === 'before') lead = Math.max(lead, Number(timing.amount || 0) * (UNIT_MS[timing.unit] || 0));
  }
  return { at, fireAt: new Date(at.getTime() - lead), key: `${trigger.date}T${time}` };
}

export async function dateTriggerLeads(orgId: string): Promise<any[]> {
  return Lead.find({
    organizationId: { $in: orgIdVariants(orgId) },
    source: { $ne: 'Demo' },
    intakeIdentity: { $ne: 'unverified' },
    status: { $nin: CONTACT_RESTRICTED_STATUSES },
    $or: [{ phone: { $exists: true, $ne: '' } }, { email: { $exists: true, $ne: '' } }],
  })
    .select('_id firstName lastName phone email')
    .sort({ createdAt: -1 })
    .limit(DATE_CANDIDATE_LIMIT)
    .lean();
}
