import mongoose from 'mongoose';
import DealershipPhoneNumber, { PHONE_NUMBER_KINDS, PhoneNumberKind, TelnyxNumberCheck } from '../models/DealershipPhoneNumber.model';
import CallRoutingConfig from '../models/CallRoutingConfig.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import * as telnyx from './telnyx.service';
import { ApiError } from '../utils/ApiError';

const US_E164 = /^\+1[2-9]\d{9}$/;
const REFERENCE_CACHE_MS = 10 * 60 * 1000;

export interface DealershipLine {
  organizationId: string;
  number: string;
  label: string;
  kind: PhoneNumberKind;
  location: string;
  department: string;
  ringGroupId: string | null;
}

export interface PhoneNumberInput {
  number: string;
  label: string;
  kind: PhoneNumberKind;
  location: string;
  department: string;
  ringGroupId: string | null;
}

export function normalizeDealershipNumber(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : '';
  return US_E164.test(e164) ? e164 : null;
}

const text = (value: unknown, max: number) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);

export function parsePhoneNumberInput(raw: any): PhoneNumberInput {
  const number = normalizeDealershipNumber(raw?.number);
  if (!number) throw new ApiError(400, 'Enter a 10-digit US phone number, for example (801) 555-0123.');
  const kind = String(raw?.kind || '') as PhoneNumberKind;
  if (!PHONE_NUMBER_KINDS.includes(kind)) throw new ApiError(400, 'Choose whether this is the main number, a location number, or a department number.');
  const label = text(raw?.label, 60) || (kind === 'main' ? 'Main' : '');
  if (!label) throw new ApiError(400, 'Give this number a name, for example "Lehi Sales".');
  if (label.length > 60) throw new ApiError(400, 'The name can be up to 60 characters.');
  const location = kind === 'location' ? text(raw?.location, 80) : '';
  if (kind === 'location' && !location) throw new ApiError(400, 'Choose the location for this number.');
  if (location.length > 80) throw new ApiError(400, 'The location can be up to 80 characters.');
  const department = kind === 'department' ? text(raw?.department, 60) : '';
  if (kind === 'department' && !department) throw new ApiError(400, 'Enter the department for this number, for example "Service".');
  if (department.length > 60) throw new ApiError(400, 'The department can be up to 60 characters.');
  const ringGroupId = String(raw?.ringGroupId ?? '').trim() || null;
  if (ringGroupId && !mongoose.isValidObjectId(ringGroupId)) throw new ApiError(400, 'Choose a team from your Lead Groups.');
  return { number, label, kind, location, department, ringGroupId };
}

export async function findDealershipLine(number: unknown): Promise<DealershipLine | null> {
  const normalized = normalizeDealershipNumber(number);
  if (!normalized) return null;
  const row: any = await DealershipPhoneNumber.findOne({ number: normalized })
    .select('organizationId number label kind location department ringGroupId').lean().catch(() => null);
  if (!row) return null;
  return {
    organizationId: String(row.organizationId),
    number: row.number,
    label: row.label,
    kind: row.kind,
    location: row.location || '',
    department: row.department || '',
    ringGroupId: row.ringGroupId ? String(row.ringGroupId) : null,
  };
}

export type OutboundChannel = 'texts' | 'calls';

export interface OutboundNumber {
  number: string;
  label: string;
  source: 'contacted' | 'location' | 'main' | 'company';
}

const sameText = (a: unknown, b: unknown) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export async function resolveOutboundNumber(opts: {
  organizationId: unknown;
  channel: OutboundChannel;
  contactedNumber?: unknown;
  leadId?: unknown;
}): Promise<OutboundNumber | null> {
  const orgId = String(opts.organizationId ?? '');
  const rows: any[] = mongoose.isValidObjectId(orgId)
    ? await DealershipPhoneNumber.find({ organizationId: orgId })
      .select('number label kind location telnyx createdAt').sort({ createdAt: 1 }).lean().catch(() => [])
    : [];
  const ready = rows.filter((row) => (opts.channel === 'texts' ? row.telnyx?.readyForTexts : row.telnyx?.readyForCalls) === true);
  const company = String(telnyx.COMPANY_NUMBER || '');
  const companyNumber = normalizeDealershipNumber(company);
  const labelFor = (number: string | null) => rows.find((row) => row.number === number)?.label || '';

  const contacted = normalizeDealershipNumber(opts.contactedNumber);
  if (contacted) {
    const row = ready.find((item) => item.number === contacted);
    if (row) return { number: row.number, label: row.label, source: 'contacted' };
    if (company && contacted === companyNumber) return { number: company, label: labelFor(companyNumber), source: 'contacted' };
  }

  const locationRows = ready.filter((row) => row.kind === 'location' && row.location);
  if (locationRows.length && opts.leadId && mongoose.isValidObjectId(String(opts.leadId))) {
    const lead: any = await mongoose.model('Lead').findOne({ _id: opts.leadId, organizationId: orgId }).select('location').lean().catch(() => null);
    const row = lead?.location ? locationRows.find((item) => sameText(item.location, lead.location)) : null;
    if (row) return { number: row.number, label: row.label, source: 'location' };
  }

  const main = ready.find((row) => row.kind === 'main');
  if (main) return { number: main.number, label: main.label, source: 'main' };
  if (company) return { number: company, label: labelFor(companyNumber), source: 'company' };
  return null;
}

export function leadFieldsForLine(line: DealershipLine | null | undefined): Record<string, string> {
  if (!line) return {};
  return { dealershipLine: line.label, ...(line.kind === 'location' && line.location ? { location: line.location } : {}) };
}

let referenceCache: { at: number; value: Awaited<ReturnType<typeof telnyx.findAccountPhoneNumber>> } | null = null;

async function referenceNumber() {
  const company = normalizeDealershipNumber(telnyx.COMPANY_NUMBER);
  if (!company) return null;
  if (referenceCache && Date.now() - referenceCache.at < REFERENCE_CACHE_MS) return referenceCache.value;
  const value = await telnyx.findAccountPhoneNumber(company).catch(() => null);
  referenceCache = { at: Date.now(), value };
  return value;
}

export function resetTelnyxReferenceCache() {
  referenceCache = null;
}

export async function checkNumberInTelnyx(number: string): Promise<TelnyxNumberCheck> {
  const checkedAt = new Date();
  try {
    const found = await telnyx.findAccountPhoneNumber(number);
    if (!found) {
      return { status: 'not_in_account', readyForCalls: false, readyForTexts: false, message: "This number isn't in Suprah's Telnyx account yet.", checkedAt };
    }
    const reference = number === normalizeDealershipNumber(telnyx.COMPANY_NUMBER) ? found : await referenceNumber();
    const expectedConnection = reference?.connectionId || '';
    const expectedProfile = telnyx.MESSAGING_PROFILE_ID || reference?.messagingProfileId || '';
    const active = !found.status || found.status === 'active';
    const readyForCalls = active && Boolean(found.connectionId) && (!expectedConnection || found.connectionId === expectedConnection);
    const readyForTexts = active && Boolean(found.messagingProfileId) && (!expectedProfile || found.messagingProfileId === expectedProfile);
    const problems: string[] = [];
    if (!active) problems.push(`Telnyx shows this number as "${found.status}".`);
    if (active && !readyForCalls) {
      problems.push(found.connectionId
        ? 'Calls to this number go to a different calling setup in Telnyx than the one Suprah uses.'
        : 'Calls to this number are not connected to Suprah in Telnyx yet.');
    }
    if (active && !readyForTexts) {
      problems.push(found.messagingProfileId
        ? 'Texts for this number use a different messaging profile in Telnyx than the one Suprah uses.'
        : 'Texting is not turned on for this number in Telnyx yet.');
    }
    return { status: readyForCalls && readyForTexts ? 'ready' : 'needs_setup', readyForCalls, readyForTexts, message: problems.join(' '), checkedAt };
  } catch (error) {
    if (error instanceof telnyx.LocalUiAcceptanceModeBlockedError) {
      return { status: 'unchecked', readyForCalls: false, readyForTexts: false, message: 'Telnyx is not checked on this test system.', checkedAt };
    }
    return { status: 'error', readyForCalls: false, readyForTexts: false, message: "Couldn't reach Telnyx to check this number. Try again in a few minutes.", checkedAt };
  }
}

async function assertNumberAvailable(organizationId: string, number: string, excludeId?: string) {
  const taken: any = await DealershipPhoneNumber.findOne({ number, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('organizationId').lean();
  if (taken) {
    throw new ApiError(409, String(taken.organizationId) === organizationId
      ? 'This number is already in your list.'
      : 'This number is already used by another dealership in Suprah.');
  }
  const routing: any = await CallRoutingConfig.findOne({ inboundNumber: number }).select('organizationId').lean();
  if (routing && String(routing.organizationId) !== organizationId) {
    throw new ApiError(409, 'This number is already used by another dealership in Suprah.');
  }
}

async function assertRingGroup(organizationId: string, ringGroupId: string | null) {
  if (!ringGroupId) return;
  const exists = await CrmLeadGroup.exists({ _id: ringGroupId, organizationId, isActive: true });
  if (!exists) throw new ApiError(400, 'Choose an active Lead Group for this number.');
}

function duplicateError(error: any): never {
  if (error?.code === 11000) {
    if (String(error?.message || '').includes('dealership_phone_one_main_per_org') || error?.keyPattern?.kind) {
      throw new ApiError(409, 'This dealership already has a main number. Change that one, or choose another type.');
    }
    throw new ApiError(409, 'This number is already used in Suprah.');
  }
  throw error;
}

export async function listDealershipNumbers(organizationId: string) {
  const rows = await DealershipPhoneNumber.find({ organizationId }).lean();
  const groupIds = rows.map((row) => row.ringGroupId).filter(Boolean);
  const groups = groupIds.length
    ? await CrmLeadGroup.find({ _id: { $in: groupIds }, organizationId }).select('name isActive').lean()
    : [];
  const names = new Map(groups.map((group: any) => [String(group._id), group.isActive ? group.name : '']));
  return rows
    .map((row) => ({ ...row, ringGroupName: row.ringGroupId ? names.get(String(row.ringGroupId)) || '' : '' }))
    .sort((a, b) => PHONE_NUMBER_KINDS.indexOf(a.kind) - PHONE_NUMBER_KINDS.indexOf(b.kind) || a.label.localeCompare(b.label));
}

export async function createDealershipNumber(organizationId: string, userId: string, raw: unknown) {
  const input = parsePhoneNumberInput(raw);
  await assertNumberAvailable(organizationId, input.number);
  await assertRingGroup(organizationId, input.ringGroupId);
  const telnyxCheck = await checkNumberInTelnyx(input.number);
  try {
    return (await DealershipPhoneNumber.create({ ...input, organizationId, telnyx: telnyxCheck, createdBy: userId, updatedBy: userId })).toObject();
  } catch (error) {
    duplicateError(error);
  }
}

export async function updateDealershipNumber(organizationId: string, id: string, userId: string, raw: unknown) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid phone number ID');
  const existing = await DealershipPhoneNumber.findOne({ _id: id, organizationId }).lean();
  if (!existing) throw new ApiError(404, 'Phone number not found');
  const input = parsePhoneNumberInput(raw);
  if (input.number !== existing.number) await assertNumberAvailable(organizationId, input.number, id);
  await assertRingGroup(organizationId, input.ringGroupId);
  const telnyxCheck = input.number !== existing.number ? await checkNumberInTelnyx(input.number) : existing.telnyx;
  try {
    return await DealershipPhoneNumber.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: { ...input, telnyx: telnyxCheck, updatedBy: userId } },
      { new: true, runValidators: true },
    ).lean();
  } catch (error) {
    duplicateError(error);
  }
}

export async function recheckDealershipNumber(organizationId: string, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid phone number ID');
  const existing = await DealershipPhoneNumber.findOne({ _id: id, organizationId }).select('number').lean();
  if (!existing) throw new ApiError(404, 'Phone number not found');
  resetTelnyxReferenceCache();
  const telnyxCheck = await checkNumberInTelnyx(existing.number);
  return DealershipPhoneNumber.findOneAndUpdate({ _id: id, organizationId }, { $set: { telnyx: telnyxCheck } }, { new: true }).lean();
}

export async function deleteDealershipNumber(organizationId: string, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid phone number ID');
  const removed = await DealershipPhoneNumber.findOneAndDelete({ _id: id, organizationId }).lean();
  if (!removed) throw new ApiError(404, 'Phone number not found');
  return removed;
}

export async function currentNumberSuggestion(organizationId: string) {
  const company = normalizeDealershipNumber(telnyx.COMPANY_NUMBER);
  if (!company) return null;
  const configured = String(process.env.COMM_ORG_ID || '').trim();
  if (configured && configured !== organizationId) return null;
  if (await DealershipPhoneNumber.exists({ number: company })) return null;
  const routing: any = await CallRoutingConfig.findOne({ inboundNumber: company }).select('organizationId').lean();
  if (routing && String(routing.organizationId) !== organizationId) return null;
  return { number: company };
}
