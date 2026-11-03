import crypto from 'crypto';
import mongoose from 'mongoose';
import CrmAutomation, { CrmAutomationActorRef, CrmAutomationFilter, CrmAutomationStep, CrmAutomationTrigger } from '../models/CrmAutomation.model';
import CrmLocation from '../models/CrmLocation.model';
import User from '../models/User.model';
import CrmAutomationRun from '../models/CrmAutomationRun.model';
import { ApiError } from '../utils/ApiError';
import { resolveAiAgentIdentity } from '../utils/aiAgentIdentity';
import { LEAD_STATUS_VALUES } from '../constants/leadStatus';
import { REPORTABLE_LEAD_SOURCE_VALUES } from '../constants/leadSource';

interface CatalogEvent {
  key: string;
  label: string;
}

interface CatalogSource {
  key: string;
  label: string;
  groups: Array<{ label: string; events: CatalogEvent[] }>;
}

export const AUTOMATION_SOURCES: CatalogSource[] = [
  {
    key: 'suprah_leads',
    label: 'Suprah Leads',
    groups: [
      {
        label: 'Leads',
        events: [
          { key: 'lead_created', label: 'New lead received' },
          { key: 'website_form_lead', label: 'Website form lead received' },
          { key: 'lead_status_changed', label: 'Lead status changed' },
          { key: 'lead_assigned', label: 'Lead assigned to a team member' },
        ],
      },
      {
        label: 'AI agent',
        events: [
          { key: 'ai_handoff', label: 'AI agent handed the lead to the team' },
          { key: 'lead_went_quiet', label: 'Lead stopped replying' },
        ],
      },
    ],
  },
  {
    key: 'suprah',
    label: 'Suprah',
    groups: [
      {
        label: 'Calls',
        events: [
          { key: 'call_missed', label: 'Missed call' },
          { key: 'call_ended', label: 'Call ended' },
          { key: 'voicemail_received', label: 'Voicemail received' },
        ],
      },
      {
        label: 'Conversations',
        events: [
          { key: 'text_received', label: 'Text received from a customer' },
          { key: 'website_chat_started', label: 'Website chat started' },
          { key: 'email_lead_received', label: 'Email lead received' },
        ],
      },
      {
        label: 'Appointments',
        events: [
          { key: 'appointment_booked', label: 'Appointment booked' },
          { key: 'appointment_confirmed', label: 'Appointment confirmed by the customer' },
          { key: 'appointment_rescheduled', label: 'Appointment moved to a new time' },
          { key: 'appointment_cancelled', label: 'Appointment cancelled' },
          { key: 'appointment_no_show', label: 'Appointment marked no-show' },
          { key: 'appointment_completed', label: 'Appointment completed' },
        ],
      },
      {
        label: 'Reviews',
        events: [{ key: 'review_received', label: 'Review received' }],
      },
    ],
  },
  {
    key: 'adf',
    label: 'ADF Lead Delivery',
    groups: [{ label: 'Leads', events: [{ key: 'adf_lead_received', label: 'ADF lead received' }] }],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    groups: [
      {
        label: 'Vehicles',
        events: [
          { key: 'vehicle_added', label: 'Vehicle added to inventory' },
          { key: 'vehicle_price_dropped', label: 'Vehicle price dropped' },
        ],
      },
    ],
  },
  { key: 'on_a_date', label: 'On a Date', groups: [] },
];

type AudienceFieldType = 'boolean' | 'text' | 'choice' | 'tags';
type Choice = { value: string; label: string };
type ChoiceSource = 'locations' | 'team';

interface AudienceField {
  key: string;
  label: string;
  type: AudienceFieldType;
  help?: string;
  choices?: Choice[];
  choicesFrom?: ChoiceSource;
}

const asChoices = (values: readonly string[]): Choice[] => values.map((value) => ({ value, label: value }));

export const AUDIENCE_FIELDS: AudienceField[] = [
  { key: 'after_hours', label: 'After hours', type: 'boolean', help: 'The trigger happened outside 9 AM to 8 PM Mountain Time.' },
  { key: 'new_contact', label: 'New contact', type: 'boolean', help: 'Suprah never had a lead or conversation with this person before.' },
  {
    key: 'channel',
    label: 'Channel',
    type: 'choice',
    choices: [
      { value: 'sms', label: 'Text' },
      { value: 'phone', label: 'Call' },
      { value: 'email', label: 'Email' },
      { value: 'web', label: 'Website form' },
      { value: 'webchat', label: 'Website chat' },
      { value: 'adf', label: 'ADF lead' },
    ],
  },
  { key: 'lead_source', label: 'Lead source', type: 'choice', choices: asChoices(REPORTABLE_LEAD_SOURCE_VALUES) },
  { key: 'lead_status', label: 'Lead status', type: 'choice', choices: asChoices(LEAD_STATUS_VALUES) },
  { key: 'lead_tags', label: 'Lead tags', type: 'tags' },
  { key: 'assigned_to', label: 'Assigned to', type: 'choice', choicesFrom: 'team' },
  { key: 'location', label: 'Location', type: 'choice', choicesFrom: 'locations' },
  { key: 'customer_name', label: 'Customer name', type: 'text' },
  { key: 'customer_email', label: 'Customer email', type: 'text' },
  { key: 'customer_phone', label: 'Customer phone number', type: 'text' },
  { key: 'vehicle_make', label: 'Vehicle make', type: 'text' },
  { key: 'vehicle_model', label: 'Vehicle model', type: 'text' },
  { key: 'vehicle_condition', label: 'Vehicle condition', type: 'text' },
];

export const AUDIENCE_OPERATORS: Record<AudienceFieldType, Choice[]> = {
  boolean: [
    { value: 'is_true', label: 'is true' },
    { value: 'is_false', label: 'is false' },
    { value: 'not_present', label: 'is not present' },
  ],
  text: [
    { value: 'is', label: 'is' },
    { value: 'is_not', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'present', label: 'is present' },
    { value: 'not_present', label: 'is not present' },
  ],
  choice: [
    { value: 'is', label: 'is' },
    { value: 'is_not', label: 'is not' },
    { value: 'present', label: 'is present' },
    { value: 'not_present', label: 'is not present' },
  ],
  tags: [
    { value: 'contains', label: 'includes' },
    { value: 'not_contains', label: 'does not include' },
    { value: 'present', label: 'has any tag' },
    { value: 'not_present', label: 'has no tags' },
  ],
};

const VALUELESS_OPERATORS = new Set(['is_true', 'is_false', 'present', 'not_present']);
const MAX_FILTERS = 10;
const MAX_FILTER_VALUE = 120;

export const AUTOMATION_ACTIONS = [
  { key: 'send_review_invitation', label: 'Send a Review Invitation', group: 'Actions' },
  { key: 'send_message', label: 'Send a Message', group: 'Actions' },
  { key: 'send_appointment_confirmation', label: 'Send an Appointment Confirmation', group: 'Actions' },
  { key: 'branch', label: 'Branch', group: 'Actions' },
  { key: 'send_email', label: 'Send an Email', group: 'Actions' },
  { key: 'send_notification', label: 'Send Notification', group: 'Actions' },
  { key: 'assign_team_member', label: 'Assign to a team member', group: 'Actions' },
  { key: 'unassign_team_member', label: 'Remove the assigned team member', group: 'Actions' },
  { key: 'send_ai_follow_up', label: 'Send AI Follow-up Message', group: 'Actions' },
  { key: 'create_task', label: 'Create a Task for the Team', group: 'Actions' },
  { key: 'update_lead_status', label: 'Update Lead Status', group: 'Actions' },
  { key: 'wait', label: 'Wait', group: 'Timing' },
] as const;

export const MESSAGE_VARIABLES = [
  { key: 'first_name', label: 'Customer first name' },
  { key: 'dealership_name', label: 'Dealership name' },
  { key: 'agent_name', label: 'AI agent name' },
  { key: 'vehicle', label: 'Vehicle' },
] as const;

const EDIT_ROLES = new Set(['admin', 'super_admin']);
const VIEW_ROLES = new Set(['manager', 'admin', 'super_admin']);
const MAX_NAME = 120;
const MAX_TAGS = 20;
const MAX_TAG = 30;
const MAX_STEPS = 20;
const MAX_TOTAL_STEPS = 60;
const MAX_BRANCH_DEPTH = 3;
const MAX_BRANCH_PATHS = 5;
const MAX_MESSAGE = 1000;
const MAX_NOTIFICATION = 300;
const MAX_EMAIL_SUBJECT = 150;
const MAX_EMAIL_BODY = 5000;
const MAX_AI_INSTRUCTIONS = 500;
const MAX_TASK = 300;
const MAX_LIST = 500;
const WAIT_LIMITS: Record<string, number> = { minutes: 1440, hours: 720, days: 365 };
const TIMED_STEP_TYPES = new Set(['send_message', 'send_review_invitation', 'send_appointment_confirmation', 'send_email', 'send_ai_follow_up']);
const ASSIGNABLE_STEP_TYPES = new Set(['send_message', 'send_review_invitation', 'send_appointment_confirmation', 'send_email']);
const FUTURE_TIME_EVENTS = new Set(['appointment_booked', 'appointment_confirmed', 'appointment_rescheduled']);
export const AI_AGENT_ASSIGNEE = 'ai_agent';

export function canViewAutomations(role: unknown): boolean {
  return VIEW_ROLES.has(String(role || ''));
}

export function canEditAutomations(role: unknown): boolean {
  return EDIT_ROLES.has(String(role || ''));
}

export const ENGINE_EVENTS = new Set([
  'lead_created', 'website_form_lead', 'adf_lead_received', 'email_lead_received', 'lead_status_changed', 'lead_assigned', 'ai_handoff',
  'text_received', 'website_chat_started', 'call_missed', 'call_ended',
  'appointment_booked', 'appointment_confirmed', 'appointment_rescheduled', 'appointment_cancelled', 'appointment_no_show', 'appointment_completed',
]);
export const ENGINE_ACTIONS = new Set([
  'send_review_invitation', 'send_message', 'send_appointment_confirmation', 'send_email', 'send_notification',
  'assign_team_member', 'unassign_team_member', 'create_task', 'wait', 'branch',
]);

export function isAutomationEngineEnabled(): boolean {
  return process.env.CRM_AUTOMATIONS_ENABLED === 'true';
}

export function teamQuery(orgId: string) {
  return { organizationId: { $in: orgIdVariants(orgId) }, role: { $in: ['employee', 'admin', 'super_admin'] }, isActive: { $ne: false } };
}

function memberName(member: any): string {
  return String(member?.name || member?.email || 'Team member');
}

function orgIdVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

function bad(message: string): never {
  throw new ApiError(400, message);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanName(value: unknown): string {
  const name = text(value);
  if (!name) bad('Give the automation a name');
  if (name.length > MAX_NAME) bad(`Keep the name under ${MAX_NAME} characters`);
  return name;
}

export async function cleanAutomationLocations(orgId: string, value: any): Promise<{ mode: 'all' | 'specific'; ids: string[] }> {
  return cleanLocations(orgId, value);
}

async function cleanLocations(orgId: string, value: any): Promise<{ mode: 'all' | 'specific'; ids: string[] }> {
  const mode = value?.mode === 'specific' ? 'specific' : value?.mode === 'all' || value === undefined ? 'all' : bad('Choose how locations apply');
  if (mode === 'all') return { mode, ids: [] };
  const ids = Array.from(new Set((Array.isArray(value?.ids) ? value.ids : []).map((id: unknown) => String(id)))) as string[];
  if (!ids.length) bad('Pick at least one location');
  if (ids.some((id) => !mongoose.isValidObjectId(id))) bad('One of the locations is not valid');
  const found = await CrmLocation.countDocuments({ _id: { $in: ids }, organizationId: orgId, status: 'active' });
  if (found !== ids.length) bad('One of the locations was archived or does not exist. Pick again.');
  return { mode, ids };
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function cleanFilters(orgId: string, value: unknown): Promise<CrmAutomationFilter[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad('Audience filters are not valid');
  if (value.length > MAX_FILTERS) bad(`The audience can have up to ${MAX_FILTERS} filters`);
  const filters: CrmAutomationFilter[] = [];
  for (const raw of value) {
    const field = AUDIENCE_FIELDS.find((item) => item.key === raw?.field) || bad('Pick a field for each audience filter');
    const operator = AUDIENCE_OPERATORS[field.type].find((item) => item.value === raw?.operator)?.value || bad(`Pick an operation for "${field.label}"`);
    if (VALUELESS_OPERATORS.has(operator)) {
      filters.push({ field: field.key, operator, value: null });
      continue;
    }
    const filterValue = text(raw?.value);
    if (!filterValue) bad(`Enter a value for "${field.label}"`);
    if (filterValue.length > MAX_FILTER_VALUE) bad(`Keep the "${field.label}" value under ${MAX_FILTER_VALUE} characters`);
    if (field.choices && !field.choices.some((choice) => choice.value === filterValue)) bad(`"${filterValue}" is not a ${field.label.toLowerCase()} option`);
    if (field.choicesFrom === 'locations') {
      if (!mongoose.isValidObjectId(filterValue) || !(await CrmLocation.exists({ _id: filterValue, organizationId: orgId, status: 'active' }))) bad('The location in the audience was archived or does not exist');
    }
    if (field.choicesFrom === 'team') {
      if (!mongoose.isValidObjectId(filterValue) || !(await User.exists({ _id: filterValue, ...teamQuery(orgId) }))) bad('The team member in the audience is inactive or not on this team');
    }
    filters.push({ field: field.key, operator, value: filterValue });
  }
  return filters;
}

async function cleanTrigger(orgId: string, value: any): Promise<CrmAutomationTrigger | null> {
  if (value === null || value === undefined) return null;
  const source = AUTOMATION_SOURCES.find((item) => item.key === value.source) || bad('Choose a trigger source');
  let event: string | null = null;
  let date: string | null = null;
  let time: string | null = null;
  if (source.groups.length) {
    const events = source.groups.flatMap((group) => group.events);
    event = events.find((item) => item.key === value.event)?.key || bad('Choose a trigger');
  } else {
    date = text(value.date) || null;
    time = text(value.time) || null;
    if (date && !isDate(date)) bad('Pick a valid date');
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) bad('Pick a valid time');
  }
  const filters = await cleanFilters(orgId, value.filters);
  const { mode: repeatMode, days, per } = cleanRepeat(value.repeat);
  const sendingHours = value.sendingHours === undefined ? 'sending_hours' : ['sending_hours', 'any_time'].includes(value.sendingHours) ? value.sendingHours : bad('Choose when messages can be sent');
  const flag = (key: string, fallback: boolean) => (value[key] === undefined ? fallback : Boolean(value[key]));
  const stopOnReply = flag('stopOnReply', true);
  return {
    source: source.key,
    event,
    date,
    time,
    filters,
    repeat: { mode: repeatMode, days, per },
    sendingHours,
    stopOnReply,
    cancelFirstOnReply: stopOnReply && flag('cancelFirstOnReply', true),
    aiContinuesOnReply: flag('aiContinuesOnReply', false),
    stopOnFailure: flag('stopOnFailure', false),
  };
}

function checkVariables(body: string) {
  const allowed = new Set<string>(MESSAGE_VARIABLES.map((item) => item.key));
  for (const match of body.matchAll(/\{([^{}]*)\}/g)) {
    if (!allowed.has(match[1].trim())) bad(`"{${match[1]}}" is not a variable the message can use`);
  }
}

function cleanRepeat(value: any): { mode: 'every_time' | 'once_per_days'; days: number | null; per: string[] } {
  const mode = value?.mode ?? 'once_per_days';
  if (!['every_time', 'once_per_days'].includes(mode)) bad('Choose how often it can repeat');
  if (mode === 'every_time') return { mode, days: null, per: [] };
  const days = Number(value?.days ?? 365);
  if (!Number.isInteger(days) || days < 1 || days > 365) bad('Repeat days must be between 1 and 365');
  const rawPer = value?.per === undefined ? ['customer_phone'] : value.per;
  if (!Array.isArray(rawPer)) bad('Choose what the repeat limit is counted per');
  const per = Array.from(new Set(rawPer.map(String))) as string[];
  if (!per.length) bad('Pick at least one field the repeat limit is counted per');
  if (per.some((key) => !AUDIENCE_FIELDS.some((field) => field.key === key))) bad('One of the repeat fields is not valid');
  return { mode, days, per };
}

export function flattenSteps(steps: CrmAutomationStep[]): CrmAutomationStep[] {
  return steps.flatMap((step) => {
    if (step.type !== 'branch') return [step];
    const config: any = step.config || {};
    return [step, ...(config.paths || []).flatMap((path: any) => flattenSteps(path.steps || [])), ...flattenSteps(config.else?.steps || [])];
  });
}

interface StepContext {
  teamIds: Set<string>;
  ids: Set<string>;
  total: number;
}

async function cleanSteps(orgId: string, value: unknown): Promise<CrmAutomationStep[]> {
  if (value === undefined) return [];
  const context: StepContext = { teamIds: new Set<string>(), ids: new Set<string>(), total: 0 };
  const steps = await cleanStepList(orgId, value, 0, context);
  if (context.teamIds.size) {
    const ids = Array.from(context.teamIds);
    if (ids.some((userId) => !mongoose.isValidObjectId(userId))) bad('One of the team members is not valid');
    const found = await User.countDocuments({ _id: { $in: ids }, ...teamQuery(orgId) });
    if (found !== ids.length) bad('One of the team members is inactive or not on this team');
  }
  return steps;
}

async function cleanBranch(orgId: string, config: any, depth: number, context: StepContext, index: number) {
  if (depth >= MAX_BRANCH_DEPTH) bad(`Branches can only go ${MAX_BRANCH_DEPTH} levels deep`);
  const rawPaths = Array.isArray(config?.paths) ? config.paths : [];
  if (rawPaths.length > MAX_BRANCH_PATHS) bad(`A Branch can have up to ${MAX_BRANCH_PATHS} conditions`);
  const paths = [];
  for (const raw of rawPaths) {
    const id = /^[a-zA-Z0-9_-]{1,40}$/.test(String(raw?.id || '')) ? String(raw.id) : crypto.randomUUID();
    paths.push({ id, filters: await cleanFilters(orgId, raw?.filters), repeat: cleanRepeat(raw?.repeat), steps: await cleanStepList(orgId, raw?.steps ?? [], depth + 1, context) });
  }
  if (new Set(paths.map((path) => path.id)).size !== paths.length) bad('Two conditions have the same id');
  const doNothing = Boolean(config?.else?.doNothing);
  const elseSteps = doNothing ? [] : await cleanStepList(orgId, config?.else?.steps ?? [], depth + 1, context);
  return { timing: cleanTiming(config?.timing, index), paths, else: { doNothing, steps: elseSteps } };
}

async function cleanStepList(orgId: string, value: unknown, depth: number, context: StepContext): Promise<CrmAutomationStep[]> {
  if (!Array.isArray(value)) bad('Steps are not valid');
  if (value.length > MAX_STEPS) bad(`An automation can have up to ${MAX_STEPS} steps`);
  context.total += value.length;
  if (context.total > MAX_TOTAL_STEPS) bad(`An automation can have up to ${MAX_TOTAL_STEPS} steps in all, counting every branch`);
  const branchAt = value.findIndex((raw: any) => raw?.type === 'branch');
  if (branchAt !== -1 && branchAt !== value.length - 1) bad('A Branch must be the last step in its path');
  const teamIds = context.teamIds;
  const recipientsOf = (config: any, noun: string) => {
    const recipients = ['admins', 'assigned', 'people'].includes(config.recipients) ? config.recipients : bad(`Choose who gets the ${noun}`);
    const userIds = recipients === 'people' ? Array.from(new Set((Array.isArray(config.userIds) ? config.userIds : []).map(String))) as string[] : [];
    if (recipients === 'people' && !userIds.length) bad(`Pick at least one person for the ${noun}`);
    userIds.forEach((userId) => teamIds.add(userId));
    return { recipients, userIds };
  };
  const steps = value.map((raw: any): CrmAutomationStep => {
    const id = /^[a-zA-Z0-9_-]{1,40}$/.test(String(raw?.id || '')) ? String(raw.id) : crypto.randomUUID();
    const config = raw?.config || {};
    switch (raw?.type) {
      case 'send_message': {
        const body = text(config.body);
        if (!body) bad('Write the message to send');
        if (body.length > MAX_MESSAGE) bad(`Keep the message under ${MAX_MESSAGE} characters`);
        checkVariables(body);
        return { id, type: 'send_message', config: { body } };
      }
      case 'send_review_invitation':
        return { id, type: 'send_review_invitation', config: {} };
      case 'send_appointment_confirmation':
      case 'unassign_team_member':
        return { id, type: raw.type, config: {} };
      case 'send_email': {
        const subject = text(config.subject);
        const body = text(config.body);
        if (!subject) bad('Write the email subject');
        if (subject.length > MAX_EMAIL_SUBJECT) bad(`Keep the subject under ${MAX_EMAIL_SUBJECT} characters`);
        if (!body) bad('Write the email');
        if (body.length > MAX_EMAIL_BODY) bad(`Keep the email under ${MAX_EMAIL_BODY} characters`);
        checkVariables(subject);
        checkVariables(body);
        return { id, type: 'send_email', config: { subject, body } };
      }
      case 'send_ai_follow_up': {
        const instructions = text(config.instructions);
        if (instructions.length > MAX_AI_INSTRUCTIONS) bad(`Keep the AI instructions under ${MAX_AI_INSTRUCTIONS} characters`);
        return { id, type: 'send_ai_follow_up', config: { instructions } };
      }
      case 'create_task': {
        const { recipients, userIds } = recipientsOf(config, 'task');
        const task = text(config.task);
        if (!task) bad('Write what the team needs to do');
        if (task.length > MAX_TASK) bad(`Keep the task under ${MAX_TASK} characters`);
        checkVariables(task);
        return { id, type: 'create_task', config: { recipients, userIds, task } };
      }
      case 'branch':
        return { id, type: 'branch', config: {} };
      case 'update_lead_status': {
        const status = LEAD_STATUS_VALUES.includes(text(config.status)) ? text(config.status) : bad('Pick the new lead status');
        return { id, type: 'update_lead_status', config: { status } };
      }
      case 'send_notification': {
        const { recipients, userIds } = recipientsOf(config, 'notification');
        const message = text(config.message);
        if (!message) bad('Write the notification message');
        if (message.length > MAX_NOTIFICATION) bad(`Keep the notification under ${MAX_NOTIFICATION} characters`);
        checkVariables(message);
        return { id, type: 'send_notification', config: { recipients, userIds, message } };
      }
      case 'assign_team_member': {
        const userId = text(config.userId) || bad('Pick the team member');
        teamIds.add(userId);
        return { id, type: 'assign_team_member', config: { userId } };
      }
      case 'wait': {
        const unit = ['minutes', 'hours', 'days'].includes(config.unit) ? config.unit : bad('Choose minutes, hours, or days');
        const amount = Number(config.amount);
        if (!Number.isInteger(amount) || amount < 1 || amount > WAIT_LIMITS[unit]) bad(`Wait must be between 1 and ${WAIT_LIMITS[unit]} ${unit}`);
        return { id, type: 'wait', config: { amount, unit } };
      }
      default:
        return bad('One of the steps is not a supported action');
    }
  });
  steps.forEach((step, index) => {
    const config = (value as any[])[index]?.config || {};
    if (TIMED_STEP_TYPES.has(step.type)) step.config = { ...step.config, timing: cleanTiming(config.timing, index) };
    if (ASSIGNABLE_STEP_TYPES.has(step.type)) {
      const assignTo = cleanAssignee(config.assignTo);
      if (assignTo && assignTo !== AI_AGENT_ASSIGNEE) teamIds.add(assignTo);
      step.config = { ...step.config, assignTo };
    }
  });
  for (const step of steps) {
    if (context.ids.has(step.id)) bad('Two steps have the same id');
    context.ids.add(step.id);
  }
  for (const [index, step] of steps.entries()) {
    if (step.type === 'branch') step.config = await cleanBranch(orgId, (value as any[])[index]?.config || {}, depth, context, index);
  }
  return steps;
}

function cleanTiming(value: any, index: number) {
  const when = value?.when === undefined || value?.when === null ? 'on' : ['on', 'after', 'before'].includes(value.when) ? value.when : bad(`Step ${index + 1}: choose when it is delivered`);
  if (when === 'on') return { when, amount: null, unit: null };
  const unit = ['minutes', 'hours', 'days'].includes(value?.unit) ? value.unit : bad(`Step ${index + 1}: choose minutes, hours, or days`);
  const amount = Number(value?.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > WAIT_LIMITS[unit]) bad(`Step ${index + 1}: the timing must be between 1 and ${WAIT_LIMITS[unit]} ${unit}`);
  return { when, amount, unit };
}

function cleanAssignee(value: unknown): string | null {
  const assignee = text(value);
  if (!assignee) return null;
  if (assignee === AI_AGENT_ASSIGNEE) return assignee;
  if (!mongoose.isValidObjectId(assignee)) bad('One of the team members is not valid');
  return assignee;
}

function checkTimingFitsTrigger(trigger: CrmAutomationTrigger | null, steps: CrmAutomationStep[]) {
  const usesBefore = flattenSteps(steps).some((step) => (step.config as any)?.timing?.when === 'before');
  if (!usesBefore) return;
  const futureTime = trigger && (trigger.source === 'on_a_date' || FUTURE_TIME_EVENTS.has(String(trigger.event)));
  if (!futureTime) bad('"Deliver before trigger" only works with appointment or On a Date triggers');
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) bad('Tags are not valid');
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    const tag = text(raw).replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > MAX_TAG) bad(`Keep each tag under ${MAX_TAG} characters`);
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) bad(`An automation can have up to ${MAX_TAGS} tags`);
  return tags;
}

function serialize(doc: any) {
  return {
    id: String(doc._id),
    name: doc.name,
    locations: { mode: doc.locations?.mode || 'all', ids: doc.locations?.ids || [] },
    trigger: doc.trigger || null,
    steps: (doc.steps || []).map((step: CrmAutomationStep) => ({ id: step.id, type: step.type, config: step.config || {} })),
    status: doc.status,
    statusChangedAt: doc.statusChangedAt || null,
    tags: doc.tags || [],
    alerts: {
      enabled: Boolean(doc.alerts?.enabled),
      condition: doc.alerts?.condition || 'min_events',
      minEvents: doc.alerts?.minEvents ?? 1,
      days: doc.alerts?.days ?? 7,
      dropPercent: doc.alerts?.dropPercent ?? 50,
      userIds: doc.alerts?.userIds || [],
      lastAlertAt: doc.alerts?.lastAlertAt || null,
    },
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function loadOwned(orgId: string, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Automation not found');
  const doc = await CrmAutomation.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new ApiError(404, 'Automation not found');
  return doc;
}

export async function getAutomationOptions(orgId: string) {
  const [locations, team, agent] = await Promise.all([
    CrmLocation.find({ organizationId: orgId, status: 'active' }).select('name').sort({ name: 1 }).lean(),
    User.find(teamQuery(orgId)).select('name email role').sort({ name: 1 }).lean(),
    resolveAiAgentIdentity(orgId),
  ]);
  const resolved: Record<ChoiceSource, Choice[]> = {
    locations: locations.map((location: any) => ({ value: String(location._id), label: location.name })),
    team: team.map((member: any) => ({ value: String(member._id), label: memberName(member) })),
  };
  return {
    sources: AUTOMATION_SOURCES.map((source) => ({
      ...source,
      groups: source.groups.map((group) => ({ ...group, events: group.events.map((event) => ({ ...event, connected: ENGINE_EVENTS.has(event.key) })) })),
    })),
    engineEnabled: isAutomationEngineEnabled(),
    audienceFields: AUDIENCE_FIELDS.map(({ choicesFrom, ...field }) => (choicesFrom ? { ...field, choices: resolved[choicesFrom] } : field)),
    audienceOperators: AUDIENCE_OPERATORS,
    actions: AUTOMATION_ACTIONS.map((action) => ({ ...action, connected: ENGINE_ACTIONS.has(action.key) })),
    agentName: agent.displayName,
    variables: MESSAGE_VARIABLES,
    locations: locations.map((location: any) => ({ id: String(location._id), name: location.name })),
    team: team.map((member: any) => ({ id: String(member._id), name: memberName(member), email: String(member.email || ''), role: member.role })),
  };
}

export async function listAutomations(orgId: string) {
  const docs = await CrmAutomation.find({ organizationId: orgId }).sort({ updatedAt: -1 }).limit(MAX_LIST).lean();
  return docs.map(serialize);
}

export async function getAutomation(orgId: string, id: string) {
  return serialize((await loadOwned(orgId, id)).toObject());
}

export async function createAutomation(orgId: string, actor: CrmAutomationActorRef, input: any) {
  const name = cleanName(input?.name);
  const locations = await cleanLocations(orgId, input?.locations);
  const trigger = await cleanTrigger(orgId, input?.trigger);
  const steps = await cleanSteps(orgId, input?.steps);
  checkTimingFitsTrigger(trigger, steps);
  const doc = await CrmAutomation.create({
    organizationId: orgId,
    name,
    locations,
    trigger,
    steps,
    tags: input?.tags === undefined ? [] : cleanTags(input.tags),
    status: 'draft',
    createdBy: actor,
    updatedBy: actor,
  });
  return serialize(doc.toObject());
}

export async function updateAutomation(orgId: string, actor: CrmAutomationActorRef, id: string, input: any) {
  const doc = await loadOwned(orgId, id);
  if (input?.name !== undefined) doc.name = cleanName(input.name);
  if (input?.locations !== undefined) doc.locations = await cleanLocations(orgId, input.locations);
  if (input?.trigger !== undefined) doc.trigger = await cleanTrigger(orgId, input.trigger);
  if (input?.steps !== undefined) doc.steps = await cleanSteps(orgId, input.steps);
  if (input?.tags !== undefined) doc.tags = cleanTags(input.tags);
  if (input?.trigger !== undefined || input?.steps !== undefined) checkTimingFitsTrigger(doc.trigger, doc.steps);
  if (doc.status === 'active' || doc.status === 'test') {
    const problems = readinessProblems(doc);
    if (problems.length) bad(`This automation is on, so it must stay ready to run. ${problems.join('. ')}`);
  }
  doc.updatedBy = actor;
  await doc.save();
  return serialize(doc.toObject());
}

function boundedInt(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) bad(`${label} must be between ${min} and ${max}`);
  return number;
}

export async function updateAutomationAlerts(orgId: string, actor: CrmAutomationActorRef, id: string, input: any) {
  const doc = await loadOwned(orgId, id);
  const enabled = Boolean(input?.enabled);
  const condition = input?.condition === 'percentage_drop' ? 'percentage_drop' : input?.condition === undefined || input?.condition === 'min_events' ? 'min_events' : bad('Choose a threshold condition');
  const minEvents = boundedInt(input?.minEvents ?? 1, 1, 1000, 'Events');
  const days = boundedInt(input?.days ?? 7, 1, 90, 'Days');
  const dropPercent = boundedInt(input?.dropPercent ?? 50, 1, 100, 'The drop');
  const userIds = Array.from(new Set((Array.isArray(input?.userIds) ? input.userIds : []).map(String))) as string[];
  if (enabled && !userIds.length) bad('Pick at least one person to get the alert');
  if (userIds.some((userId) => !mongoose.isValidObjectId(userId))) bad('One of the people is not valid');
  if (userIds.length && (await User.countDocuments({ _id: { $in: userIds }, ...teamQuery(orgId) })) !== userIds.length) bad('One of the people is inactive or not on this team');
  doc.alerts = { enabled, condition, minEvents, days, dropPercent, userIds, lastCheckedAt: doc.alerts?.lastCheckedAt || null, lastAlertAt: doc.alerts?.lastAlertAt || null } as any;
  doc.updatedBy = actor;
  await doc.save();
  return serialize(doc.toObject());
}

export async function duplicateAutomation(orgId: string, actor: CrmAutomationActorRef, id: string) {
  const source = (await loadOwned(orgId, id)).toObject() as any;
  const name = `Copy of ${source.name}`.slice(0, MAX_NAME);
  const doc = await CrmAutomation.create({
    organizationId: orgId,
    name,
    locations: source.locations,
    trigger: source.trigger,
    steps: (source.steps || []).map((step: CrmAutomationStep) => ({ ...step, id: crypto.randomUUID() })),
    tags: source.tags || [],
    status: 'draft',
    createdBy: actor,
    updatedBy: actor,
  });
  return serialize(doc.toObject());
}

export async function deleteAutomation(orgId: string, id: string) {
  const doc = await loadOwned(orgId, id);
  await CrmAutomationRun.updateMany(
    { automationId: doc._id, status: { $in: ['waiting', 'running'] } },
    { $set: { status: 'stopped', reason: 'The automation was deleted', nextRunAt: null } },
  );
  await doc.deleteOne();
}

const ACTIVITY_PAGE = 25;
const RUN_STATUSES = ['filtered', 'waiting', 'running', 'completed', 'stopped', 'failed'];

export async function listAutomationActivity(orgId: string, query: { automationId?: string; status?: string; mode?: string; page?: number }) {
  const mode = query.mode === 'test' ? 'test' : 'live';
  const base: Record<string, unknown> = { organizationId: orgId, mode };
  if (query.automationId) {
    if (!mongoose.isValidObjectId(query.automationId)) bad('That automation is not valid');
    base.automationId = new mongoose.Types.ObjectId(query.automationId);
  }
  if (query.status && !RUN_STATUSES.includes(query.status)) bad('That status is not valid');
  const filter = query.status ? { ...base, status: query.status } : base;
  const page = Math.max(1, Math.min(1000, Number(query.page) || 1));
  const [items, total, grouped] = await Promise.all([
    CrmAutomationRun.find(filter).sort({ createdAt: -1 }).skip((page - 1) * ACTIVITY_PAGE).limit(ACTIVITY_PAGE).lean(),
    CrmAutomationRun.countDocuments(filter),
    CrmAutomationRun.aggregate([{ $match: base }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const counts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<string, number>;
  for (const row of grouped) counts[row._id] = row.count;
  return {
    mode,
    engineEnabled: isAutomationEngineEnabled(),
    counts,
    page,
    pages: Math.max(1, Math.ceil(total / ACTIVITY_PAGE)),
    total,
    items: items.map((run: any) => ({
      id: String(run._id),
      automationId: String(run.automationId),
      automationName: run.automationName,
      mode: run.mode,
      event: run.event,
      status: run.status,
      reason: run.reason,
      contact: run.contact,
      triggerAt: run.triggerAt,
      nextRunAt: run.nextRunAt,
      createdAt: run.createdAt,
      log: (run.log || []).map((entry: any) => ({ type: entry.type, status: entry.status, detail: entry.detail, at: entry.at })),
    })),
  };
}

export function readinessProblems(doc: { trigger: CrmAutomationTrigger | null; steps: CrmAutomationStep[] }): string[] {
  const problems: string[] = [];
  if (!doc.trigger) problems.push('Choose a trigger');
  else if (doc.trigger.source === 'on_a_date' || !ENGINE_EVENTS.has(String(doc.trigger.event))) problems.push('This trigger is not live yet, so the automation cannot run');
  const all = flattenSteps(doc.steps || []);
  if (!all.some((step) => step.type !== 'wait' && step.type !== 'branch')) problems.push('Add at least one action after the trigger');
  if (all.some((step) => step.type === 'branch' && !((step.config as any)?.paths || []).length)) problems.push('Each Branch needs at least one If condition');
  const notLive = Array.from(new Set(all.filter((step) => !ENGINE_ACTIONS.has(step.type)).map((step) => AUTOMATION_ACTIONS.find((action) => action.key === step.type)?.label || step.type)));
  if (notLive.length) problems.push(`These steps are not live yet: ${notLive.join(', ')}`);
  return problems;
}

export async function setAutomationStatus(orgId: string, actor: CrmAutomationActorRef, id: string, status: unknown) {
  if (!['active', 'test', 'inactive'].includes(String(status))) bad('Choose Activate, Test Mode, or Deactivate');
  const doc = await loadOwned(orgId, id);
  if (status !== 'inactive') {
    const problems = readinessProblems(doc);
    if (problems.length) bad(problems.join('. '));
  }
  const previous = doc.status;
  if (previous !== status) doc.statusChangedAt = new Date();
  doc.status = status as any;
  doc.updatedBy = actor;
  await doc.save();
  if (previous !== doc.status && (doc.status === 'inactive' || previous === 'test' || doc.status === 'test')) {
    await CrmAutomationRun.updateMany(
      { automationId: doc._id, status: { $in: ['waiting', 'running'] }, mode: previous === 'test' ? 'test' : 'live' },
      { $set: { status: 'stopped', reason: doc.status === 'inactive' ? 'The automation was turned off' : 'The automation mode changed', nextRunAt: null } },
    );
  }
  return serialize(doc.toObject());
}
