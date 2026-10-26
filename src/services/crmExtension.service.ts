import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import Organization from '../models/Organization.model';
import { ApiError } from '../utils/ApiError';
import { normalizeIdentityPhone } from '../utils/contactIdentity';
import { TERMINAL_LEAD_STATUSES } from '../constants/leadStatus';
import { normalizeLeadSourceForDisplay } from '../constants/leadSource';
import { resolveContactRestriction } from './contactRestriction.service';
import { isSmsOptedOut } from './communication.service';

const MAX_PHONE_INPUT = 40;
const MAX_MATCHES = 10;
const MAX_NOTES = 20;
const MAX_NOTE_LENGTH = 1000;

const orgObjectId = (orgId: string) => new mongoose.Types.ObjectId(orgId);

const latest = (...values: Array<Date | string | null | undefined>) => {
  const times = values.map((value) => (value ? new Date(value).getTime() : 0)).filter((time) => Number.isFinite(time) && time > 0);
  return times.length ? new Date(Math.max(...times)) : null;
};

export function displayPhone(normalized: string) {
  const [number, ext] = normalized.split(';ext=');
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  const base = us ? `(${us[1]}) ${us[2]}-${us[3]}` : number;
  return ext ? `${base} ext. ${ext}` : base;
}

export function normalizeLookupPhone(raw: unknown) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_PHONE_INPUT) return null;
  const cleaned = text.replace(/^tel:/i, '');
  if (!/^[0-9+().\-\s]+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return normalizeIdentityPhone(cleaned);
}

export async function lookupLeadsByPhone(orgId: string, rawPhone: unknown) {
  if (!orgId || !mongoose.isValidObjectId(orgId)) throw new ApiError(403, 'Your account is not linked to a dealership');
  const normalizedPhone = normalizeLookupPhone(rawPhone);
  if (!normalizedPhone) throw new ApiError(400, "That doesn't look like a complete phone number");

  const filter = { organizationId: orgObjectId(orgId), normalizedPhone };
  const [total, leads, organization, restriction, optedOut] = await Promise.all([
    Lead.countDocuments(filter).maxTimeMS(5000),
    Lead.find(filter)
      .select('firstName lastName status source sourceProvider channel vehicle assignedTo location createdAt updatedAt followUp.lastCustomerActivityAt notes._id customerId customerLink.status')
      .populate('assignedTo', 'name')
      .sort({ updatedAt: -1, _id: -1 })
      .limit(MAX_MATCHES)
      .maxTimeMS(5000)
      .lean(),
    Organization.findById(orgId).select('name').lean(),
    resolveContactRestriction({ organizationId: orgId, phone: normalizedPhone }),
    isSmsOptedOut(orgId, normalizedPhone).catch(() => null),
  ]);

  return {
    query: { normalizedPhone, displayPhone: displayPhone(normalizedPhone) },
    organization: { name: String((organization as any)?.name || '') },
    total,
    truncated: total > MAX_MATCHES,
    matches: (leads as any[]).map((lead) => {
      const source = normalizeLeadSourceForDisplay({ source: lead.source, sourceProvider: lead.sourceProvider, channel: lead.channel });
      return {
        id: String(lead._id),
        name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unnamed lead',
        status: lead.status || 'New',
        closed: TERMINAL_LEAD_STATUSES.includes(String(lead.status || '')),
        source: source.sourceProvider ? `${source.source} · ${source.sourceProvider}` : source.source,
        vehicle: [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model].filter(Boolean).join(' '),
        assignedTo: lead.assignedTo && typeof lead.assignedTo === 'object' ? String(lead.assignedTo.name || '') : '',
        location: String(lead.location || ''),
        createdAt: lead.createdAt,
        lastActivity: latest(lead.followUp?.lastCustomerActivityAt, lead.createdAt),
        noteCount: Array.isArray(lead.notes) ? lead.notes.length : 0,
        customerRecordId: lead.customerId && lead.customerLink?.status === 'linked' ? String(lead.customerId) : null,
      };
    }),
    contact: {
      doNotContact: restriction.status === 'restricted',
      restrictionUnknown: restriction.status === 'unavailable',
      textOptOut: optedOut === true,
    },
  };
}

export async function getLeadNotes(orgId: string, leadId: string) {
  if (!orgId || !mongoose.isValidObjectId(orgId) || !mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgObjectId(orgId) })
    .select('firstName lastName notes')
    .maxTimeMS(5000)
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  const notes = (Array.isArray(lead.notes) ? lead.notes : [])
    .filter((note: any) => note && typeof note.text === 'string')
    .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return {
    leadId: String(lead._id),
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unnamed lead',
    total: notes.length,
    notes: notes.slice(0, MAX_NOTES).map((note: any) => ({
      id: note._id ? String(note._id) : '',
      text: String(note.text).slice(0, MAX_NOTE_LENGTH),
      author: String(note.authorName || (note.authorType === 'ai' ? 'AI agent' : 'Team member')),
      byAi: note.authorType === 'ai',
      createdAt: note.createdAt || null,
    })),
  };
}
