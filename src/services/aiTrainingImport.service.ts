import crypto from 'crypto';
import mongoose, { ClientSession } from 'mongoose';
import AiTrainingImportBatch, { IMPORT_MODES, ImportMode } from '../models/AiTrainingImportBatch.model';
import AiTrainingImportItem, {
  IMPORT_ITEM_STATUSES,
  ImportItemStatus,
  ImportRetentionClass,
  ImportTargetKind,
} from '../models/AiTrainingImportItem.model';
import AiTrainingImportContent from '../models/AiTrainingImportContent.model';
import AiTrainingPolicy from '../models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../models/AiTrainingAuditLog.model';
import AiAgentCoachingRule from '../models/AiAgentCoachingRule.model';
import CrmLocation from '../models/CrmLocation.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import {
  appendPolicyVersion,
  auditEntry,
  canReviewTraining,
  createPolicyWithFirstVersion,
  flushPolicyAudit,
  requireTrainingEnabled,
  runTrainingWrite,
  trainingActor,
  trainingRole,
} from './aiTraining.service';
import { evaluateStructuredRule, parseStructuredRule, specFromRule, STRUCTURED_RULE_LIMITS, StructuredRule } from './aiTrainingRules.service';
import { wordOverlap } from './aiTrainingLabEvaluator';
import { locationLabelIssues, normalizeLocationKey } from './crmLocation.service';
import { CanonicalRow, CanonicalValues, IMPORT_LIMITS, ImportIssue, parseImportSource, ParsedImportSource } from './aiTrainingImportParser';
import {
  avoidItemIssues,
  BusinessContactSets,
  FREE_MAIL_DOMAINS,
  GuardrailClass,
  guardrailIssues,
  maskText,
  normalizePhoneDigits,
  privacyIssues,
  protectedQuestionIssues,
  safetyIssues,
} from './aiTrainingImportScreening';
import {
  KNOWLEDGE_PREVIEW_CODES,
  knowledgeImportContext,
  knowledgeImportStatuses,
  knowledgePreviewNotes,
  mergeContactSets,
  type KnowledgeImportState,
  type KnowledgeImportStatus,
} from './aiKnowledgeImport.service';

export const IMPORT_ENGINE_VERSION = 'training-import-1.0.0';
export const IMPORT_RETENTION_DAYS: Record<ImportRetentionClass, number> = { converted: 180, parked: 365, rejected: 30 };
export const IMPORT_ATTESTATION_VERSION = 'v1';
export const IMPORT_ATTESTATION_TEXT = 'I removed real customer names, phone numbers, email addresses, street addresses and other personal details from this import.';
export const KNOWLEDGE_TOPICS = [
  'hours', 'address_directions', 'contact', 'departments', 'test_drives', 'appointments', 'documents_required',
  'trade_in_process', 'financing_process', 'delivery_shipping', 'service', 'warranty', 'general',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const RULE_TYPES = new Set(['rule', 'escalation', 'tone']);
const KNOWLEDGE_TYPES = new Set(['faq', 'business_info']);
const REFERENCE_TYPES = new Set(['template', 'automation', 'example']);
const RECORDED_STATUSES = new Set<ImportItemStatus>(['ready', 'ready_with_warnings', 'changed', 'parked_knowledge', 'reference_only', 'unsupported']);
const CONVERTED_STATUSES = new Set<ImportItemStatus>(['ready', 'ready_with_warnings', 'changed']);
const REJECTED_STATUSES = new Set<ImportItemStatus>(['invalid', 'blocked_guardrail', 'blocked_safety_bypass']);
const EDITABLE_POLICY_STATUSES = new Set(['draft', 'changes_requested']);
const DB_MAX_TIME_MS = 15000;
const CONFLICT_THRESHOLD = 0.6;
const PREVIEW_STALE_MESSAGE = 'Something changed since the preview: the content, the options, a location, or what is already imported. Preview again before saving.';
const RACE_MESSAGE = 'Another import saved some of these items at the same time. Preview again before saving.';

type Category = 'privacy' | 'invalid' | 'guardrail' | 'safety' | 'mapping';

interface CategorizedIssue extends ImportIssue {
  category: Category;
}

export interface ImportOptions {
  mode: ImportMode;
  fullSnapshot: boolean;
  businessContacts: Array<{ kind: 'phone' | 'email' | 'domain'; value: string }>;
  locationMappings: Array<{ sourceLabel: string; sourceKey: string; locationId: string | null }>;
  nameAcknowledgements: Array<{ rowNumber: number; fingerprint: string }>;
}

interface ResolvedLocation {
  label: string;
  scope: 'all' | 'location' | 'none';
  via: 'mapping' | 'alias' | 'unmapped';
  locationId?: string;
  locationCode?: string;
  locationName?: string;
}

interface RowTarget {
  kind: ImportTargetKind;
  policyId?: string;
  policyStatus?: string;
  policyVersion?: number;
  previousPolicyId?: string;
  previousItemId?: string;
}

type Mapped =
  | { target: 'training_proposal'; rule: StructuredRule }
  | { target: 'knowledge_entry'; payload: Record<string, unknown> }
  | { target: 'reference'; payload: Record<string, unknown> };

export interface AnalyzedRow {
  row: CanonicalRow;
  status: ImportItemStatus;
  issues: CategorizedIssue[];
  fingerprint: string;
  sourceKey?: string;
  keyRevision?: number;
  privacyBlocked: boolean;
  nameReviewed: boolean;
  location: ResolvedLocation;
  target: RowTarget;
  mapped?: Mapped;
  title?: string;
  conflicts: Array<{ kind: 'proposal' | 'coaching'; id: string; title: string; score: number }>;
}

export interface ImportAnalysis {
  parsed: ParsedImportSource;
  options: ImportOptions;
  fileName?: string;
  fileNameWithheld: boolean;
  rows: AnalyzedRow[];
  counts: Record<string, number>;
  batchIssues: ImportIssue[];
  blocking: string[];
  missingFromSnapshot: Array<{ sourceKey: string; itemId: string; title?: string; batchNumber?: number }>;
  locationMappings: Array<{ sourceLabel: string; sourceKey: string; scope: 'all' | 'location'; locationId?: string; locationCode?: string }>;
  previewHash: string;
  knowledgeEnabled: boolean;
}

export function isImportGloballyEnabled(): boolean {
  return process.env.AI_TRAINING_IMPORT_ENABLED === 'true';
}

export async function requireImportEnabled(organizationId: string): Promise<void> {
  if (!isImportGloballyEnabled()) throw new ApiError(409, 'Podium import is turned off on this server');
  await requireTrainingEnabled(organizationId);
}

export function requireImportAccess(user: any): void {
  if (!canReviewTraining(trainingRole(user))) throw new ApiError(403, 'Only managers and admins can import training content');
}

export function requireImportAdmin(user: any): void {
  if (trainingRole(user) !== 'admin') throw new ApiError(403, 'Only admins can purge stored import content');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((out: any, key) => {
      if (value[key] !== undefined) out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function badRequest(message: string, field: string, code: string): never {
  throw new ApiError(400, message, [{ field, code, severity: 'error', message }]);
}

export function parseImportOptions(raw: unknown): ImportOptions {
  const input: any = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) badRequest('Import options are malformed.', 'options', 'invalid_type');
  const mode = input.mode === undefined || input.mode === '' ? 'incremental' : input.mode;
  if (!(IMPORT_MODES as readonly string[]).includes(mode)) badRequest('Mode must be initial or incremental.', 'options.mode', 'invalid_value');
  if (input.fullSnapshot !== undefined && typeof input.fullSnapshot !== 'boolean') badRequest('fullSnapshot must be true or false.', 'options.fullSnapshot', 'invalid_type');

  const contacts: ImportOptions['businessContacts'] = [];
  const rawContacts = input.businessContacts ?? [];
  if (!Array.isArray(rawContacts)) badRequest('Business contacts must be a list.', 'options.businessContacts', 'invalid_type');
  if (rawContacts.length > IMPORT_LIMITS.businessContacts) badRequest(`Add at most ${IMPORT_LIMITS.businessContacts} business contacts.`, 'options.businessContacts', 'too_many');
  rawContacts.forEach((entry: any, index: number) => {
    const field = `options.businessContacts.${index}`;
    if (!entry || typeof entry !== 'object' || typeof entry.value !== 'string') badRequest('Each business contact needs a kind and a value.', field, 'invalid_type');
    const value = entry.value.trim();
    if (entry.kind === 'phone') {
      const digits = normalizePhoneDigits(value);
      if (!/^\d{10}$/.test(digits)) badRequest('Business phone numbers need 10 digits.', field, 'invalid_phone');
      contacts.push({ kind: 'phone', value: digits });
    } else if (entry.kind === 'email') {
      const email = value.toLowerCase();
      const match = email.match(/^[\w.+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})$/);
      if (!match) badRequest('Enter a valid business email address.', field, 'invalid_email');
      if (FREE_MAIL_DOMAINS.has(match[1])) badRequest('Personal email providers like Gmail cannot be business contacts.', field, 'personal_email');
      contacts.push({ kind: 'email', value: email });
    } else if (entry.kind === 'domain') {
      const domain = value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain) || domain.length > 120) badRequest('Enter a valid website domain, for example actionautoutah.com.', field, 'invalid_domain');
      if (FREE_MAIL_DOMAINS.has(domain)) badRequest('Personal email providers cannot be business domains.', field, 'personal_email');
      contacts.push({ kind: 'domain', value: domain });
    } else {
      badRequest('Business contacts can be a phone, email or domain.', field, 'invalid_value');
    }
  });

  const mappings: ImportOptions['locationMappings'] = [];
  const rawMappings = input.locationMappings ?? [];
  if (!Array.isArray(rawMappings)) badRequest('Location mappings must be a list.', 'options.locationMappings', 'invalid_type');
  if (rawMappings.length > IMPORT_LIMITS.locationMappings) badRequest(`Add at most ${IMPORT_LIMITS.locationMappings} location mappings.`, 'options.locationMappings', 'too_many');
  const seenKeys = new Set<string>();
  rawMappings.forEach((entry: any, index: number) => {
    const field = `options.locationMappings.${index}`;
    if (!entry || typeof entry !== 'object' || typeof entry.sourceLabel !== 'string') badRequest('Each location mapping needs the Podium label.', field, 'invalid_type');
    const label = entry.sourceLabel.replace(/\s+/g, ' ').trim();
    if (label.length > 80) badRequest('Location labels can be at most 80 characters.', field, 'invalid_label');
    const labelProblems = label ? locationLabelIssues(field, 'The location label', label) : [];
    if (labelProblems.length) badRequest(labelProblems[0].message, field, labelProblems[0].code);
    const key = normalizeLocationKey(label);
    if (seenKeys.has(key)) badRequest(`The label "${label}" is mapped twice.`, field, 'duplicate_mapping');
    seenKeys.add(key);
    const locationId = entry.locationId === null || entry.locationId === undefined || entry.locationId === '' ? null : String(entry.locationId);
    if (locationId && !mongoose.isValidObjectId(locationId)) badRequest('Choose a valid location.', field, 'invalid_location');
    mappings.push({ sourceLabel: label, sourceKey: key, locationId });
  });

  const acknowledgements: ImportOptions['nameAcknowledgements'] = [];
  const rawAcks = input.nameAcknowledgements ?? [];
  if (!Array.isArray(rawAcks)) badRequest('Name reviews must be a list.', 'options.nameAcknowledgements', 'invalid_type');
  if (rawAcks.length > IMPORT_LIMITS.nameAcknowledgements) badRequest('Too many name reviews.', 'options.nameAcknowledgements', 'too_many');
  rawAcks.forEach((entry: any, index: number) => {
    const field = `options.nameAcknowledgements.${index}`;
    if (!entry || !Number.isInteger(entry.rowNumber) || entry.rowNumber < 1 || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) {
      badRequest('Each name review needs the row number and its fingerprint from the preview.', field, 'invalid_value');
    }
    acknowledgements.push({ rowNumber: entry.rowNumber, fingerprint: entry.fingerprint });
  });

  return { mode, fullSnapshot: input.fullSnapshot === true, businessContacts: contacts, locationMappings: mappings, nameAcknowledgements: acknowledgements };
}

function contactSets(options: ImportOptions): BusinessContactSets {
  const sets: BusinessContactSets = { phones: new Set(), emails: new Set(), domains: new Set() };
  for (const contact of options.businessContacts) {
    if (contact.kind === 'phone') sets.phones.add(contact.value);
    if (contact.kind === 'email') sets.emails.add(contact.value);
    if (contact.kind === 'domain') sets.domains.add(contact.value);
  }
  return sets;
}

export function rowFingerprint(values: CanonicalValues): string {
  const { notes, sourceRef, location, sourceStatus, ...content } = values;
  return sha256(JSON.stringify(stable(content)));
}

function splitTriggers(text: string): string[] {
  return text.split('|').map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function titleOf(values: CanonicalValues): string {
  return (values.title || splitTriggers(values.triggerOrQuestion)[0] || values.exampleCustomer || '').slice(0, 120);
}

function sourceKeyFor(values: CanonicalValues, location: ResolvedLocation): string | undefined {
  if (location.scope === 'none') return undefined;
  const scopeCode = location.scope === 'all' ? '*' : location.locationCode || '';
  const ref = normalizeLocationKey(values.sourceRef);
  if (ref) return sha256(`ref|${values.type}|${scopeCode}|${ref}`);
  const subject = normalizeLocationKey(values.title || values.triggerOrQuestion);
  return subject ? sha256(`item|${values.type}|${scopeCode}|${subject}`) : undefined;
}

function guardrailClassFor(type: string, field: keyof CanonicalValues, unsupported: boolean): GuardrailClass {
  if (['mustAvoid', 'notes', 'sourceRef', 'location', 'topic', 'channels', 'handling', 'type'].includes(field)) return 'exempt';
  if (unsupported || REFERENCE_TYPES.has(type)) return 'reference';
  if (field === 'title' || field === 'triggerOrQuestion' || field === 'exampleCustomer') return 'question';
  if (field === 'exampleReply') return 'reply';
  if (KNOWLEDGE_TYPES.has(type)) return 'knowledge';
  return 'instruction';
}

const TEXT_FIELDS: Array<keyof CanonicalValues> = [
  'title', 'location', 'triggerOrQuestion', 'answerOrInstruction', 'escalationWhen', 'handoffReason', 'exampleCustomer', 'exampleReply', 'sourceRef', 'notes',
];
const LIST_FIELDS: Array<keyof CanonicalValues> = ['requiredQuestions', 'mustInclude', 'mustAvoid'];

function screenRow(row: CanonicalRow, contacts: BusinessContactSets, nameAllow: Set<string>): CategorizedIssue[] {
  const values = row.values;
  const issues: CategorizedIssue[] = row.issues.map((issue) => ({ ...issue, category: issue.severity === 'error' ? 'invalid' : 'mapping' }));
  const add = (category: Category, found: ImportIssue[]) => issues.push(...found.map((issue) => ({ ...issue, category })));
  const texts: Array<[keyof CanonicalValues, string, string]> = [];
  for (const field of TEXT_FIELDS) texts.push([field, field, values[field] as string]);
  for (const field of LIST_FIELDS) (values[field] as string[]).forEach((item, index) => texts.push([field, `${field}.${index}`, item]));
  if (row.unsupportedType) texts.push(['type', 'type', values.type]);

  for (const [field, path, text] of texts) {
    if (!text) continue;
    add('privacy', privacyIssues(path, text, {
      contacts,
      addressSensitive: field === 'exampleCustomer' || field === 'exampleReply' || field === 'notes',
      checkNames: field === 'exampleCustomer' || field === 'exampleReply',
      nameAllowlist: nameAllow,
    }));
    if (field === 'location') {
      for (const problem of locationLabelIssues(path, 'The location label', text)) {
        add(problem.code === 'invalid_characters' ? 'invalid' : 'privacy', [{ field: path, code: `location_${problem.code}`, severity: 'error', message: problem.message }]);
      }
    }
    const cls = guardrailClassFor(values.type, field, row.unsupportedType);
    add('guardrail', guardrailIssues(path, text, cls));
    if (cls !== 'exempt' && cls !== 'question') add('safety', safetyIssues(path, text));
    if (field === 'mustAvoid') {
      for (const issue of avoidItemIssues(path, text)) add(issue.code === 'must_avoid_safety' || issue.code === 'safety_bypass' ? 'safety' : 'guardrail', [issue]);
    }
  }
  if (KNOWLEDGE_TYPES.has(values.type)) add('safety', protectedQuestionIssues('trigger_or_question', values.triggerOrQuestion));
  return issues;
}

function ruleInput(values: CanonicalValues) {
  const triggers = splitTriggers(values.triggerOrQuestion);
  return {
    title: titleOf(values),
    category: values.type === 'rule' ? 'scenario_response' : values.type,
    channels: values.channels.length ? values.channels : ['sms', 'webchat'],
    intent: triggers[0] || '',
    triggers,
    handling: values.handling,
    instruction: values.answerOrInstruction,
    requiredQuestions: values.requiredQuestions,
    mustInclude: values.mustInclude,
    mustAvoid: values.mustAvoid,
    escalation: { when: values.escalationWhen, handoffReason: values.handoffReason },
    examples: values.exampleCustomer || values.exampleReply ? [{ customerMessage: values.exampleCustomer, idealReply: values.exampleReply }] : [],
  };
}

function sourceDetails(values: CanonicalValues) {
  return {
    system: 'podium',
    ref: values.sourceRef || undefined,
    location: values.location || undefined,
    status: values.sourceStatus || undefined,
    question: values.triggerOrQuestion || undefined,
    answer: values.answerOrInstruction || undefined,
  };
}

function mapRow(row: CanonicalRow, location: ResolvedLocation): { mapped?: Mapped; issues: CategorizedIssue[] } {
  const values = row.values;
  const issues: CategorizedIssue[] = [];
  const scope = { kind: location.scope, locationId: location.locationId, locationCode: location.locationCode };
  if (values.sourceStatus === 'off') {
    issues.push({ field: 'source_status', code: 'source_turned_off', severity: 'info', message: 'This was turned off in Podium. That is kept as a note only; everything imported starts inactive in Suprah.', category: 'mapping' });
  }
  if (row.unsupportedType) {
    return {
      mapped: { target: 'reference', payload: { kind: 'unsupported_reference', sourceType: values.type, title: titleOf(values), question: values.triggerOrQuestion || undefined, text: values.answerOrInstruction || undefined, locationScope: scope, source: sourceDetails(values) } },
      issues: [...issues, { field: 'type', code: 'unsupported_type', severity: 'warning', message: 'This item type is not supported. It is kept for reference only and never used.', category: 'mapping' }],
    };
  }
  if (RULE_TYPES.has(values.type)) {
    const input = ruleInput(values);
    if (!values.channels.length) issues.push({ field: 'channels', code: 'channels_defaulted', severity: 'info', message: 'No channels were given, so SMS and website chat were used.', category: 'mapping' });
    if (!values.handling) issues.push({ field: 'handling', code: 'handling_missing', severity: 'warning', message: 'Handling was left blank. The reviewer must choose it before submitting.', category: 'mapping' });
    const { rule, problems } = parseStructuredRule(input);
    for (const problem of problems) issues.push({ field: problem.field, code: problem.code, severity: 'error', message: problem.message, category: 'invalid' });
    if (problems.length) return { issues };
    const evaluation = evaluateStructuredRule(rule);
    for (const error of evaluation.errors) {
      if (error.code === 'protected_topic' || error.code === 'safety_bypass') {
        issues.push({ field: error.field, code: error.code, severity: 'error', message: error.message, category: 'safety' });
      } else if (!(error.code === 'required' && error.field === 'handling')) {
        issues.push({ field: error.field, code: `draft_${error.code}`, severity: 'warning', message: error.message, category: 'mapping' });
      }
    }
    for (const warning of evaluation.warnings) issues.push({ field: warning.field, code: warning.code, severity: 'warning', message: warning.message, category: 'mapping' });
    return { mapped: { target: 'training_proposal', rule }, issues };
  }
  if (KNOWLEDGE_TYPES.has(values.type)) {
    let topic = values.topic;
    if (!topic) {
      topic = 'general';
      issues.push({ field: 'topic', code: 'topic_defaulted', severity: 'info', message: 'No topic was given, so "general" was used.', category: 'mapping' });
    } else if (!(KNOWLEDGE_TOPICS as readonly string[]).includes(topic)) {
      issues.push({ field: 'topic', code: 'invalid_topic', severity: 'error', message: `Topic must be one of: ${KNOWLEDGE_TOPICS.join(', ')}.`, category: 'invalid' });
      return { issues };
    }
    if (!values.triggerOrQuestion && values.type === 'faq') {
      issues.push({ field: 'trigger_or_question', code: 'required', severity: 'error', message: 'FAQs need the question.', category: 'invalid' });
      return { issues };
    }
    return {
      mapped: {
        target: 'knowledge_entry',
        payload: {
          kind: values.type,
          topic,
          title: titleOf(values),
          channels: values.channels.length ? values.channels : ['sms', 'webchat', 'email'],
          locationScope: scope,
          content: { question: values.triggerOrQuestion || undefined, answer: values.answerOrInstruction },
          source: sourceDetails(values),
        },
      },
      issues,
    };
  }
  if (values.type === 'template') {
    return { mapped: { target: 'reference', payload: { kind: 'canned_reply_candidate', title: titleOf(values), body: values.answerOrInstruction, channels: values.channels, locationScope: scope, source: sourceDetails(values) } }, issues };
  }
  if (values.type === 'automation') {
    return { mapped: { target: 'reference', payload: { kind: 'automation_reference', title: titleOf(values), trigger: values.triggerOrQuestion || undefined, description: values.answerOrInstruction || undefined, channels: values.channels, locationScope: scope, source: sourceDetails(values) } }, issues };
  }
  const customerMessage = values.exampleCustomer || values.triggerOrQuestion;
  const idealReply = values.exampleReply || values.answerOrInstruction;
  if (!customerMessage && !idealReply) {
    issues.push({ field: 'example_customer', code: 'required', severity: 'error', message: 'Examples need a customer message or a reply.', category: 'invalid' });
    return { issues };
  }
  return { mapped: { target: 'reference', payload: { kind: 'example_reference', title: titleOf(values), customerMessage: customerMessage || undefined, idealReply: idealReply || undefined, locationScope: scope, source: sourceDetails(values) } }, issues };
}

function retentionFor(status: ImportItemStatus): ImportRetentionClass | undefined {
  if (CONVERTED_STATUSES.has(status)) return 'converted';
  if (status === 'parked_knowledge' || status === 'reference_only' || status === 'unsupported') return 'parked';
  if (REJECTED_STATUSES.has(status)) return 'rejected';
  return undefined;
}

function conflictText(title: string, intent?: string, triggers?: string[]): string {
  return [title, intent, ...(triggers || [])].filter(Boolean).join(' ');
}

async function loadConflictCandidates(organizationId: string, session: ClientSession | null) {
  const policies: any[] = await AiTrainingPolicy.find({ organizationId, status: { $in: ['draft', 'in_review', 'changes_requested', 'approved'] } })
    .select('title currentVersion').sort({ updatedAt: -1 }).limit(300).session(session).maxTimeMS(DB_MAX_TIME_MS).lean();
  const versions: any[] = policies.length
    ? await AiTrainingPolicyVersion.find({ organizationId, $or: policies.map((policy) => ({ policyId: policy._id, version: policy.currentVersion })) })
      .select('policyId spec.intent spec.triggers').session(session).maxTimeMS(DB_MAX_TIME_MS).lean()
    : [];
  const specs = new Map(versions.map((row) => [String(row.policyId), row.spec || {}]));
  const coaching: any[] = await AiAgentCoachingRule.find({ organizationId, status: 'active' })
    .select('instruction').sort({ updatedAt: -1 }).limit(200).session(session).maxTimeMS(DB_MAX_TIME_MS).lean();
  return {
    proposals: policies.map((policy) => ({ id: String(policy._id), title: policy.title, text: conflictText(policy.title, specs.get(String(policy._id))?.intent, specs.get(String(policy._id))?.triggers) })),
    coaching: coaching.map((rule) => ({ id: String(rule._id), title: String(rule.instruction || '').slice(0, 80), text: String(rule.instruction || '') })),
  };
}

function hashAnalysis(parsed: ParsedImportSource, options: ImportOptions, fileName: string | undefined, rows: AnalyzedRow[], locations: any[], missing: ImportAnalysis['missingFromSnapshot']): string {
  return sha256(JSON.stringify(stable({
    engine: IMPORT_ENGINE_VERSION,
    format: parsed.format,
    contentSha256: parsed.contentSha256,
    fileName: fileName || null,
    options: {
      mode: options.mode,
      fullSnapshot: options.fullSnapshot,
      businessContacts: options.businessContacts.map((contact) => `${contact.kind}:${contact.value}`).sort(),
      mappings: options.locationMappings.map((mapping) => `${mapping.sourceKey}=${mapping.locationId || '*'}`).sort(),
      nameAcknowledgements: options.nameAcknowledgements.map((ack) => `${ack.rowNumber}:${ack.fingerprint}`).sort(),
    },
    locations: locations.map((location) => `${location._id}:${location.status}:${location.revision}`).sort(),
    rows: rows.map((analyzed) => ({
      n: analyzed.row.rowNumber,
      fp: analyzed.fingerprint,
      key: analyzed.sourceKey || null,
      rev: analyzed.keyRevision || null,
      status: analyzed.status,
      codes: analyzed.issues.filter((issue) => !KNOWLEDGE_PREVIEW_CODES.has(issue.code)).map((issue) => `${issue.field}:${issue.code}:${issue.severity}`).filter((code) => !code.includes(':possible_conflict:')).sort(),
      scope: `${analyzed.location.scope}:${analyzed.location.locationId || ''}`,
      target: analyzed.target,
    })),
    missing: missing.map((entry) => entry.itemId).sort(),
  })));
}

export async function analyzeImport(input: { organizationId: string; body: any; session: ClientSession | null }): Promise<ImportAnalysis> {
  const { organizationId, session } = input;
  const parsed = parseImportSource(input.body?.source);
  const options = parseImportOptions(input.body?.options);
  const knowledge = await knowledgeImportContext(organizationId);
  const contacts = mergeContactSets(contactSets(options), knowledge.context?.contacts);
  const batchIssues: ImportIssue[] = [...parsed.batchIssues];

  let fileName = parsed.fileName;
  let fileNameWithheld = false;
  if (fileName && privacyIssues('fileName', fileName, { contacts, addressSensitive: true, checkNames: false }).some((issue) => issue.severity === 'error')) {
    fileName = undefined;
    fileNameWithheld = true;
    batchIssues.push({ field: 'fileName', code: 'file_name_withheld', severity: 'warning', message: 'The file name looks like it contains personal details, so it will not be saved.' });
  }

  const locations: any[] = await CrmLocation.find({ organizationId }).select('code name aliases aliasKeys status revision')
    .session(session).maxTimeMS(DB_MAX_TIME_MS).lean();
  const byId = new Map(locations.map((location) => [String(location._id), location]));
  const byAlias = new Map<string, any>();
  for (const location of locations) {
    if (location.status !== 'active') continue;
    for (const key of location.aliasKeys || []) byAlias.set(key, location);
  }
  const mapped = new Map<string, ResolvedLocation>();
  const locationMappings: ImportAnalysis['locationMappings'] = [];
  for (const mapping of options.locationMappings) {
    if (!mapping.locationId) {
      mapped.set(mapping.sourceKey, { label: mapping.sourceLabel, scope: 'all', via: 'mapping' });
      locationMappings.push({ sourceLabel: mapping.sourceLabel, sourceKey: mapping.sourceKey, scope: 'all' });
      continue;
    }
    const location = byId.get(mapping.locationId);
    if (!location) badRequest(`The location chosen for "${mapping.sourceLabel}" was not found.`, 'options.locationMappings', 'location_not_found');
    if (location.status !== 'active') badRequest(`The location chosen for "${mapping.sourceLabel}" is archived. Choose an active location.`, 'options.locationMappings', 'location_archived');
    mapped.set(mapping.sourceKey, { label: mapping.sourceLabel, scope: 'location', via: 'mapping', locationId: String(location._id), locationCode: location.code, locationName: location.name });
    locationMappings.push({ sourceLabel: mapping.sourceLabel, sourceKey: mapping.sourceKey, scope: 'location', locationId: String(location._id), locationCode: location.code });
  }
  const nameAllow = new Set<string>();
  for (const location of locations) {
    for (const word of normalizeLocationKey([location.name, ...(location.aliases || [])].join(' ')).split(' ')) if (word) nameAllow.add(word);
  }
  const acknowledged = new Set(options.nameAcknowledgements.map((ack) => `${ack.rowNumber}:${ack.fingerprint}`));

  const rows: AnalyzedRow[] = parsed.rows.map((row) => {
    const fingerprint = rowFingerprint(row.values);
    const issues = screenRow(row, contacts, nameAllow);
    let nameReviewed = false;
    for (const issue of issues) {
      if (issue.code === 'possible_personal_name' && acknowledged.has(`${row.rowNumber}:${fingerprint}`)) {
        issue.severity = 'warning';
        issue.message = 'Marked as reviewed: the names in this example are made up.';
        nameReviewed = true;
      }
    }
    const label = row.values.location;
    const key = normalizeLocationKey(label);
    const explicit = mapped.get(key);
    const alias = label ? byAlias.get(key) : undefined;
    let location: ResolvedLocation;
    if (explicit) location = { ...explicit, label };
    else if (alias) location = { label, scope: 'location', via: 'alias', locationId: String(alias._id), locationCode: alias.code, locationName: alias.name };
    else location = { label, scope: 'none', via: 'unmapped' };
    const mapping = mapRow(row, location);
    issues.push(...mapping.issues);
    return {
      row,
      status: 'invalid',
      issues,
      fingerprint,
      privacyBlocked: issues.some((issue) => issue.category === 'privacy' && issue.severity === 'error'),
      nameReviewed,
      location,
      target: { kind: 'none' },
      mapped: mapping.mapped,
      conflicts: [],
    };
  });

  const hasError = (analyzed: AnalyzedRow, category: Category) => analyzed.issues.some((issue) => issue.category === category && issue.severity === 'error');
  const firstByKey = new Map<string, AnalyzedRow>();
  const duplicates = new Set<AnalyzedRow>();
  for (const analyzed of rows) {
    if (analyzed.privacyBlocked) continue;
    analyzed.sourceKey = sourceKeyFor(analyzed.row.values, analyzed.location);
    const eligible = Boolean(analyzed.mapped) && !hasError(analyzed, 'invalid') && !hasError(analyzed, 'guardrail') && !hasError(analyzed, 'safety');
    if (!analyzed.sourceKey || !eligible) continue;
    const first = firstByKey.get(analyzed.sourceKey);
    if (!first) {
      firstByKey.set(analyzed.sourceKey, analyzed);
      continue;
    }
    duplicates.add(analyzed);
    if (first.fingerprint !== analyzed.fingerprint) {
      const message = `Row ${first.row.rowNumber} and row ${analyzed.row.rowNumber} describe the same item with different content. Only row ${first.row.rowNumber} is used.`;
      for (const target of [first, analyzed]) target.issues.push({ field: 'row', code: 'duplicate_key_different_content', severity: 'warning', message, category: 'mapping' });
    }
  }

  const keys = Array.from(firstByKey.keys());
  const history: any[] = keys.length
    ? await AiTrainingImportItem.aggregate([
      { $match: { organizationId, sourceKey: { $in: keys } } },
      { $sort: { sourceKey: 1, keyRevision: -1, createdAt: -1 } },
      { $group: { _id: '$sourceKey', maxRevision: { $max: '$keyRevision' }, items: { $push: { id: '$_id', batchId: '$batchId', batchNumber: '$batchNumber', keyRevision: '$keyRevision', fingerprint: '$fingerprint', target: '$target', type: '$type' } } } },
      { $project: { maxRevision: 1, items: { $slice: ['$items', 10] } } },
    ]).session(session as any).option({ maxTimeMS: DB_MAX_TIME_MS })
    : [];
  const historyBatchIds = Array.from(new Set(history.flatMap((entry) => entry.items.map((item: any) => String(item.batchId)))));
  const committedBatches = new Set((historyBatchIds.length
    ? await AiTrainingImportBatch.find({ organizationId, _id: { $in: historyBatchIds } }).select('_id').session(session).lean()
    : []).map((batch: any) => String(batch._id)));
  const latestByKey = new Map<string, any>();
  const maxRevisionByKey = new Map<string, number>();
  for (const entry of history) {
    maxRevisionByKey.set(entry._id, Number(entry.maxRevision || 0));
    const latest = entry.items.find((item: any) => item.keyRevision && committedBatches.has(String(item.batchId)));
    if (latest) latestByKey.set(entry._id, latest);
  }
  const linkedPolicyIds = Array.from(new Set(Array.from(latestByKey.values()).map((item) => item.target?.policyId).filter(Boolean).map(String)));
  const linkedPolicies = new Map((linkedPolicyIds.length
    ? await AiTrainingPolicy.find({ organizationId, _id: { $in: linkedPolicyIds } }).select('status currentVersion title source').session(session).lean()
    : []).map((policy: any) => [String(policy._id), policy]));

  const changedSince = new Map<AnalyzedRow, number>();
  for (const analyzed of rows) {
    const has = (category: Category) => hasError(analyzed, category);
    const recordable = !analyzed.privacyBlocked && !has('invalid') && !has('guardrail') && !has('safety') && Boolean(analyzed.mapped);
    if (analyzed.privacyBlocked) analyzed.status = 'blocked_privacy';
    else if (has('invalid') || !analyzed.mapped) analyzed.status = 'invalid';
    else if (has('guardrail')) analyzed.status = 'blocked_guardrail';
    else if (has('safety')) analyzed.status = 'blocked_safety_bypass';
    else if (analyzed.location.scope === 'none') analyzed.status = 'needs_location';
    else if (duplicates.has(analyzed)) analyzed.status = 'duplicate_in_file';
    else {
      const latest = analyzed.sourceKey ? latestByKey.get(analyzed.sourceKey) : undefined;
      const changed = Boolean(latest) && latest.fingerprint !== analyzed.fingerprint;
      if (latest && !changed) analyzed.status = 'unchanged';
      else if (analyzed.row.unsupportedType) analyzed.status = 'unsupported';
      else if (KNOWLEDGE_TYPES.has(analyzed.row.values.type)) analyzed.status = 'parked_knowledge';
      else if (REFERENCE_TYPES.has(analyzed.row.values.type)) analyzed.status = 'reference_only';
      else if (changed) analyzed.status = 'changed';
      else analyzed.status = analyzed.issues.some((issue) => issue.severity === 'warning') ? 'ready_with_warnings' : 'ready';
      if (changed && analyzed.status === 'parked_knowledge' && knowledge.enabled) {
        changedSince.set(analyzed, Number(latest.batchNumber));
      } else if (changed && analyzed.status !== 'changed') {
        analyzed.issues.push({ field: 'row', code: 'updated_since_last_import', severity: 'info', message: `This item changed since import batch #${latest.batchNumber}. A new reference copy will be kept.`, category: 'mapping' });
      }
      if (latest) analyzed.target.previousItemId = String(latest.id);
    }
    if (!recordable || !RECORDED_STATUSES.has(analyzed.status)) {
      if (analyzed.status !== 'unchanged') delete analyzed.target.previousItemId;
      continue;
    }
    analyzed.keyRevision = (maxRevisionByKey.get(analyzed.sourceKey!) || 0) + 1;
    if (analyzed.status === 'parked_knowledge') analyzed.target.kind = 'parked_knowledge';
    else if (analyzed.status === 'reference_only' || analyzed.status === 'unsupported') analyzed.target.kind = 'reference';
    else {
      const latest = analyzed.sourceKey ? latestByKey.get(analyzed.sourceKey) : undefined;
      const policy = latest?.target?.policyId ? linkedPolicies.get(String(latest.target.policyId)) : undefined;
      if (analyzed.status !== 'changed') analyzed.target.kind = 'proposal_created';
      else if (!policy) {
        analyzed.target.kind = 'proposal_created';
        analyzed.issues.push({ field: 'row', code: 'previous_proposal_missing', severity: 'warning', message: 'The proposal from the earlier import no longer exists, so a new draft will be created.', category: 'mapping' });
      } else if (EDITABLE_POLICY_STATUSES.has(policy.status) && policy.source === 'podium_import' && Number(policy.currentVersion) < STRUCTURED_RULE_LIMITS.maxVersions) {
        Object.assign(analyzed.target, { kind: 'proposal_version', policyId: String(policy._id), policyStatus: policy.status, policyVersion: Number(policy.currentVersion) });
      } else {
        Object.assign(analyzed.target, { kind: 'proposal_linked', previousPolicyId: String(policy._id), policyStatus: policy.status, policyVersion: Number(policy.currentVersion) });
        analyzed.issues.push({
          field: 'row',
          code: 'previous_not_editable',
          severity: 'warning',
          message: `The earlier proposal "${policy.title}" is ${String(policy.status).replace(/_/g, ' ')}, so a new linked draft will be created instead of changing it.`,
          category: 'mapping',
        });
      }
    }
  }

  if (knowledge.enabled && knowledge.context) {
    const knowledgeRows = rows.filter((analyzed) => (analyzed.status === 'parked_knowledge' || analyzed.status === 'needs_location') && analyzed.mapped?.target === 'knowledge_entry');
    if (knowledgeRows.length) {
      const notes = await knowledgePreviewNotes(organizationId, knowledgeRows.map((analyzed) => {
        const payload: any = (analyzed.mapped as { payload: Record<string, unknown> }).payload;
        return {
          kind: analyzed.row.values.type,
          topic: payload.topic,
          title: payload.title,
          question: payload.content?.question,
          answer: payload.content?.answer,
          channels: payload.channels,
          scope: { kind: analyzed.location.scope, locationId: analyzed.location.locationId },
          sourceKey: analyzed.sourceKey,
          changedSinceBatch: changedSince.get(analyzed),
        };
      }));
      knowledgeRows.forEach((analyzed, index) => {
        for (const note of notes[index]) analyzed.issues.push({ field: 'row', code: note.code, severity: note.severity, message: note.message, category: 'mapping' });
      });
    }
  }

  let missingFromSnapshot: ImportAnalysis['missingFromSnapshot'] = [];
  if (options.fullSnapshot) {
    const codes = new Set<string>();
    let coversAll = false;
    for (const analyzed of rows) {
      if (analyzed.location.scope === 'all') coversAll = true;
      if (analyzed.location.scope === 'location' && analyzed.location.locationCode) codes.add(analyzed.location.locationCode);
    }
    const scopeFilter: any[] = [];
    if (coversAll) scopeFilter.push({ 'locationScope.kind': 'all' });
    if (codes.size) scopeFilter.push({ 'locationScope.locationCode': { $in: Array.from(codes) } });
    const presentKeys = rows.map((analyzed) => analyzed.sourceKey).filter(Boolean) as string[];
    const candidates: any[] = scopeFilter.length
      ? await AiTrainingImportItem.aggregate([
        { $match: { organizationId, keyRevision: { $exists: true }, $or: scopeFilter } },
        { $sort: { sourceKey: 1, keyRevision: -1 } },
        { $group: { _id: '$sourceKey', itemId: { $first: '$_id' }, batchId: { $first: '$batchId' }, batchNumber: { $first: '$batchNumber' }, title: { $first: '$title' } } },
        { $match: { _id: { $nin: presentKeys } } },
        { $sort: { batchNumber: -1 } },
        { $limit: 600 },
      ]).session(session as any).option({ maxTimeMS: DB_MAX_TIME_MS })
      : [];
    const candidateBatches = new Set((candidates.length
      ? await AiTrainingImportBatch.find({ organizationId, _id: { $in: Array.from(new Set(candidates.map((entry) => String(entry.batchId)))) } }).select('_id').session(session).lean()
      : []).map((batch: any) => String(batch._id)));
    missingFromSnapshot = candidates
      .filter((entry) => candidateBatches.has(String(entry.batchId)))
      .slice(0, 500)
      .map((entry) => ({ sourceKey: entry._id, itemId: String(entry.itemId), title: entry.title || undefined, batchNumber: entry.batchNumber }));
  }

  const ruleRows = rows.filter((analyzed) => analyzed.mapped?.target === 'training_proposal' && CONVERTED_STATUSES.has(analyzed.status));
  if (ruleRows.length) {
    const candidates = await loadConflictCandidates(organizationId, session);
    for (const analyzed of ruleRows) {
      const rule = (analyzed.mapped as { rule: StructuredRule }).rule;
      const text = conflictText(rule.title, rule.intent, rule.triggers);
      const skip = new Set([analyzed.target.policyId, analyzed.target.previousPolicyId].filter(Boolean) as string[]);
      const found: AnalyzedRow['conflicts'] = [];
      for (const candidate of candidates.proposals) {
        if (skip.has(candidate.id)) continue;
        const score = Math.max(wordOverlap(text, candidate.text), wordOverlap(candidate.text, text));
        if (score >= CONFLICT_THRESHOLD) found.push({ kind: 'proposal', id: candidate.id, title: candidate.title, score: Math.round(score * 100) / 100 });
      }
      for (const candidate of candidates.coaching) {
        const score = wordOverlap(text, candidate.text);
        if (score >= CONFLICT_THRESHOLD) found.push({ kind: 'coaching', id: candidate.id, title: candidate.title, score: Math.round(score * 100) / 100 });
      }
      analyzed.conflicts = found.sort((a, b) => b.score - a.score).slice(0, 3);
      if (analyzed.conflicts.length) {
        analyzed.issues.push({ field: 'row', code: 'possible_conflict', severity: 'warning', message: 'This may overlap with an existing rule or coaching note. Approximate word matching only; a person decides.', category: 'mapping' });
      }
    }
  }

  for (const analyzed of rows) {
    if (!analyzed.privacyBlocked) {
      const titleField = analyzed.row.values.title ? 'title' : 'trigger_or_question';
      const titleHasFigure = analyzed.issues.some((issue) => issue.code === 'guardrail_figure' && (issue.field === titleField));
      const title = titleOf(analyzed.row.values);
      if (title && !titleHasFigure) analyzed.title = title;
    }
  }

  const counts: Record<string, number> = {};
  for (const status of IMPORT_ITEM_STATUSES) counts[status] = 0;
  for (const analyzed of rows) counts[analyzed.status] += 1;
  const blocking: string[] = [];
  if (counts.needs_location) blocking.push(`${counts.needs_location} row${counts.needs_location === 1 ? '' : 's'} need a location. Map each Podium label, including rows with no location, to an approved location or confirm "All locations".`);
  if (options.mode === 'initial' && await AiTrainingImportBatch.exists({ organizationId }).session(session)) {
    batchIssues.push({ field: 'options.mode', code: 'initial_after_previous', severity: 'info', message: 'Earlier imports exist, so items already imported are still checked for changes.' });
  }
  const previewHash = hashAnalysis(parsed, options, fileName, rows, locations, missingFromSnapshot);
  return { parsed, options, fileName, fileNameWithheld, rows, counts, batchIssues, blocking, missingFromSnapshot, locationMappings, previewHash, knowledgeEnabled: knowledge.enabled };
}

function serializeIssue(issue: ImportIssue) {
  return { field: issue.field, code: issue.code, severity: issue.severity, message: issue.message };
}

function snippetOf(analyzed: AnalyzedRow): string {
  const values = analyzed.row.values;
  const text = [values.title, values.triggerOrQuestion, values.answerOrInstruction].filter(Boolean).join(' · ');
  const shown = analyzed.privacyBlocked ? maskText(text) : text;
  return shown.length > 200 ? `${shown.slice(0, 199)}…` : shown;
}

function serializeMapped(analyzed: AnalyzedRow) {
  if (!analyzed.mapped || analyzed.privacyBlocked || !RECORDED_STATUSES.has(analyzed.status)) return undefined;
  if (analyzed.mapped.target === 'training_proposal') {
    const evaluation = evaluateStructuredRule(analyzed.mapped.rule);
    return { target: 'training_proposal', spec: specFromRule(analyzed.mapped.rule), preview: evaluation.preview };
  }
  return { target: analyzed.mapped.target, payload: analyzed.mapped.payload };
}

export function serializePreview(analysis: ImportAnalysis) {
  return {
    previewHash: analysis.previewHash,
    engineVersion: IMPORT_ENGINE_VERSION,
    format: analysis.parsed.format,
    fileName: analysis.fileName,
    fileNameWithheld: analysis.fileNameWithheld,
    contentSha256: analysis.parsed.contentSha256,
    rowCount: analysis.rows.length,
    counts: analysis.counts,
    canCommit: analysis.blocking.length === 0,
    knowledgeBase: { enabled: analysis.knowledgeEnabled },
    blocking: analysis.blocking,
    batchIssues: analysis.batchIssues.map(serializeIssue),
    attestationText: IMPORT_ATTESTATION_TEXT,
    attestationVersion: IMPORT_ATTESTATION_VERSION,
    retentionDays: IMPORT_RETENTION_DAYS,
    locationMappings: analysis.locationMappings,
    unmappedLabels: Array.from(new Set(analysis.rows.filter((row) => row.status === 'needs_location').map((row) => row.location.label))),
    missingFromSnapshot: analysis.missingFromSnapshot.map(({ itemId, title, batchNumber }) => ({ itemId, title, batchNumber })),
    rows: analysis.rows.map((analyzed) => ({
      rowNumber: analyzed.row.rowNumber,
      type: analyzed.privacyBlocked && analyzed.row.unsupportedType ? 'unknown' : analyzed.row.values.type,
      status: analyzed.status,
      title: analyzed.privacyBlocked ? undefined : analyzed.title,
      snippet: snippetOf(analyzed),
      fingerprint: analyzed.fingerprint,
      sourceStatus: analyzed.privacyBlocked ? undefined : analyzed.row.values.sourceStatus || undefined,
      nameReviewed: analyzed.nameReviewed,
      needsNameReview: analyzed.issues.some((issue) => issue.code === 'possible_personal_name' && issue.severity === 'error'),
      issues: analyzed.issues.map(serializeIssue),
      location: {
        label: analyzed.privacyBlocked ? undefined : analyzed.location.label,
        scope: analyzed.location.scope,
        via: analyzed.location.via,
        locationId: analyzed.location.locationId,
        locationCode: analyzed.location.locationCode,
        locationName: analyzed.location.locationName,
      },
      target: analyzed.target,
      conflicts: analyzed.conflicts,
      mapped: serializeMapped(analyzed),
      contentWillBeStored: Boolean(retentionFor(analyzed.status)) && !analyzed.privacyBlocked,
      retentionDays: retentionFor(analyzed.status) ? IMPORT_RETENTION_DAYS[retentionFor(analyzed.status)!] : undefined,
    })),
  };
}

export async function previewImport(input: { organizationId: string; body: any }) {
  return serializePreview(await analyzeImport({ organizationId: input.organizationId, body: input.body, session: null }));
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ''));
}

function contentFields(values: CanonicalValues) {
  const fields: Record<string, unknown> = {
    itemType: values.type.slice(0, 30),
    title: values.title,
    location: values.location,
    channels: values.channels,
    triggerOrQuestion: values.triggerOrQuestion,
    answerOrInstruction: values.answerOrInstruction,
    handling: values.handling,
    escalationWhen: values.escalationWhen,
    handoffReason: values.handoffReason,
    requiredQuestions: values.requiredQuestions,
    mustInclude: values.mustInclude,
    mustAvoid: values.mustAvoid,
    exampleCustomer: values.exampleCustomer,
    exampleReply: values.exampleReply,
    topic: values.topic,
    sourceRef: values.sourceRef,
    sourceStatus: values.sourceStatus,
    notes: values.notes,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === '' || (Array.isArray(value) && !value.length)) delete fields[key];
  }
  return fields;
}

function mappedPayloadFor(analyzed: AnalyzedRow): Record<string, unknown> | undefined {
  if (!analyzed.mapped || !RECORDED_STATUSES.has(analyzed.status)) return undefined;
  if (analyzed.mapped.target === 'training_proposal') return { target: 'training_proposal', spec: specFromRule(analyzed.mapped.rule), source: sourceDetails(analyzed.row.values) };
  return { target: analyzed.mapped.target, ...analyzed.mapped.payload };
}

export async function commitImport(input: { organizationId: string; user: any; body: any }) {
  const { organizationId, user, body } = input;
  const previewHash = String(body?.previewHash || '');
  if (!/^[a-f0-9]{64}$/.test(previewHash)) badRequest('Preview the import before saving it.', 'previewHash', 'preview_required');
  if (body?.attestation !== true) badRequest('Confirm that you removed real customer information before saving.', 'attestation', 'attestation_required');
  const actor = trainingActor(user);
  const createdPolicyIds: mongoose.Types.ObjectId[] = [];
  const touchedPolicyIds: string[] = [];
  let attemptBatchId: mongoose.Types.ObjectId | null = null;
  let nonTransactional = false;
  let committed = false;

  try {
    const result = await runTrainingWrite(async (session) => {
      nonTransactional = session === null;
      createdPolicyIds.length = 0;
      touchedPolicyIds.length = 0;
      committed = false;
      const analysis = await analyzeImport({ organizationId, body, session });
      if (analysis.previewHash !== previewHash) throw new ApiError(409, PREVIEW_STALE_MESSAGE, [{ field: 'previewHash', code: 'preview_stale', severity: 'error', message: PREVIEW_STALE_MESSAGE }]);
      if (analysis.blocking.length) throw new ApiError(409, analysis.blocking[0], analysis.blocking.map((message) => ({ field: 'rows', code: 'needs_location', severity: 'error', message })));

      const options = session ? { session } : {};
      const last: any = await AiTrainingImportBatch.findOne({ organizationId }).sort({ batchNumber: -1 }).select('batchNumber').session(session).lean();
      const batchNumber = Number(last?.batchNumber || 0) + 1;
      const batchId = new mongoose.Types.ObjectId();
      attemptBatchId = batchId;
      const now = new Date();
      const note = `Imported from Podium, batch #${batchNumber}`;
      const updateNote = `Updated from Podium import, batch #${batchNumber}`;
      const items: any[] = [];
      const contents: any[] = [];
      let proposalsCreated = 0;
      let proposalsUpdated = 0;

      for (const analyzed of analysis.rows) {
        const itemId = new mongoose.Types.ObjectId();
        const target: any = { kind: analyzed.target.kind };
        if (analyzed.target.previousItemId) target.previousItemId = analyzed.target.previousItemId;
        const rule = analyzed.mapped?.target === 'training_proposal' ? analyzed.mapped.rule : undefined;
        const sourceRef = { importBatchId: batchId, importItemId: itemId, sourceSystem: 'podium', sourceKey: analyzed.sourceKey };

        if (rule && (analyzed.target.kind === 'proposal_created' || analyzed.target.kind === 'proposal_linked')) {
          const policyId = new mongoose.Types.ObjectId();
          await createPolicyWithFirstVersion({
            organizationId,
            session,
            policyId,
            policy: {
              title: rule.title,
              category: rule.category,
              channels: rule.channels,
              status: 'draft',
              source: 'podium_import',
              sourceRef: { ...sourceRef, ...(analyzed.target.previousPolicyId ? { previousPolicyId: analyzed.target.previousPolicyId } : {}) },
              ruleFormat: 'structured_v1',
              createdBy: actor,
              lastEditedBy: actor,
              pendingAudit: [auditEntry('proposal_drafted', actor, { version: 1, toStatus: 'draft', note })],
            },
            version: { spec: specFromRule(rule) as unknown as Record<string, unknown>, changeNote: note, createdBy: actor },
          });
          createdPolicyIds.push(policyId);
          touchedPolicyIds.push(String(policyId));
          Object.assign(target, { policyId, version: 1 });
          if (analyzed.target.previousPolicyId) target.previousPolicyId = analyzed.target.previousPolicyId;
          proposalsCreated += 1;
        } else if (rule && analyzed.target.kind === 'proposal_version') {
          const policy: any = await AiTrainingPolicy.findOne({ _id: analyzed.target.policyId, organizationId }).session(session).lean();
          if (!policy || policy.status !== analyzed.target.policyStatus || Number(policy.currentVersion) !== analyzed.target.policyVersion) {
            throw new ApiError(409, PREVIEW_STALE_MESSAGE, [{ field: 'previewHash', code: 'preview_stale', severity: 'error', message: PREVIEW_STALE_MESSAGE }]);
          }
          const { version } = await appendPolicyVersion({
            organizationId,
            session,
            policy,
            version: { spec: specFromRule(rule) as unknown as Record<string, unknown>, changeNote: updateNote, createdBy: actor },
            set: () => ({
              title: rule.title,
              category: rule.category,
              channels: rule.channels,
              ruleFormat: 'structured_v1',
              lastEditedBy: actor,
              'sourceRef.importBatchId': batchId,
              'sourceRef.importItemId': itemId,
            }),
            audit: (next) => [auditEntry('draft_saved', actor, { version: next, note: updateNote })],
          });
          touchedPolicyIds.push(String(policy._id));
          Object.assign(target, { policyId: policy._id, version });
          proposalsUpdated += 1;
        }

        const retentionClass = analyzed.privacyBlocked ? undefined : retentionFor(analyzed.status);
        const item: any = {
          _id: itemId,
          organizationId,
          batchId,
          batchNumber,
          rowNumber: analyzed.row.rowNumber,
          type: analyzed.privacyBlocked && analyzed.row.unsupportedType ? 'unknown' : analyzed.row.values.type.slice(0, 30) || 'unknown',
          status: analyzed.status,
          issueCodes: Array.from(new Set(analyzed.issues.map((issue) => issue.code))).slice(0, 30),
          fingerprint: analyzed.fingerprint,
          locationScope: analyzed.privacyBlocked
            ? { kind: 'none' }
            : { kind: analyzed.location.scope, locationId: analyzed.location.locationId, locationCode: analyzed.location.locationCode },
          target,
          contentRetained: Boolean(retentionClass),
        };
        if (!analyzed.privacyBlocked) {
          if (analyzed.sourceKey) item.sourceKey = analyzed.sourceKey;
          if (analyzed.keyRevision) item.keyRevision = analyzed.keyRevision;
          if (analyzed.title) item.title = analyzed.title;
          if (analyzed.row.values.sourceRef) item.sourceRef = analyzed.row.values.sourceRef;
          if (analyzed.location.label) item.sourceLocationLabel = analyzed.location.label;
          if (analyzed.row.values.sourceStatus) item.sourceStatus = analyzed.row.values.sourceStatus;
        }
        if (analyzed.nameReviewed) item.nameReview = { by: actor, at: now };
        if (retentionClass) {
          const expiresAt = new Date(now.getTime() + IMPORT_RETENTION_DAYS[retentionClass] * DAY_MS);
          item.retentionClass = retentionClass;
          item.contentExpiresAt = expiresAt;
          contents.push({
            organizationId,
            batchId,
            itemId,
            retentionClass,
            fields: contentFields(analyzed.row.values),
            mappedPayload: mappedPayloadFor(analyzed),
            expiresAt,
          });
        }
        items.push(item);
      }

      await AiTrainingImportItem.insertMany(items, options);
      if (contents.length) await AiTrainingImportContent.insertMany(contents, options);
      const statusCounts = Object.fromEntries(Object.entries(analysis.counts).filter(([, count]) => count > 0));
      await AiTrainingImportBatch.create([{
        _id: batchId,
        organizationId,
        batchNumber,
        sourceSystem: 'podium',
        mode: analysis.options.mode,
        fullSnapshot: analysis.options.fullSnapshot,
        format: analysis.parsed.format,
        fileName: analysis.fileName,
        fileNameWithheld: analysis.fileNameWithheld || undefined,
        contentSha256: analysis.parsed.contentSha256,
        contentBytes: analysis.parsed.contentBytes,
        rowCount: analysis.rows.length,
        statusCounts,
        proposalsCreated,
        proposalsUpdated,
        locationMappings: analysis.locationMappings,
        businessContacts: analysis.options.businessContacts,
        attestation: { confirmed: true, version: IMPORT_ATTESTATION_VERSION, by: actor, at: now },
        retention: { convertedDays: IMPORT_RETENTION_DAYS.converted, parkedDays: IMPORT_RETENTION_DAYS.parked, rejectedDays: IMPORT_RETENTION_DAYS.rejected },
        missingFromSnapshot: analysis.missingFromSnapshot.map(({ sourceKey, itemId, title }) => ({ sourceKey, itemId, title })),
        missingFromSnapshotCount: analysis.missingFromSnapshot.length,
        engineVersion: IMPORT_ENGINE_VERSION,
        previewHash: analysis.previewHash,
        createdBy: actor,
      }], options);
      committed = true;
      const summary = Object.entries(statusCounts).map(([status, count]) => `${count} ${status.replace(/_/g, ' ')}`).join(', ');
      await AiTrainingAuditLog.create([{
        organizationId,
        action: 'import_committed',
        actor,
        importBatchId: batchId,
        toStatus: 'committed',
        note: `Batch #${batchNumber}: ${proposalsCreated} draft proposal(s) created, ${proposalsUpdated} updated. ${summary}`.slice(0, 500),
      }], options);
      return { batchId: String(batchId), batchNumber };
    });
    for (const policyId of touchedPolicyIds) await flushPolicyAudit(organizationId, policyId);
    return result;
  } catch (err) {
    if (nonTransactional && !committed && attemptBatchId) {
      await AiTrainingImportContent.deleteMany({ organizationId, batchId: attemptBatchId }).catch((cleanupErr: any) => {
        logger.error({ organizationId, errorName: cleanupErr?.name }, '[AiTrainingImport] Could not remove content from a failed import');
      });
      if (createdPolicyIds.length) {
        await AiTrainingPolicy.deleteMany({ organizationId, _id: { $in: createdPolicyIds }, source: 'podium_import', 'sourceRef.importBatchId': attemptBatchId }).catch((cleanupErr: any) => {
          logger.error({ organizationId, errorName: cleanupErr?.name }, '[AiTrainingImport] Could not remove draft proposals from a failed import');
        });
      }
    }
    if (nonTransactional && committed) {
      logger.error({ organizationId, batchId: String(attemptBatchId) }, '[AiTrainingImport] Import saved but its audit record failed');
      for (const policyId of touchedPolicyIds) await flushPolicyAudit(organizationId, policyId);
      return { batchId: String(attemptBatchId), batchNumber: undefined };
    }
    if (isDuplicateKeyError(err)) throw new ApiError(409, RACE_MESSAGE, [{ field: 'previewHash', code: 'import_race', severity: 'error', message: RACE_MESSAGE }]);
    throw err;
  }
}

export async function loadImportBatch(organizationId: string, batchId: string) {
  if (!mongoose.isValidObjectId(batchId)) throw new ApiError(404, 'Import not found');
  const batch: any = await AiTrainingImportBatch.findOne({ _id: batchId, organizationId }).lean();
  if (!batch) throw new ApiError(404, 'Import not found');
  return batch;
}

async function purgeTimes(organizationId: string, batchIds: any[]): Promise<Map<string, Date>> {
  if (!batchIds.length) return new Map();
  const rows: any[] = await AiTrainingAuditLog.find({ organizationId, action: 'import_content_purged', importBatchId: { $in: batchIds } })
    .select('importBatchId createdAt').sort({ createdAt: 1 }).lean();
  return new Map(rows.map((row) => [String(row.importBatchId), row.createdAt]));
}

async function storedCounts(organizationId: string, batchIds: any[]): Promise<Map<string, number>> {
  if (!batchIds.length) return new Map();
  const rows: any[] = await AiTrainingImportContent.aggregate([
    { $match: { organizationId, batchId: { $in: batchIds.map((id) => new mongoose.Types.ObjectId(String(id))) } } },
    { $group: { _id: '$batchId', count: { $sum: 1 } } },
  ]).option({ maxTimeMS: DB_MAX_TIME_MS });
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

export function serializeBatch(batch: any, extra: { stored?: number; purgedAt?: Date; canPurge: boolean }) {
  const counts = batch.statusCounts instanceof Map ? Object.fromEntries(batch.statusCounts) : (batch.statusCounts || {});
  return {
    id: String(batch._id),
    batchNumber: batch.batchNumber,
    sourceSystem: batch.sourceSystem,
    mode: batch.mode,
    fullSnapshot: batch.fullSnapshot,
    format: batch.format,
    fileName: batch.fileName || undefined,
    fileNameWithheld: batch.fileNameWithheld || false,
    contentSha256: batch.contentSha256,
    rowCount: batch.rowCount,
    statusCounts: counts,
    proposalsCreated: batch.proposalsCreated,
    proposalsUpdated: batch.proposalsUpdated,
    locationMappings: (batch.locationMappings || []).map((mapping: any) => ({
      sourceLabel: mapping.sourceLabel, scope: mapping.scope, locationId: mapping.locationId ? String(mapping.locationId) : undefined, locationCode: mapping.locationCode,
    })),
    businessContacts: (batch.businessContacts || []).map((contact: any) => ({ kind: contact.kind, value: contact.value })),
    attestation: batch.attestation ? { version: batch.attestation.version, byName: batch.attestation.by?.name, at: batch.attestation.at } : undefined,
    retention: batch.retention,
    missingFromSnapshotCount: batch.missingFromSnapshotCount || 0,
    engineVersion: batch.engineVersion,
    createdByName: batch.createdBy?.name,
    createdAt: batch.createdAt,
    storedOriginals: extra.stored ?? 0,
    purgedAt: extra.purgedAt,
    canPurge: extra.canPurge,
  };
}

export async function listImportBatches(input: { organizationId: string; user: any; page: number; limit: number }) {
  const filter = { organizationId: input.organizationId };
  const [rows, total] = await Promise.all([
    AiTrainingImportBatch.find(filter).sort({ createdAt: -1, _id: -1 }).skip((input.page - 1) * input.limit).limit(input.limit).lean(),
    AiTrainingImportBatch.countDocuments(filter),
  ]);
  const ids = rows.map((row: any) => row._id);
  const [stored, purged] = await Promise.all([storedCounts(input.organizationId, ids), purgeTimes(input.organizationId, ids)]);
  const canPurge = trainingRole(input.user) === 'admin';
  return {
    batches: rows.map((row: any) => serializeBatch(row, { stored: stored.get(String(row._id)) || 0, purgedAt: purged.get(String(row._id)), canPurge })),
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

function contentStatus(item: any, hasContent: boolean, purgedAt?: Date): 'stored' | 'not_stored' | 'purged' | 'expired' | 'removed' {
  if (hasContent) return 'stored';
  if (!item.contentRetained) return 'not_stored';
  if (purgedAt) return 'purged';
  if (item.contentExpiresAt && new Date(item.contentExpiresAt).getTime() <= Date.now()) return 'expired';
  return 'removed';
}

function serializeItem(item: any, extra: { hasContent: boolean; purgedAt?: Date; knowledge?: KnowledgeImportStatus }) {
  return {
    id: String(item._id),
    rowNumber: item.rowNumber,
    type: item.type,
    status: item.status,
    issueCodes: item.issueCodes || [],
    title: item.title || undefined,
    sourceRef: item.sourceRef || undefined,
    sourceLocationLabel: item.sourceLocationLabel || undefined,
    sourceStatus: item.sourceStatus || undefined,
    locationScope: {
      kind: item.locationScope?.kind,
      locationId: item.locationScope?.locationId ? String(item.locationScope.locationId) : undefined,
      locationCode: item.locationScope?.locationCode,
    },
    fingerprint: item.fingerprint,
    keyRevision: item.keyRevision,
    target: {
      kind: item.target?.kind,
      policyId: item.target?.policyId ? String(item.target.policyId) : undefined,
      version: item.target?.version,
      previousPolicyId: item.target?.previousPolicyId ? String(item.target.previousPolicyId) : undefined,
      previousItemId: item.target?.previousItemId ? String(item.target.previousItemId) : undefined,
    },
    retentionClass: item.retentionClass,
    contentExpiresAt: item.contentExpiresAt,
    contentStatus: contentStatus(item, extra.hasContent, extra.purgedAt),
    purgedAt: item.contentRetained && !extra.hasContent ? extra.purgedAt : undefined,
    nameReviewedBy: item.nameReview?.by?.name,
    knowledge: extra.knowledge,
    createdAt: item.createdAt,
  };
}

export async function getImportBatchDetail(input: { organizationId: string; user: any; batchId: string; status?: unknown; page: number; limit: number }) {
  const batch = await loadImportBatch(input.organizationId, input.batchId);
  const filter: Record<string, unknown> = { organizationId: input.organizationId, batchId: batch._id };
  if (input.status !== undefined && input.status !== '') {
    if (!(IMPORT_ITEM_STATUSES as readonly string[]).includes(String(input.status))) throw new ApiError(400, 'Unknown status filter');
    filter.status = String(input.status);
  }
  const [items, total, stored, purged] = await Promise.all([
    AiTrainingImportItem.find(filter).sort({ rowNumber: 1 }).skip((input.page - 1) * input.limit).limit(input.limit).lean(),
    AiTrainingImportItem.countDocuments(filter),
    storedCounts(input.organizationId, [batch._id]),
    purgeTimes(input.organizationId, [batch._id]),
  ]);
  const withContent = new Set((await AiTrainingImportContent.find({ organizationId: input.organizationId, itemId: { $in: items.map((item: any) => item._id) } })
    .select('itemId').lean()).map((row: any) => String(row.itemId)));
  const purgedAt = purged.get(String(batch._id));
  const knowledgeCandidates: any[] = await AiTrainingImportItem.find({ organizationId: input.organizationId, batchId: batch._id, status: 'parked_knowledge' })
    .select('_id batchId type status sourceKey keyRevision locationScope rowNumber').limit(500).lean();
  const knowledge = await knowledgeImportStatuses(input.organizationId, knowledgeCandidates);
  const knowledgeCounts: Partial<Record<KnowledgeImportState, number>> = {};
  for (const status of knowledge.statuses.values()) knowledgeCounts[status.state] = (knowledgeCounts[status.state] || 0) + 1;
  return {
    batch: serializeBatch(batch, { stored: stored.get(String(batch._id)) || 0, purgedAt, canPurge: trainingRole(input.user) === 'admin' }),
    knowledge: knowledge.statuses.size ? { enabled: knowledge.enabled, counts: knowledgeCounts } : undefined,
    missingFromSnapshot: (batch.missingFromSnapshot || []).map((entry: any) => ({ itemId: String(entry.itemId), title: entry.title || undefined })),
    items: items.map((item: any) => serializeItem(item, { hasContent: withContent.has(String(item._id)), purgedAt, knowledge: knowledge.statuses.get(String(item._id)) })),
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

export async function getImportItemDetail(input: { organizationId: string; batchId: string; itemId: string }) {
  const batch = await loadImportBatch(input.organizationId, input.batchId);
  if (!mongoose.isValidObjectId(input.itemId)) throw new ApiError(404, 'Import item not found');
  const item: any = await AiTrainingImportItem.findOne({ _id: input.itemId, organizationId: input.organizationId, batchId: batch._id }).lean();
  if (!item) throw new ApiError(404, 'Import item not found');
  const [content, purged, policy]: any[] = await Promise.all([
    AiTrainingImportContent.findOne({ organizationId: input.organizationId, itemId: item._id }).lean(),
    purgeTimes(input.organizationId, [batch._id]),
    item.target?.policyId ? AiTrainingPolicy.findOne({ _id: item.target.policyId, organizationId: input.organizationId }).select('title status currentVersion').lean() : Promise.resolve(null),
  ]);
  const purgedAt = purged.get(String(batch._id));
  return {
    batch: { id: String(batch._id), batchNumber: batch.batchNumber, createdAt: batch.createdAt, createdByName: batch.createdBy?.name, format: batch.format },
    item: serializeItem(item, { hasContent: Boolean(content), purgedAt }),
    original: content ? { fields: content.fields, mappedPayload: content.mappedPayload, expiresAt: content.expiresAt } : undefined,
    linkedProposal: policy ? { id: String(policy._id), title: policy.title, status: policy.status, currentVersion: policy.currentVersion } : undefined,
  };
}

export async function purgeImportContent(input: { organizationId: string; user: any; batchId: string; confirmation: unknown }) {
  requireImportAdmin(input.user);
  const batch = await loadImportBatch(input.organizationId, input.batchId);
  const expected = `PURGE BATCH ${batch.batchNumber}`;
  if (typeof input.confirmation !== 'string' || input.confirmation.trim() !== expected) {
    badRequest(`Type ${expected} to confirm.`, 'confirmation', 'confirmation_required');
  }
  const actor = trainingActor(input.user);
  const purged = await runTrainingWrite(async (session) => {
    const options = session ? { session } : {};
    const result = await AiTrainingImportContent.deleteMany({ organizationId: input.organizationId, batchId: batch._id }, options);
    const count = Number(result.deletedCount || 0);
    if (count) {
      await AiTrainingAuditLog.create([{
        organizationId: input.organizationId,
        action: 'import_content_purged',
        actor,
        importBatchId: batch._id,
        toStatus: 'purged',
        note: `Removed ${count} stored original${count === 1 ? '' : 's'} from import batch #${batch.batchNumber}`,
      }], options);
    }
    return count;
  });
  return { purged, batchNumber: batch.batchNumber };
}
