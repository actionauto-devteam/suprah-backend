import mongoose from 'mongoose';
import { NURTURE_ELIGIBLE_STATUSES } from '../constants/leadStatus';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';
import { validateOutboundMessage } from '../utils/aiOutboundSafety';
import { Conversation } from '../models/communication.model';

const ACTIVE_INQUIRY_WINDOW_DAYS = parseInt(process.env.AI_AGENT_ACTIVE_INQUIRY_WINDOW_DAYS || '60', 10);
const RECENT_CONTEXT_WINDOW = 4;
const MAX_CANDIDATE_LEADS = 50;
const MAX_CLARIFY_LABELS = 3;
const MAX_LABEL_LENGTH = 60;
const MAX_SMS_LENGTH = 300;

export const CLARIFYING_QUESTION_MARKER = 'Just so I follow up on the right vehicle';

const GENERIC_MODEL_TOKENS = new Set([
  'sport', 'hybrid', 'plus', 'limited', 'premium', 'base', 'touring', 'platinum', 'awd', 'fwd', 'rwd',
  '4wd', '2wd', '4x4', '4x2', '4xe', 'edition', 'series', 'crew', 'cab', 'sedan', 'coupe', 'hatchback',
  'wagon', 'van', 'truck', 'suv', 'new', 'used', 'the', 'and', 'with', 'trim', 'double', 'quad', 'extended',
  'lariat', 'denali', 'xle', 'xlt', 'ltz', 'turbo', 'electric', 'diesel', 'convertible', 'utility',
]);

export interface InquiryTranscriptEntry {
  from: 'customer' | 'ai' | 'staff';
  body: string;
}

export interface VehicleInquiryCandidate {
  leadId: string;
  lead: any;
  vehicleKey: string;
  vehicleLabel: string;
  year: string;
  makeTokens: string[];
  modelTokens: string[];
}

export type VehicleContextResolution =
  | 'single'
  | 'new_inquiry'
  | 'pinned'
  | 'explicit_mention'
  | 'recent_context'
  | 'ambiguous';

export interface VehicleContextResult {
  resolution: VehicleContextResolution;
  lead: any | null;
  candidate: VehicleInquiryCandidate | null;
  candidates: VehicleInquiryCandidate[];
  ambiguousCandidates: VehicleInquiryCandidate[];
  multipleInquiries: boolean;
}

function idOf(value: any): string {
  return String(value?._id ?? value ?? '');
}

function splitWords(value: string): string[] {
  const words = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const word of words) {
    const joined = word.replace(/-/g, '');
    if (joined) out.add(joined);
    if (word.includes('-')) {
      for (const piece of word.split('-')) if (piece) out.add(piece);
    }
  }
  return Array.from(out);
}

function isDistinctiveModelToken(token: string): boolean {
  if (/^\d+$/.test(token)) return false;
  if (GENERIC_MODEL_TOKENS.has(token)) return false;
  if (/[a-z]/.test(token) && /\d/.test(token)) return token.length >= 2;
  return token.length >= 3;
}

function titleCaseLabel(label: string): string {
  const letters = label.replace(/[^A-Za-z]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return label;
  return label
    .split(' ')
    .map((word) => {
      if (/\d/.test(word) || word.length <= 3) return word;
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(' ');
}

export function formatVehicleLabel(vehicle: any): string {
  if (!vehicle) return '';
  const raw = [vehicle.year, vehicle.make, vehicle.model]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  if (!raw) return '';
  return titleCaseLabel(raw).slice(0, MAX_LABEL_LENGTH).trim();
}

export function buildVehicleCandidate(lead: any): VehicleInquiryCandidate | null {
  const vehicle = lead?.vehicle;
  const make = String(vehicle?.make || '').trim();
  const model = String(vehicle?.model || '').trim();
  if (!make && !model) return null;
  const makeTokens = splitWords(make).filter((token) => token.length >= 3 || /\d/.test(token));
  const modelTokens = splitWords(model).filter(isDistinctiveModelToken);
  if (!makeTokens.length && !modelTokens.length) return null;
  const year = String(vehicle?.year || '').trim();
  return {
    leadId: idOf(lead),
    lead,
    vehicleKey: [year, splitWords(make).join(' '), splitWords(model).join(' ')].join('|'),
    vehicleLabel: formatVehicleLabel(vehicle),
    year,
    makeTokens,
    modelTokens,
  };
}

function leadRecency(lead: any): number {
  const time = new Date(lead?.updatedAt || lead?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function groupDistinctVehicles(leads: any[], preferredLeadId?: string): VehicleInquiryCandidate[] {
  const byKey = new Map<string, VehicleInquiryCandidate>();
  const ordered = [...leads].sort((a, b) => leadRecency(b) - leadRecency(a));
  for (const lead of ordered) {
    const candidate = buildVehicleCandidate(lead);
    if (!candidate) continue;
    const existing = byKey.get(candidate.vehicleKey);
    if (!existing || (preferredLeadId && candidate.leadId === preferredLeadId)) {
      byKey.set(candidate.vehicleKey, candidate);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => leadRecency(b.lead) - leadRecency(a.lead));
}

export function matchVehicleMention(text: string, candidates: VehicleInquiryCandidate[]): VehicleInquiryCandidate[] {
  const words = new Set(splitWords(text));
  if (!words.size || !candidates.length) return [];

  const scored = candidates.map((candidate) => {
    const modelHits = candidate.modelTokens.filter((token) => words.has(token)).length;
    const makeHit = candidate.makeTokens.some((token) => words.has(token));
    const yearHit = Boolean(candidate.year) && words.has(candidate.year.toLowerCase());
    return { candidate, modelHits, makeHit, score: modelHits * 2 + (makeHit ? 1 : 0) + (yearHit ? 1 : 0) };
  });

  const modelMatched = scored.filter((entry) => entry.modelHits > 0);
  const explainedMakes = new Set(modelMatched.flatMap((entry) => entry.candidate.makeTokens));
  const makeOnly = scored.filter(
    (entry) => entry.modelHits === 0 && entry.makeHit && !entry.candidate.makeTokens.some((token) => explainedMakes.has(token)),
  );

  if (modelMatched.length && makeOnly.length) {
    return [...modelMatched, ...makeOnly].map((entry) => entry.candidate);
  }
  if (makeOnly.length) return makeOnly.map((entry) => entry.candidate);
  if (!modelMatched.length) return [];

  const top = Math.max(...modelMatched.map((entry) => entry.score));
  return modelMatched.filter((entry) => entry.score === top).map((entry) => entry.candidate);
}

function latestCustomerIndex(transcript: InquiryTranscriptEntry[]): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].from === 'customer') return i;
  }
  return -1;
}

export function resolveVehicleInquiry(input: {
  leads: any[];
  triggerLead: any;
  isNewInquiry?: boolean;
  pinToTriggerLead?: boolean;
  transcript: InquiryTranscriptEntry[];
}): VehicleContextResult {
  const triggerLeadId = idOf(input.triggerLead);
  const allLeads = input.leads.some((lead) => idOf(lead) === triggerLeadId)
    ? input.leads
    : [input.triggerLead, ...input.leads];
  const candidates = groupDistinctVehicles(allLeads, triggerLeadId);
  const triggerCandidate = buildVehicleCandidate(input.triggerLead);
  const multipleInquiries = candidates.length > 1;

  const resolved = (resolution: VehicleContextResolution, candidate: VehicleInquiryCandidate | null, lead: any): VehicleContextResult => ({
    resolution,
    lead,
    candidate,
    candidates,
    ambiguousCandidates: [],
    multipleInquiries,
  });

  if (input.isNewInquiry) return resolved('new_inquiry', triggerCandidate, input.triggerLead);
  if (!multipleInquiries) return resolved('single', triggerCandidate, input.triggerLead);
  if (input.pinToTriggerLead) return resolved('pinned', triggerCandidate, input.triggerLead);

  const latestIndex = latestCustomerIndex(input.transcript);
  const latestText = latestIndex >= 0 ? input.transcript[latestIndex].body : '';
  const explicit = matchVehicleMention(latestText, candidates);
  if (explicit.length === 1) return resolved('explicit_mention', explicit[0], explicit[0].lead);
  if (explicit.length > 1) {
    return { ...resolved('ambiguous', null, null), ambiguousCandidates: explicit };
  }

  const start = latestIndex >= 0 ? latestIndex - 1 : input.transcript.length - 1;
  const stop = Math.max(0, start - RECENT_CONTEXT_WINDOW + 1);
  for (let i = start; i >= stop; i--) {
    const matches = matchVehicleMention(input.transcript[i].body, candidates);
    if (matches.length === 1) return resolved('recent_context', matches[0], matches[0].lead);
    if (matches.length > 1) return { ...resolved('ambiguous', null, null), ambiguousCandidates: matches };
  }

  return { ...resolved('ambiguous', null, null), ambiguousCandidates: candidates };
}

export function isClarifyingQuestion(text: string): boolean {
  return String(text || '').includes(CLARIFYING_QUESTION_MARKER);
}

export function lastAiMessageWasClarifyingQuestion(transcript: InquiryTranscriptEntry[]): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].from === 'ai') return isClarifyingQuestion(transcript[i].body);
    if (transcript[i].from === 'staff') return false;
  }
  return false;
}

function joinVehicleOptions(labels: string[], hasMore: boolean): string {
  const items = labels.map((label) => `the ${label}`);
  if (hasMore) items.push('another vehicle');
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

export function buildClarifyingQuestion(input: {
  candidates: VehicleInquiryCandidate[];
  customerFirstName?: string;
  agentName: string;
  dealerName: string;
  isFirstReply?: boolean;
}): string | null {
  const labels = input.candidates.map((candidate) => candidate.vehicleLabel).filter(Boolean);
  if (labels.length < 2) return null;
  const firstName = String(input.customerFirstName || '').trim().split(/\s+/)[0] || '';

  const intro = input.isFirstReply
    ? `Hi${firstName ? ` ${firstName}` : ''}, this is ${input.agentName} with ${input.dealerName}! `
    : `Thanks${firstName ? `, ${firstName}` : ''}! `;

  const attempts: Array<{ intro: string; count: number }> = [
    { intro, count: MAX_CLARIFY_LABELS },
    { intro, count: 2 },
    { intro: '', count: 2 },
  ];
  for (const attempt of attempts) {
    const shown = labels.slice(0, attempt.count);
    const options = joinVehicleOptions(shown, labels.length > shown.length);
    const text = `${attempt.intro}${CLARIFYING_QUESTION_MARKER} — are you asking about ${options}?`;
    if (text.length <= MAX_SMS_LENGTH && validateOutboundMessage(text).ok) return text;
  }
  return null;
}

export function buildVehicleContextNote(result: VehicleContextResult): string | undefined {
  if (!result.multipleInquiries) return undefined;
  const target = result.candidate;
  const others = result.candidates
    .filter((candidate) => !target || candidate.vehicleKey !== target.vehicleKey)
    .map((candidate) => candidate.vehicleLabel)
    .filter(Boolean);
  const othersText = others.length ? ` (${others.join('; ')})` : '';

  if (target?.vehicleLabel) {
    return [
      `This customer has separate vehicle inquiries with the dealership. This message is about the ${target.vehicleLabel} only.`,
      `Earlier messages in the transcript may be about their other vehicles${othersText} — do not mention, confuse, or mix in details about those other vehicles.`,
      `Refer to the ${target.vehicleLabel} by name so it is clear which vehicle you mean.`,
    ].join(' ');
  }
  return [
    `This customer has separate vehicle inquiries with the dealership${othersText}.`,
    'Do not assume this message is about any of those vehicles, and do not mention them.',
  ].join(' ');
}

export async function loadPhoneLeads(
  organizationId: any,
  phone: string,
  opts: { activeOnly?: boolean } = {},
): Promise<any[]> {
  const normalizedPhone = normalizeIdentityPhone(phone);
  if (!organizationId || !normalizedPhone) return [];
  let LeadModel: mongoose.Model<any>;
  try { LeadModel = mongoose.model('Lead'); } catch { return []; }

  const filter: any = {
    organizationId,
    $or: [{ normalizedPhone }, { normalizedPhone: null }],
  };
  if (opts.activeOnly) {
    const since = new Date(Date.now() - ACTIVE_INQUIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    filter.status = { $in: NURTURE_ELIGIBLE_STATUSES };
    filter.$and = [{ $or: [{ createdAt: { $gte: since } }, { updatedAt: { $gte: since } }] }];
  }

  const docs: any[] = await LeadModel.find(filter)
    .select('_id firstName lastName phone vehicle status assignedTo createdAt updatedAt')
    .sort({ updatedAt: -1, _id: -1 })
    .limit(MAX_CANDIDATE_LEADS)
    .maxTimeMS(5000)
    .lean();
  return docs.filter((doc) => normalizeIdentityPhone(doc.phone) === normalizedPhone);
}

export async function loadEmailLeads(
  organizationId: any,
  email: string,
  opts: { activeOnly?: boolean } = {},
): Promise<any[]> {
  const normalizedEmail = normalizeIdentityEmail(email);
  if (!organizationId || !normalizedEmail) return [];
  let LeadModel: mongoose.Model<any>;
  try { LeadModel = mongoose.model('Lead'); } catch { return []; }

  const filter: any = { organizationId, normalizedEmail };
  if (opts.activeOnly) {
    const since = new Date(Date.now() - ACTIVE_INQUIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    filter.status = { $in: NURTURE_ELIGIBLE_STATUSES };
    filter.$or = [{ createdAt: { $gte: since } }, { updatedAt: { $gte: since } }];
  }

  return LeadModel.find(filter)
    .select('_id firstName lastName phone email vehicle status assignedTo createdAt updatedAt')
    .sort({ updatedAt: -1, _id: -1 })
    .limit(MAX_CANDIDATE_LEADS)
    .maxTimeMS(5000)
    .lean();
}

export async function loadContactLeads(
  organizationId: any,
  contact: { phone?: string; email?: string },
  opts: { activeOnly?: boolean } = {},
): Promise<any[]> {
  const [byPhone, byEmail] = await Promise.all([
    contact.phone ? loadPhoneLeads(organizationId, contact.phone, opts).catch(() => []) : Promise.resolve([]),
    contact.email ? loadEmailLeads(organizationId, contact.email, opts).catch(() => []) : Promise.resolve([]),
  ]);
  const byId = new Map<string, any>();
  for (const lead of [...byPhone, ...byEmail]) byId.set(idOf(lead), lead);
  return Array.from(byId.values());
}

export async function resolvePinnedVehicleContext(input: {
  organizationId: any;
  lead: any;
  phone?: string;
  email?: string;
}): Promise<VehicleContextResult> {
  let leads: any[] = [];
  try {
    leads = await loadContactLeads(
      input.organizationId,
      { phone: input.phone ?? input.lead?.phone, email: input.email ?? input.lead?.email },
      { activeOnly: true },
    );
  } catch {
    leads = [];
  }
  return resolveVehicleInquiry({ leads, triggerLead: input.lead, pinToTriggerLead: true, transcript: [] });
}

export async function latestSharedConversationActivity(organizationId: any, phone: string): Promise<Date | null> {
  const customerPhone = normalizeIdentityPhone(phone);
  if (!organizationId || !customerPhone) return null;
  const conversation: any = await Conversation.findOne({ orgId: organizationId, customerPhone })
    .select('lastMessageAt')
    .lean();
  const at = conversation?.lastMessageAt ? new Date(conversation.lastMessageAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

export async function resolveVehicleContextForReply(input: {
  organizationId: any;
  phone: string;
  triggerLead: any;
  isNewInquiry?: boolean;
  transcript: InquiryTranscriptEntry[];
}): Promise<VehicleContextResult> {
  let leads: any[] = [];
  try {
    leads = await loadPhoneLeads(input.organizationId, input.phone, { activeOnly: true });
  } catch {
    leads = [];
  }
  return resolveVehicleInquiry({
    leads,
    triggerLead: input.triggerLead,
    isNewInquiry: input.isNewInquiry,
    transcript: input.transcript,
  });
}

export interface InquiryScopeInfo {
  inquiryScope: 'this_inquiry' | 'shared';
  relatedLeadId?: string;
  relatedVehicleLabel?: string;
}

export function classifyInquiryScope(
  item: { leadId?: any; body?: string },
  viewedLead: any,
  siblingLeads: any[],
): InquiryScopeInfo | null {
  const viewedLeadId = idOf(viewedLead);
  const siblings = siblingLeads.filter((lead) => idOf(lead) !== viewedLeadId);
  if (!siblings.length) return null;

  const itemLeadId = item.leadId ? idOf(item.leadId) : '';
  if (itemLeadId && itemLeadId !== viewedLeadId) {
    const related = siblings.find((lead) => idOf(lead) === itemLeadId);
    return {
      inquiryScope: 'shared',
      relatedLeadId: itemLeadId,
      relatedVehicleLabel: related ? formatVehicleLabel(related.vehicle) || undefined : undefined,
    };
  }

  if (item.body) {
    const candidates = groupDistinctVehicles([viewedLead, ...siblings], viewedLeadId);
    const viewedCandidate = buildVehicleCandidate(viewedLead);
    const matches = matchVehicleMention(item.body, candidates);
    if (matches.length === 1 && (!viewedCandidate || matches[0].vehicleKey !== viewedCandidate.vehicleKey)) {
      return {
        inquiryScope: 'shared',
        relatedLeadId: matches[0].leadId,
        relatedVehicleLabel: matches[0].vehicleLabel || undefined,
      };
    }
  }

  return { inquiryScope: 'this_inquiry' };
}
