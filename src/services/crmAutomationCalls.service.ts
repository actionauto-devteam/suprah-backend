import mongoose from 'mongoose';
import CrmAutomation from '../models/CrmAutomation.model';
import CrmLocation from '../models/CrmLocation.model';
import DealershipPhoneNumber from '../models/DealershipPhoneNumber.model';
import Lead from '../models/lead.model';
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

async function callLocation(orgId: string, call: any): Promise<string> {
  const dialed = (await dialedNumberLocations(orgId, [call?.to])).get(digits(call?.to));
  if (dialed) return dialed;
  const filter: Record<string, unknown> = { organizationId: { $in: orgVariants(orgId) } };
  if (call?.leadId && mongoose.isValidObjectId(call.leadId)) filter._id = call.leadId;
  else if (digits(call?.from)) filter.normalizedPhone = { $in: [`+1${digits(call.from)}`, `1${digits(call.from)}`, digits(call.from)] };
  else return '';
  const lead: any = await Lead.findOne(filter).sort({ createdAt: -1 }).select('location').lean();
  return String(lead?.location || '');
}

export async function automationForMissedCallText(call: any): Promise<string | null> {
  if (process.env.CRM_AUTOMATIONS_ENABLED !== 'true') return null;
  const orgId = String(call?.orgId || '');
  if (!orgId) return null;
  const automations: any[] = await CrmAutomation.find({ organizationId: orgId, status: 'active', 'trigger.event': { $in: MISSED_CALL_TEXT_EVENTS } }).select('name locations').lean();
  if (!automations.length) return null;
  const everywhere = automations.find((automation) => automation.locations?.mode !== 'specific');
  if (everywhere) return String(everywhere.name);
  const key = normalizeLocationKey(await callLocation(orgId, call));
  if (!key) return null;
  const ids = automations.flatMap((automation) => automation.locations?.ids || []).filter((id: string) => mongoose.isValidObjectId(id));
  const locations: any[] = await CrmLocation.find({ organizationId: orgId, _id: { $in: ids } }).select('name aliasKeys').lean();
  const covered = new Set(locations.filter((location) => normalizeLocationKey(location.name) === key || (location.aliasKeys || []).some((alias: string) => normalizeLocationKey(alias) === key)).map((location) => String(location._id)));
  const match = automations.find((automation) => (automation.locations?.ids || []).some((id: string) => covered.has(String(id))));
  return match ? String(match.name) : null;
}
