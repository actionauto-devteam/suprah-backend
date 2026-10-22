import crypto from 'crypto';
import mongoose, { ClientSession } from 'mongoose';
import AiTrainingScenario, {
  IAiTrainingScenario,
  SCENARIO_CHANNELS,
  SCENARIO_EXPECTED_HANDLING,
  SCENARIO_TURN_AUTHORS,
  ScenarioContent,
} from '../models/AiTrainingScenario.model';
import AiTrainingScenarioRevision, { ScenarioRevisionAction } from '../models/AiTrainingScenarioRevision.model';
import AiTrainingTestRun, { TEST_RUN_RETENTION_DAYS, TestRunMode } from '../models/AiTrainingTestRun.model';
import AiTrainingPolicyVersion from '../models/AiTrainingPolicyVersion.model';
import { ApiError } from '../utils/ApiError';
import { isDemoPhone } from '../utils/demoPhone';
import {
  adoptedVersionList,
  canReviewTraining,
  loadVisibleProposal,
  runTrainingWrite,
  trainingActor,
  TrainingRole,
} from './aiTraining.service';
import { ruleFromSpec } from './aiTrainingRules.service';
import { evaluateScenario, LAB_ENGINE_VERSION } from './aiTrainingLabEvaluator';

export const LAB_LIMITS = {
  activeScenariosPerOrg: 500,
  batchSize: 20,
  revisionsPerScenario: 100,
  titleMin: 3,
  title: 120,
  customerName: 60,
  vehicleInterest: 120,
  turns: 8,
  turnBody: 500,
  message: 500,
  listItems: 5,
  includeItems: 8,
  listItem: 200,
  notes: 300,
  tags: 8,
  tag: 40,
  reply: 1000,
  changeNote: 300,
} as const;

export interface LabIssue {
  field: string;
  code: string;
  message: string;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
export const EMAIL_PATTERN = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/gi;
export const FICTIONAL_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|test|example|invalid|localhost)$/i;
export const VIN_PATTERN = /\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/i;
export const RECORD_ID_PATTERN = /\b[a-f0-9]{24}\b/i;
export const URL_PATTERN = /\bhttps?:\/\/([^\s/]+)|\bwww\.([^\s/]+)/gi;
export const STREET_PATTERN = /\b\d{2,6}\s+(?:[a-z0-9]+\s){0,3}(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|circle|parkway|pkwy)\b/i;
export const MOCK_DIRECTIVE_PATTERN = /\[mock:/i;

export function fictionalDataIssues(field: string, text: string): { errors: LabIssue[]; warnings: LabIssue[] } {
  const errors: LabIssue[] = [];
  const warnings: LabIssue[] = [];
  if (!text) return { errors, warnings };
  for (const match of text.matchAll(PHONE_PATTERN)) {
    if (!isDemoPhone(match[0])) {
      errors.push({ field, code: 'real_phone', message: 'Use only fictional phone numbers in the 555-01xx range, for example 801-555-0142.' });
      break;
    }
  }
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    if (!FICTIONAL_EMAIL_DOMAIN.test(match[1])) {
      errors.push({ field, code: 'real_email', message: 'Use only fictional email addresses at example.com.' });
      break;
    }
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const host = String(match[1] || match[2] || '').replace(/[.,;:!?)]+$/, '');
    if (!FICTIONAL_EMAIL_DOMAIN.test(host)) {
      errors.push({ field, code: 'real_link', message: 'Links are not allowed in scenarios except example.com.' });
      break;
    }
  }
  if (VIN_PATTERN.test(text)) errors.push({ field, code: 'vin', message: 'Do not enter a real VIN.' });
  if (RECORD_ID_PATTERN.test(text)) errors.push({ field, code: 'record_id', message: 'Do not paste record IDs from the CRM.' });
  if (MOCK_DIRECTIVE_PATTERN.test(text)) errors.push({ field, code: 'mock_directive', message: 'Local QA directives are not allowed in scenarios.' });
  if (STREET_PATTERN.test(text)) warnings.push({ field, code: 'street_address', message: 'This looks like a street address. Use a made-up address.' });
  return { errors, warnings };
}

function cleanText(raw: unknown, field: string, label: string, max: number, issues: LabIssue[], required = false, min = 1): string {
  if (raw === undefined || raw === null) {
    if (required) issues.push({ field, code: 'required', message: `${label} is required.` });
    return '';
  }
  if (typeof raw !== 'string') {
    issues.push({ field, code: 'invalid_type', message: `${label} must be text.` });
    return '';
  }
  const value = raw.replace(CONTROL_CHARS, '').replace(/\r\n/g, '\n').trim();
  if (required && value.length < min) issues.push({ field, code: 'required', message: min > 1 ? `${label} needs at least ${min} characters.` : `${label} is required.` });
  if (value.length > max) issues.push({ field, code: 'too_long', message: `${label} can be at most ${max} characters.` });
  return value.slice(0, max);
}

function cleanList(raw: unknown, field: string, label: string, maxItems: number, maxLength: number, issues: LabIssue[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push({ field, code: 'invalid_type', message: `${label} must be a list.` });
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push({ field: `${field}.${index}`, code: 'invalid_type', message: `Each item in ${label.toLowerCase()} must be text.` });
      return;
    }
    const value = item.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
    if (!value) return;
    if (value.length > maxLength) issues.push({ field: `${field}.${index}`, code: 'too_long', message: `Each item in ${label.toLowerCase()} can be at most ${maxLength} characters.` });
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(value.slice(0, maxLength));
  });
  if (items.length > maxItems) issues.push({ field, code: 'too_many', message: `${label} can have at most ${maxItems} items.` });
  return items.slice(0, maxItems);
}

export function parseScenarioInput(raw: unknown): { content: Omit<ScenarioContent, 'archived'>; errors: LabIssue[]; warnings: LabIssue[] } {
  const errors: LabIssue[] = [];
  const input: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push({ field: 'scenario', code: 'invalid_type', message: 'The scenario is missing or malformed.' });
  const L = LAB_LIMITS;

  const channel = SCENARIO_CHANNELS.includes(input.channel) ? input.channel : 'sms';
  if (input.channel !== undefined && !SCENARIO_CHANNELS.includes(input.channel)) {
    errors.push({ field: 'channel', code: 'invalid_value', message: 'Channel must be SMS, website chat or email.' });
  }
  const expectationInput: any = input.expectation && typeof input.expectation === 'object' && !Array.isArray(input.expectation) ? input.expectation : {};
  if (input.expectation !== undefined && expectationInput !== input.expectation) {
    errors.push({ field: 'expectation', code: 'invalid_type', message: 'The expectation is malformed.' });
  }
  const handling = expectationInput.handling;
  if (!SCENARIO_EXPECTED_HANDLING.includes(handling)) {
    errors.push({ field: 'expectation.handling', code: 'required', message: 'Choose the expected handling.' });
  }
  const flagsInput: any = input.flags && typeof input.flags === 'object' && !Array.isArray(input.flags) ? input.flags : {};

  const turns: ScenarioContent['turns'] = [];
  if (input.turns !== undefined && input.turns !== null) {
    if (!Array.isArray(input.turns)) {
      errors.push({ field: 'turns', code: 'invalid_type', message: 'Earlier messages must be a list.' });
    } else {
      if (input.turns.length > L.turns) errors.push({ field: 'turns', code: 'too_many', message: `Add at most ${L.turns} earlier messages.` });
      input.turns.slice(0, L.turns).forEach((turn: any, index: number) => {
        if (!turn || typeof turn !== 'object' || !SCENARIO_TURN_AUTHORS.includes(turn.from)) {
          errors.push({ field: `turns.${index}`, code: 'invalid_value', message: `Earlier message ${index + 1} needs a valid sender.` });
          return;
        }
        const body = cleanText(turn.body, `turns.${index}.body`, `Earlier message ${index + 1}`, L.turnBody, errors, true);
        if (body) turns.push({ from: turn.from, body });
      });
    }
  }

  const content: Omit<ScenarioContent, 'archived'> = {
    title: cleanText(input.title, 'title', 'Title', L.title, errors, true, L.titleMin),
    channel,
    customerName: cleanText(input.customerName, 'customerName', 'Customer name', L.customerName, errors) || undefined,
    vehicleInterest: cleanText(input.vehicleInterest, 'vehicleInterest', 'Vehicle interest', L.vehicleInterest, errors) || undefined,
    turns,
    message: cleanText(input.message, 'message', 'Customer message', L.message, errors, true),
    flags: {
      hasUpcomingAppointment: flagsInput.hasUpcomingAppointment === true,
      previouslyOptedOut: flagsInput.previouslyOptedOut === true,
    },
    expectation: {
      handling: SCENARIO_EXPECTED_HANDLING.includes(handling) ? handling : 'ai_handles',
      mustAsk: cleanList(expectationInput.mustAsk, 'expectation.mustAsk', 'Questions Alex must ask', L.listItems, L.listItem, errors),
      mustInclude: cleanList(expectationInput.mustInclude, 'expectation.mustInclude', 'Things to include', L.includeItems, L.listItem, errors),
      mustAvoid: cleanList(expectationInput.mustAvoid, 'expectation.mustAvoid', 'Things to avoid', L.includeItems, L.listItem, errors),
      notes: cleanText(expectationInput.notes, 'expectation.notes', 'Notes', L.notes, errors) || undefined,
    },
    tags: cleanList(input.tags, 'tags', 'Tags', L.tags, L.tag, errors),
  };

  const warnings: LabIssue[] = [];
  const texts: Array<[string, string | undefined]> = [
    ['title', content.title],
    ['customerName', content.customerName],
    ['vehicleInterest', content.vehicleInterest],
    ['message', content.message],
    ...content.turns.map((turn, index) => [`turns.${index}.body`, turn.body] as [string, string]),
    ...content.expectation.mustAsk.map((text, index) => [`expectation.mustAsk.${index}`, text] as [string, string]),
    ...content.expectation.mustInclude.map((text, index) => [`expectation.mustInclude.${index}`, text] as [string, string]),
    ...content.expectation.mustAvoid.map((text, index) => [`expectation.mustAvoid.${index}`, text] as [string, string]),
    ['expectation.notes', content.expectation.notes],
    ...content.tags.map((text, index) => [`tags.${index}`, text] as [string, string]),
  ];
  for (const [field, text] of texts) {
    const found = fictionalDataIssues(field, text || '');
    errors.push(...found.errors);
    warnings.push(...found.warnings);
  }
  return { content, errors, warnings };
}

function requireScenarioInput(raw: unknown) {
  const parsed = parseScenarioInput(raw);
  if (parsed.errors.length) throw new ApiError(400, parsed.errors[0].message, parsed.errors);
  return parsed;
}

function cleanChangeNote(value: unknown): string | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError(400, 'The change note must be text');
  const note = String(value || '').replace(CONTROL_CHARS, '').trim();
  if (note.length > LAB_LIMITS.changeNote) throw new ApiError(400, `Change notes can be at most ${LAB_LIMITS.changeNote} characters`);
  return note || undefined;
}

function isReviewer(user: any): boolean {
  return canReviewTraining(trainingActor(user).role as TrainingRole);
}

export function canManageScenario(user: any, scenario: { createdBy?: { userId?: string } }): boolean {
  return isReviewer(user) || scenario.createdBy?.userId === String(user?._id || '');
}

export async function loadScenario(organizationId: string, scenarioId: string): Promise<IAiTrainingScenario> {
  if (!mongoose.isValidObjectId(scenarioId)) throw new ApiError(404, 'Scenario not found');
  const scenario = await AiTrainingScenario.findOne({ _id: scenarioId, organizationId });
  if (!scenario) throw new ApiError(404, 'Scenario not found');
  return scenario;
}

function contentOf(scenario: any): ScenarioContent {
  return {
    title: scenario.title,
    channel: scenario.channel,
    customerName: scenario.customerName || undefined,
    vehicleInterest: scenario.vehicleInterest || undefined,
    turns: (scenario.turns || []).map((turn: any) => ({ from: turn.from, body: turn.body })),
    message: scenario.message,
    flags: { hasUpcomingAppointment: Boolean(scenario.flags?.hasUpcomingAppointment), previouslyOptedOut: Boolean(scenario.flags?.previouslyOptedOut) },
    expectation: {
      handling: scenario.expectation?.handling,
      mustAsk: [...(scenario.expectation?.mustAsk || [])],
      mustInclude: [...(scenario.expectation?.mustInclude || [])],
      mustAvoid: [...(scenario.expectation?.mustAvoid || [])],
      notes: scenario.expectation?.notes || undefined,
    },
    tags: [...(scenario.tags || [])],
    archived: Boolean(scenario.archived),
  };
}

const withSession = (session: ClientSession | null) => (session ? { session } : {});
const CONFLICT = 'This scenario was just changed by someone else. Refresh and try again.';

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ''));
}

export async function createScenario(input: { organizationId: string; user: any; scenario: unknown }) {
  const { content, warnings } = requireScenarioInput(input.scenario);
  const active = await AiTrainingScenario.countDocuments({ organizationId: input.organizationId, archived: false });
  if (active >= LAB_LIMITS.activeScenariosPerOrg) throw new ApiError(409, `Your organization already has ${LAB_LIMITS.activeScenariosPerOrg} active scenarios. Archive some first.`);
  const actor = trainingActor(input.user);
  const scenario = await runTrainingWrite(async (session) => {
    const scenarioId = new mongoose.Types.ObjectId();
    await AiTrainingScenarioRevision.create([{
      organizationId: input.organizationId, scenarioId, revision: 1, action: 'created', content: { ...content, archived: false }, createdBy: actor,
    }], withSession(session));
    const [created] = await AiTrainingScenario.create([{
      _id: scenarioId, organizationId: input.organizationId, ...content, archived: false, revision: 1, adoptedRevisions: [1],
      createdBy: actor, lastEditedBy: actor,
    }], withSession(session));
    return created;
  });
  return { scenario, warnings };
}

async function appendScenarioRevision(input: {
  organizationId: string;
  scenario: IAiTrainingScenario;
  user: any;
  action: ScenarioRevisionAction;
  content: ScenarioContent;
  changeNote?: string;
  set: Record<string, unknown>;
}) {
  const actor = trainingActor(input.user);
  const snapshot = input.scenario.toObject();
  return runTrainingWrite(async (session) => {
    const rows = await AiTrainingScenarioRevision.find({ organizationId: input.organizationId, scenarioId: snapshot._id })
      .select('revision').session(session).lean();
    const existing = rows.map((row: any) => Number(row.revision));
    if (existing.length >= LAB_LIMITS.revisionsPerScenario) throw new ApiError(409, 'This scenario has too many revisions. Create a new scenario instead.');
    const next = Math.max(Number(snapshot.revision), ...existing) + 1;
    try {
      await AiTrainingScenarioRevision.create([{
        organizationId: input.organizationId, scenarioId: snapshot._id, revision: next, action: input.action,
        content: input.content, changeNote: input.changeNote, createdBy: actor,
      }], withSession(session));
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ApiError(409, CONFLICT);
      throw err;
    }
    const adopted = snapshot.adoptedRevisions?.length ? snapshot.adoptedRevisions : [Number(snapshot.revision)];
    const updated = await AiTrainingScenario.findOneAndUpdate(
      { _id: snapshot._id, organizationId: input.organizationId, revision: snapshot.revision },
      { $set: { ...input.set, revision: next, adoptedRevisions: [...adopted, next], lastEditedBy: actor } },
      { new: true, ...withSession(session) },
    );
    if (!updated) throw new ApiError(409, CONFLICT);
    return updated;
  });
}

function requireExpectedRevision(value: unknown, scenario: IAiTrainingScenario) {
  if (value === undefined || value === null || value === '') throw new ApiError(400, 'expectedRevision is required');
  if (Number(value) !== scenario.revision) throw new ApiError(409, CONFLICT);
}

export async function updateScenario(input: { organizationId: string; scenarioId: string; user: any; scenario: unknown; expectedRevision: unknown; changeNote?: unknown }) {
  const scenario = await loadScenario(input.organizationId, input.scenarioId);
  if (!canManageScenario(input.user, scenario)) throw new ApiError(403, 'Only the author or a manager can edit this scenario');
  if (scenario.archived) throw new ApiError(409, 'Restore this scenario before editing it');
  requireExpectedRevision(input.expectedRevision, scenario);
  const { content, warnings } = requireScenarioInput(input.scenario);
  const updated = await appendScenarioRevision({
    organizationId: input.organizationId, scenario, user: input.user, action: 'edited',
    content: { ...content, archived: false }, changeNote: cleanChangeNote(input.changeNote),
    set: { ...content, customerName: content.customerName ?? null, vehicleInterest: content.vehicleInterest ?? null },
  });
  return { scenario: updated, warnings };
}

export async function setScenarioArchived(input: { organizationId: string; scenarioId: string; user: any; archived: boolean; expectedRevision: unknown; changeNote?: unknown }) {
  const scenario = await loadScenario(input.organizationId, input.scenarioId);
  if (!canManageScenario(input.user, scenario)) throw new ApiError(403, 'Only the author or a manager can change this scenario');
  if (scenario.archived === input.archived) throw new ApiError(409, input.archived ? 'This scenario is already archived' : 'This scenario is not archived');
  requireExpectedRevision(input.expectedRevision, scenario);
  if (!input.archived) {
    const active = await AiTrainingScenario.countDocuments({ organizationId: input.organizationId, archived: false });
    if (active >= LAB_LIMITS.activeScenariosPerOrg) throw new ApiError(409, `Your organization already has ${LAB_LIMITS.activeScenariosPerOrg} active scenarios.`);
  }
  return appendScenarioRevision({
    organizationId: input.organizationId, scenario, user: input.user, action: input.archived ? 'archived' : 'restored',
    content: { ...contentOf(scenario), archived: input.archived }, changeNote: cleanChangeNote(input.changeNote),
    set: input.archived ? { archived: true, archivedAt: new Date() } : { archived: false, archivedAt: null },
  });
}

export async function listScenarioRevisions(organizationId: string, scenarioId: string) {
  const scenario = await loadScenario(organizationId, scenarioId);
  const adopted = new Set(scenario.adoptedRevisions?.length ? scenario.adoptedRevisions : [scenario.revision]);
  const rows = await AiTrainingScenarioRevision.find({ organizationId, scenarioId: scenario._id }).sort({ revision: -1 }).lean();
  return rows.filter((row: any) => adopted.has(Number(row.revision)));
}

export function specHash(spec: unknown): string {
  const stable = (value: any): any => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.keys(value).filter((key) => key !== '_id').sort().reduce((out: any, key) => { out[key] = stable(value[key]); return out; }, {});
    }
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(spec))).digest('hex');
}

type LabRunInput = {
  organizationId: string;
  user: any;
  policyId: unknown;
  version: unknown;
  mode: unknown;
  reply?: unknown;
};

type PreparedRun = Awaited<ReturnType<typeof prepareRun>>;

async function prepareRun(input: LabRunInput) {
  const actor = trainingActor(input.user);
  const mode = input.mode as TestRunMode;
  if (mode !== 'rules_only' && mode !== 'sample_reply') throw new ApiError(400, 'Choose a test mode: rules only or sample reply');
  const policy = await loadVisibleProposal(input.organizationId, String(input.policyId || ''), input.user);
  const versionNumber = Number(input.version);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new ApiError(400, 'Choose a proposal version to test');
  const versionDocs = await AiTrainingPolicyVersion.find({ organizationId: input.organizationId, policyId: policy._id }).select('version').lean();
  const adopted = adoptedVersionList(policy.toObject(), versionDocs.map((row: any) => Number(row.version)));
  if (!adopted.includes(versionNumber)) throw new ApiError(404, 'That version of the proposal was not found');
  const version: any = await AiTrainingPolicyVersion.findOne({ organizationId: input.organizationId, policyId: policy._id, version: versionNumber }).lean();
  if (!version) throw new ApiError(404, 'That version of the proposal was not found');

  let reply: { source: 'written' | 'rule_example'; exampleIndex?: number; text: string } | undefined;
  if (mode === 'sample_reply') {
    const replyInput: any = input.reply && typeof input.reply === 'object' && !Array.isArray(input.reply) ? input.reply : null;
    if (!replyInput) throw new ApiError(400, 'Add a sample reply or choose one of the rule examples');
    if (replyInput.source === 'rule_example') {
      const index = Number(replyInput.exampleIndex);
      const example = Number.isInteger(index) ? version.spec?.examples?.[index] : undefined;
      if (!example) throw new ApiError(400, 'That rule example does not exist');
      reply = { source: 'rule_example', exampleIndex: index, text: String(example.idealReply).slice(0, LAB_LIMITS.reply) };
    } else if (replyInput.source === 'written') {
      const errors: LabIssue[] = [];
      const text = cleanText(replyInput.text, 'reply.text', 'Sample reply', LAB_LIMITS.reply, errors, true);
      errors.push(...fictionalDataIssues('reply.text', text).errors);
      if (errors.length) throw new ApiError(400, errors[0].message, errors);
      reply = { source: 'written', text };
    } else {
      throw new ApiError(400, 'Add a sample reply or choose one of the rule examples');
    }
  }

  return {
    actor,
    mode,
    policy,
    version,
    versionNumber,
    reply,
    rule: ruleFromSpec(version.spec, policy),
    specHash: specHash(version.spec),
  };
}

function buildRun(organizationId: string, prepared: PreparedRun, scenario: any, now: Date) {
  const snapshot = contentOf(scenario);
  const result = evaluateScenario({ rule: prepared.rule, scenario: snapshot, reply: prepared.reply ? { text: prepared.reply.text } : null });
  return {
    organizationId,
    policyId: prepared.policy._id,
    policyVersion: prepared.versionNumber,
    policyStatusAtRun: prepared.policy.status,
    policyTitle: String(prepared.version.spec?.title || prepared.policy.title).slice(0, 120),
    policyAuthorId: String(prepared.policy.createdBy?.userId || ''),
    policySpecHash: prepared.specHash,
    ruleFormat: prepared.version.spec?.format || 'instruction',
    scenarioId: scenario._id,
    scenarioRevision: scenario.revision,
    scenarioSnapshot: snapshot,
    channel: snapshot.channel,
    mode: prepared.mode,
    reply: prepared.reply,
    engineVersion: LAB_ENGINE_VERSION,
    checks: result.checks,
    counts: result.counts,
    verdict: result.verdict,
    includesApproximate: result.includesApproximate,
    runBy: prepared.actor,
    expiresAt: new Date(now.getTime() + TEST_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  };
}

export async function runScenarioTest(input: LabRunInput & { scenarioId: unknown }) {
  const prepared = await prepareRun(input);
  const scenario = await loadScenario(input.organizationId, String(input.scenarioId || ''));
  if (scenario.archived) throw new ApiError(409, 'Archived scenarios cannot be tested. Restore it first.');
  return AiTrainingTestRun.create(buildRun(input.organizationId, prepared, scenario, new Date()));
}

export async function runScenarioBatch(input: LabRunInput & { scenarioIds: unknown }) {
  if (!Array.isArray(input.scenarioIds) || !input.scenarioIds.length) throw new ApiError(400, 'Choose at least one scenario to test');
  if (input.scenarioIds.length > LAB_LIMITS.batchSize) throw new ApiError(400, `Test at most ${LAB_LIMITS.batchSize} scenarios at a time`);
  const ids = input.scenarioIds.map((id) => (typeof id === 'string' ? id : ''));
  if (new Set(ids).size !== ids.length) throw new ApiError(400, 'Each scenario can be chosen only once');
  const prepared = await prepareRun(input);
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new ApiError(404, 'Scenario not found');
  const scenarios = await AiTrainingScenario.find({ organizationId: input.organizationId, _id: { $in: ids } });
  if (scenarios.length !== ids.length) throw new ApiError(404, 'Scenario not found');
  if (scenarios.some((scenario) => scenario.archived)) throw new ApiError(409, 'Archived scenarios cannot be tested. Restore them first.');
  const byId = new Map(scenarios.map((scenario) => [String(scenario._id), scenario]));
  const now = new Date();
  const docs = ids.map((id) => buildRun(input.organizationId, prepared, byId.get(id), now));
  return runTrainingWrite((session) => AiTrainingTestRun.insertMany(docs, { ordered: true, ...withSession(session) }));
}

export function runVisibilityFilter(organizationId: string, user: any): Record<string, unknown> {
  const filter: Record<string, unknown> = { organizationId };
  if (!isReviewer(user)) filter.policyAuthorId = String(user?._id || '');
  return filter;
}
