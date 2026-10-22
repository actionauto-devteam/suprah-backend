import AiKnowledgeEntry from '../models/AiKnowledgeEntry.model';
import AiTrainingImportItem from '../models/AiTrainingImportItem.model';
import AiTrainingImportContent from '../models/AiTrainingImportContent.model';
import AiTrainingImportBatch from '../models/AiTrainingImportBatch.model';
import { AiKnowledgeVerifiedDetail } from '../models/AiKnowledgeVerifiedDetail.model';
import type { KnowledgeEntryKind, KnowledgeLocationScope } from '../models/AiKnowledgeEntry.model';
import logger from '../utils/logger';
import {
  buildImportSourceLink,
  createKnowledgeEntry,
  knowledgeKey,
  knowledgeStorableIssues,
  parseKnowledgeInput,
  resolveKnowledgeBaseAvailability,
  saveKnowledgeVersion,
  scopesOverlap,
} from './aiKnowledgeBase.service';
import { knowledgeContactValues, knowledgeContentCheck, privacyErrors, type KnowledgeCheckContext, type KnowledgeIssue } from './aiKnowledgeSafety';
import { knowledgeReviewContext, knowledgeSaveContext } from './aiKnowledgeVerifiedDetails.service';
import type { BusinessContactSets } from './aiTrainingImportScreening';

export type KnowledgeImportState = 'saved' | 'ready' | 'needs_contact_verification' | 'needs_attention' | 'newer_saved' | 'knowledge_base_off';

export interface KnowledgeImportStatus {
  state: KnowledgeImportState;
  message: string;
  entryId?: string;
  entryStatus?: string;
  entryLifecycle?: string;
}

export interface KnowledgeImportResult extends KnowledgeImportStatus {
  itemId: string;
  rowNumber: number;
  title?: string;
}

export interface KnowledgePreviewRow {
  kind: string;
  topic?: string;
  title?: string;
  question?: string;
  answer?: string;
  channels?: string[];
  scope: { kind: 'all' | 'location' | 'none'; locationId?: string };
  sourceKey?: string;
  changedSinceBatch?: number;
}

export interface KnowledgePreviewNote {
  code: 'knowledge_contact_unverified' | 'knowledge_similar_entry' | 'knowledge_entry_inactive' | 'knowledge_revision' | 'knowledge_new_draft';
  severity: 'warning' | 'info';
  message: string;
}

export const KNOWLEDGE_PREVIEW_CODES = new Set<string>(['knowledge_contact_unverified', 'knowledge_similar_entry', 'knowledge_entry_inactive', 'knowledge_revision', 'knowledge_new_draft']);

const KNOWLEDGE_TYPES = ['faq', 'business_info'];
const CONTACT_WORDS: Record<string, string> = { real_phone: 'phone number', real_email: 'email address', real_link: 'website' };
const OFF_SERVER = "The Knowledge Base isn't available on this server yet, so this item stays as a candidate.";
const OFF_ORG = 'The Knowledge Base is turned off for this organization. An admin can turn it on in the Knowledge Base tab, then save this item again from the import details.';
const MISSING_ORIGINAL = "The original Podium text is no longer stored, so this item can't be saved. Import it again.";
const INACTIVE_ENTRY = "Its Knowledge Base entry is turned off or archived, so it wasn't updated. Turn the entry back on or restore it, then save this item again.";
const NEWER_SAVED = 'A newer import of this item is already in the Knowledge Base.';
const READY_CREATE = 'Ready to save as a Knowledge Base draft.';
const READY_REVISE = 'Ready: saving adds a new draft version to its Knowledge Base entry. The approved version stays until the change is approved.';
const SAVED = 'Saved to the Knowledge Base.';
const SAVE_FAILED = 'Something went wrong while saving this item. Try again.';

export function contactVerificationMessage(issues: KnowledgeIssue[], options: { pending?: boolean; preview?: boolean } = {}): string | null {
  const words = Array.from(new Set(issues.map((issue) => CONTACT_WORDS[issue.code]).filter(Boolean)));
  if (!words.length) return null;
  const list = words.length === 1 ? `a ${words[0]}` : `a ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  const one = words.length === 1;
  if (options.pending) {
    return options.preview
      ? `This answer has ${list} that ${one ? 'is' : 'are'} waiting for approval in Verified contacts. The item is kept and can become a draft after another manager or admin approves ${one ? 'it' : 'them'}.`
      : `This answer has ${list} that ${one ? 'is' : 'are'} waiting for approval in Verified contacts. After another manager or admin approves ${one ? 'it' : 'them'}, save this item again.`;
  }
  return options.preview
    ? `This answer has ${list} that ${one ? "isn't" : "aren't"} approved in Verified contacts for this location yet. The item is kept and can become a draft after ${one ? 'it is' : 'they are'} added and approved.`
    : `This answer has ${list} that ${one ? "isn't" : "aren't"} approved in Verified contacts for this location yet. Add ${one ? 'it' : 'them'} in Knowledge Base → Verified contacts & programs, then save this item again.`;
}

export function statusFromIssues(issues: KnowledgeIssue[], pending = false): KnowledgeImportStatus {
  const contacts = contactVerificationMessage(issues, { pending });
  if (contacts) return { state: 'needs_contact_verification', message: contacts };
  return { state: 'needs_attention', message: issues[0]?.message || SAVE_FAILED };
}

export function mentionsContact(text: string, contacts: BusinessContactSets): boolean {
  const values = knowledgeContactValues(text);
  for (const phone of values.phones) if (contacts.phones.has(phone)) return true;
  for (const email of values.emails) if (contacts.emails.has(email)) return true;
  for (const domain of values.domains) if (contacts.domains.has(domain)) return true;
  return false;
}

async function pendingContacts(organizationId: string): Promise<BusinessContactSets> {
  const rows: any[] = await AiKnowledgeVerifiedDetail.find({ organizationId, status: 'pending', kind: { $in: ['phone', 'email', 'website'] } })
    .select('kind normalizedValue').limit(1000).lean();
  const sets: BusinessContactSets = { phones: new Set(), emails: new Set(), domains: new Set() };
  for (const row of rows) {
    if (row.kind === 'phone') sets.phones.add(row.normalizedValue);
    else if (row.kind === 'email') sets.emails.add(row.normalizedValue);
    else sets.domains.add(row.normalizedValue);
  }
  return sets;
}

async function approvedContactContext(organizationId: string, scope: KnowledgeLocationScope | null): Promise<KnowledgeCheckContext> {
  if (scope) return (await knowledgeReviewContext(organizationId, scope, null)).context;
  const rows: any[] = await AiKnowledgeVerifiedDetail.find({ organizationId, status: 'approved', kind: { $in: ['phone', 'email', 'website'] } })
    .select('kind normalizedValue').limit(1000).lean();
  const sets: BusinessContactSets = { phones: new Set(), emails: new Set(), domains: new Set() };
  for (const row of rows) {
    if (row.kind === 'phone') sets.phones.add(row.normalizedValue);
    else if (row.kind === 'email') sets.emails.add(row.normalizedValue);
    else sets.domains.add(row.normalizedValue);
  }
  return { contacts: sets };
}

export function knowledgeScopeForImport(scope: { kind?: string; locationId?: unknown } | undefined): KnowledgeLocationScope | null {
  if (scope?.kind === 'all') return { scope: 'all', locationIds: [] };
  if (scope?.kind === 'location' && scope.locationId) return { scope: 'locations', locationIds: [String(scope.locationId)] as any };
  return null;
}

export function knowledgeBodyForImport(payload: any, scope: KnowledgeLocationScope | null, batchNumber: number | undefined, revision: boolean): Record<string, unknown> {
  const label = batchNumber ? `import #${batchNumber}` : 'an import';
  return {
    kind: payload?.kind,
    topic: payload?.topic,
    title: payload?.title,
    question: payload?.content?.question,
    answer: payload?.content?.answer,
    channels: payload?.channels,
    locations: scope ? { scope: scope.scope, ...(scope.scope === 'locations' ? { locationIds: scope.locationIds.map(String) } : {}) } : undefined,
    changeNote: revision ? `Updated from Podium ${label}` : `Imported from Podium, ${label}`,
  };
}

function availabilityMessage(availability: { serverEnabled: boolean }): string {
  return availability.serverEnabled ? OFF_ORG : OFF_SERVER;
}

function savedStatus(entry: any): KnowledgeImportStatus {
  return { state: 'saved', message: SAVED, entryId: String(entry._id), entryStatus: entry.status, entryLifecycle: entry.lifecycle };
}

export function mergeContactSets(base: BusinessContactSets, extra?: BusinessContactSets): BusinessContactSets {
  if (!extra) return base;
  return {
    phones: new Set([...base.phones, ...extra.phones]),
    emails: new Set([...base.emails, ...extra.emails]),
    domains: new Set([...base.domains, ...extra.domains]),
  };
}

export async function knowledgeImportContext(organizationId: string): Promise<{ enabled: boolean; context?: KnowledgeCheckContext }> {
  const availability = await resolveKnowledgeBaseAvailability(organizationId);
  if (!availability.enabled) return { enabled: false };
  return { enabled: true, context: await knowledgeSaveContext(organizationId) };
}

export async function knowledgePreviewNotes(organizationId: string, rows: KnowledgePreviewRow[]): Promise<KnowledgePreviewNote[][]> {
  const pending = await pendingContacts(organizationId);
  const keys = Array.from(new Set(rows.map((row) => row.sourceKey).filter(Boolean))) as string[];
  const linked: any[] = keys.length
    ? await AiKnowledgeEntry.find({ organizationId, 'source.sourceKey': { $in: keys } }).select('source.sourceKey lifecycle status title').lean()
    : [];
  const byKey = new Map(linked.map((entry) => [String(entry.source?.sourceKey), entry]));
  const notes: KnowledgePreviewNote[][] = [];
  for (const row of rows) {
    const found: KnowledgePreviewNote[] = [];
    const scope = knowledgeScopeForImport(row.scope);
    const content = { kind: row.kind, topic: row.topic || 'general', title: row.title || '', question: row.question, answer: row.answer || '', channels: row.channels || [], locationScope: scope || { scope: 'all', locationIds: [] } };
    const approved = await approvedContactContext(organizationId, scope);
    const text = [content.title, content.question, content.answer].filter(Boolean).join('\n');
    const contacts = contactVerificationMessage(privacyErrors(knowledgeContentCheck(content as any, approved)), { pending: mentionsContact(text, pending), preview: true });
    if (contacts) found.push({ code: 'knowledge_contact_unverified', severity: 'warning', message: contacts });
    const existing = row.sourceKey ? byKey.get(row.sourceKey) : undefined;
    if (existing && existing.lifecycle !== 'active') {
      found.push({ code: 'knowledge_entry_inactive', severity: 'warning', message: INACTIVE_ENTRY });
    } else if (existing && row.changedSinceBatch) {
      found.push({ code: 'knowledge_revision', severity: 'info', message: `This changed since import #${row.changedSinceBatch}. Saving adds a new draft version to its Knowledge Base entry. The approved version stays until the change is approved.` });
    } else if (row.changedSinceBatch) {
      found.push({ code: 'knowledge_new_draft', severity: 'info', message: `This changed since import #${row.changedSinceBatch}. It will be saved as a new Knowledge Base draft.` });
    }
    if (scope && (row.question || row.title)) {
      const key = knowledgeKey({ kind: row.kind, topic: content.topic, title: content.title, question: row.question });
      const similar: any[] = key
        ? await AiKnowledgeEntry.find({ organizationId, kind: row.kind, questionKey: key, lifecycle: { $ne: 'archived' }, 'source.system': { $ne: 'podium_import' } })
          .select('title locationScope').limit(20).lean()
        : [];
      const match = similar.find((entry) => scopesOverlap(scope, entry.locationScope));
      if (match) {
        found.push({ code: 'knowledge_similar_entry', severity: 'warning', message: `Similar to the Knowledge Base entry "${match.title}". Both are kept, and a reviewer decides which one to use.` });
      }
    }
    notes.push(found);
  }
  return notes;
}

interface LoadedContext {
  availability: { serverEnabled: boolean; orgEnabled: boolean; enabled: boolean };
  pending: BusinessContactSets;
  contents: Map<string, any>;
  byItem: Map<string, any>;
  byKey: Map<string, any>;
  batchNumbers: Map<string, number>;
}

async function loadContext(organizationId: string, items: any[]): Promise<LoadedContext> {
  const availability = await resolveKnowledgeBaseAvailability(organizationId);
  const ids = items.map((item) => item._id);
  const keys = Array.from(new Set(items.map((item) => item.sourceKey).filter(Boolean)));
  const batchIds = Array.from(new Set(items.map((item) => String(item.batchId))));
  const [entries, contents, batches, pending]: any[] = await Promise.all([
    ids.length || keys.length
      ? AiKnowledgeEntry.find({ organizationId, $or: [{ 'source.importItemId': { $in: ids } }, ...(keys.length ? [{ 'source.sourceKey': { $in: keys } }] : [])] })
        .select('_id status lifecycle currentVersion source').lean()
      : Promise.resolve([]),
    ids.length ? AiTrainingImportContent.find({ organizationId, itemId: { $in: ids } }).select('itemId mappedPayload').lean() : Promise.resolve([]),
    batchIds.length ? AiTrainingImportBatch.find({ organizationId, _id: { $in: batchIds } }).select('batchNumber').lean() : Promise.resolve([]),
    pendingContacts(organizationId),
  ]);
  const byItem = new Map<string, any>();
  const byKey = new Map<string, any>();
  for (const entry of entries) {
    if (entry.source?.importItemId) byItem.set(String(entry.source.importItemId), entry);
    if (entry.source?.sourceKey) byKey.set(String(entry.source.sourceKey), entry);
  }
  return {
    availability,
    pending,
    contents: new Map(contents.map((row: any) => [String(row.itemId), row])),
    byItem,
    byKey,
    batchNumbers: new Map(batches.map((batch: any) => [String(batch._id), Number(batch.batchNumber)])),
  };
}

interface Plan {
  status: KnowledgeImportStatus;
  action?: 'create' | 'revise';
  body?: Record<string, unknown>;
  existing?: any;
}

async function planItem(organizationId: string, item: any, ctx: LoadedContext): Promise<Plan> {
  const linked = ctx.byItem.get(String(item._id));
  if (linked) return { status: savedStatus(linked) };
  if (!ctx.availability.enabled) return { status: { state: 'knowledge_base_off', message: availabilityMessage(ctx.availability) } };
  const existing = item.sourceKey ? ctx.byKey.get(String(item.sourceKey)) : undefined;
  if (existing && Number(existing.source?.keyRevision || 0) >= Number(item.keyRevision || 0)) {
    return { status: { state: 'newer_saved', message: NEWER_SAVED, entryId: String(existing._id), entryStatus: existing.status, entryLifecycle: existing.lifecycle } };
  }
  const content = ctx.contents.get(String(item._id));
  if (!content?.mappedPayload || content.mappedPayload.target !== 'knowledge_entry') return { status: { state: 'needs_attention', message: MISSING_ORIGINAL } };
  if (existing && existing.lifecycle !== 'active') {
    return { status: { state: 'needs_attention', message: INACTIVE_ENTRY, entryId: String(existing._id), entryStatus: existing.status, entryLifecycle: existing.lifecycle } };
  }
  const body = knowledgeBodyForImport(content.mappedPayload, knowledgeScopeForImport(item.locationScope), ctx.batchNumbers.get(String(item.batchId)), Boolean(existing));
  let parsed;
  try {
    parsed = parseKnowledgeInput(body, item.type as KnowledgeEntryKind);
  } catch (err: any) {
    return { status: statusFromIssues(Array.isArray(err?.errors) ? err.errors : []) };
  }
  const approved = await approvedContactContext(organizationId, parsed.content.locationScope);
  const { locations, privacy } = await knowledgeStorableIssues(organizationId, parsed.content, approved);
  if (locations.length) return { status: statusFromIssues(locations) };
  if (privacy.length) {
    const text = [parsed.content.title, parsed.content.question, parsed.content.answer].filter(Boolean).join('\n');
    return { status: statusFromIssues(privacy, mentionsContact(text, ctx.pending)) };
  }
  return existing
    ? { status: { state: 'ready', message: READY_REVISE, entryId: String(existing._id), entryStatus: existing.status, entryLifecycle: existing.lifecycle }, action: 'revise', body, existing }
    : { status: { state: 'ready', message: READY_CREATE }, action: 'create', body };
}

function knowledgeItems(items: any[]): any[] {
  return items.filter((item) => item.status === 'parked_knowledge' && KNOWLEDGE_TYPES.includes(item.type));
}

export async function knowledgeImportStatuses(organizationId: string, items: any[]): Promise<{ enabled: boolean; statuses: Map<string, KnowledgeImportStatus> }> {
  const candidates = knowledgeItems(items);
  const statuses = new Map<string, KnowledgeImportStatus>();
  if (!candidates.length) return { enabled: false, statuses };
  const ctx = await loadContext(organizationId, candidates);
  for (const item of candidates) statuses.set(String(item._id), (await planItem(organizationId, item, ctx)).status);
  return { enabled: ctx.availability.enabled, statuses };
}

export async function saveImportBatchToKnowledge(input: { organizationId: string; user: any; batchId: string }) {
  const { organizationId, user } = input;
  const items = knowledgeItems(await AiTrainingImportItem.find({ organizationId, batchId: input.batchId, status: 'parked_knowledge' }).sort({ rowNumber: 1 }).limit(500).lean());
  const counts: Record<KnowledgeImportState, number> = { saved: 0, ready: 0, needs_contact_verification: 0, needs_attention: 0, newer_saved: 0, knowledge_base_off: 0 };
  const results: KnowledgeImportResult[] = [];
  if (!items.length) return { enabled: true, created: 0, updated: 0, counts, results };
  const ctx = await loadContext(organizationId, items);
  let created = 0;
  let updated = 0;
  for (const item of items) {
    const plan = await planItem(organizationId, item, ctx);
    let status = plan.status;
    if (plan.action && plan.body) {
      try {
        const link = await buildImportSourceLink(organizationId, String(item._id));
        const entry = plan.action === 'create'
          ? await createKnowledgeEntry({ organizationId, user, body: plan.body, importLink: link })
          : await saveKnowledgeVersion({ organizationId, entryId: String(plan.existing._id), user, body: { ...plan.body, expectedVersion: plan.existing.currentVersion }, importLink: link });
        status = savedStatus(entry);
        if (plan.action === 'create') created += 1;
        else updated += 1;
      } catch (err: any) {
        const again: any = await AiKnowledgeEntry.findOne({ organizationId, 'source.importItemId': item._id }).select('_id status lifecycle').lean();
        if (again) status = savedStatus(again);
        else if (Array.isArray(err?.errors) && err.errors.length) status = statusFromIssues(err.errors);
        else if (err?.statusCode && err.statusCode < 500) status = { state: 'needs_attention', message: err.message || SAVE_FAILED };
        else {
          logger.error({ organizationId, itemId: String(item._id), errorName: err?.name }, '[KnowledgeImport] Could not save an import item to the Knowledge Base');
          status = { state: 'needs_attention', message: SAVE_FAILED };
        }
      }
    }
    counts[status.state] += 1;
    results.push({ itemId: String(item._id), rowNumber: item.rowNumber, title: item.title || undefined, ...status });
  }
  return { enabled: ctx.availability.enabled, message: ctx.availability.enabled ? undefined : availabilityMessage(ctx.availability), created, updated, counts, results };
}
