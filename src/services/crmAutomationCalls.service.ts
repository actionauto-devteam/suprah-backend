import mongoose from 'mongoose';
import CrmAutomation from '../models/CrmAutomation.model';
import CrmLocation from '../models/CrmLocation.model';
import DealershipPhoneNumber from '../models/DealershipPhoneNumber.model';
import { stepsSendText } from './crmAutomationTexts.service';
import { normalizeLocationKey } from '../utils/locationKey';

export const MISSED_CALL_TEXT_EVENTS = ['call_missed', 'call_any'];

function orgVariants(orgId: string): unknown[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

function digits(value: unknown): string {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

export async function dialedNumberLocations(orgId: string, numbers: string[]): Promise<Map<string, string>> {
  const wanted = Array.from(new Set(numbers.map(digits).filter(Boolean)));
  const result = new Map<string, string>();
  if (!wanted.length) return result;
  const rows = await DealershipPhoneNumber.find({ organizationId: { $in: orgVariants(orgId) } }).select('number location').lean();
  for (const row of rows as any[]) {
    const key = digits(row.number);
    if (wanted.includes(key) && String(row.location || '').trim()) result.set(key, String(row.location).trim());
  }
  return result;
}

export function dialedKey(number: unknown): string {
  return digits(number);
}

export async function locationDisplayName(orgId: string, raw: string): Promise<string> {
  const key = normalizeLocationKey(raw);
  if (!key) return '';
  const locations = await CrmLocation.find({ organizationId: orgId }).select('name aliasKeys').lean();
  const match = (locations as any[]).find((location) => normalizeLocationKey(location.name) === key || (location.aliasKeys || []).some((alias: string) => normalizeLocationKey(alias) === key));
  return match ? String(match.name) : raw.trim();
}

export async function automationForMissedCallText(call: any): Promise<string | null> {
  if (process.env.CRM_AUTOMATIONS_ENABLED !== 'true') return null;
  const orgId = String(call?.orgId || '');
  if (!orgId) return null;
  const events = call?.abandonedAt ? [...MISSED_CALL_TEXT_EVENTS, 'call_abandoned'] : MISSED_CALL_TEXT_EVENTS;
  const automations: any[] = await CrmAutomation.find({ organizationId: orgId, status: 'active', 'trigger.event': { $in: events } }).lean();
  const texting = automations.filter((automation) => stepsSendText(automation.steps));
  if (!texting.length) return null;
  const { decideRun, locationKeyMap } = await import('./crmAutomationEngine.service');
  const event = {
    eventKey: `call_missed:${call?._id || 'now'}`,
    triggerAt: new Date(call?.endedAt || Date.now()),
    leadId: call?.leadId && mongoose.isValidObjectId(call.leadId) ? String(call.leadId) : null,
    phone: String(call?.from || ''),
    email: '',
    name: String(call?.customerName || ''),
    location: (await dialedNumberLocations(orgId, [call?.to])).get(digits(call?.to)) || '',
  };
  const locationKeys = await locationKeyMap(orgId);
  for (const automation of texting) {
    const decision = await decideRun(automation, event, orgId, locationKeys);
    if (!decision.reason) return String(automation.name);
  }
  return null;
}
