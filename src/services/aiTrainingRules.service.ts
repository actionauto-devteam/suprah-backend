import AiTrainingPolicy, {
  BEHAVIORAL_TRAINING_CATEGORIES,
  IAiTrainingPolicy,
  TRAINING_POLICY_CHANNELS,
  TrainingPolicyStatus,
} from '../models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion, {
  TRAINING_RULE_HANDLING,
  TrainingPolicySpec,
  TrainingRuleHandling,
} from '../models/AiTrainingPolicyVersion.model';
import { ApiError } from '../utils/ApiError';
import { validateOutboundEmailMessage, validateOutboundMessage } from '../utils/aiOutboundSafety';
import { strictInstructionIssues, strictRuleIssues } from './aiTrainingSafetyGate';
import {
  appendPolicyVersion,
  auditEntry,
  canReviewTraining,
  createPolicyWithFirstVersion,
  flushPolicyAudit,
  loadVisibleProposal,
  requirePolicyIntegrity,
  runTrainingWrite,
  trainingActor,
  TrainingRole,
} from './aiTraining.service';

export const STRUCTURED_RULE_LIMITS = {
  titleMin: 3,
  title: 120,
  intent: 120,
  triggers: 8,
  trigger: 120,
  instructionMin: 10,
  instruction: 800,
  questions: 5,
  question: 200,
  include: 8,
  avoid: 8,
  listItem: 200,
  escalationWhen: 300,
  handoffReason: 200,
  examples: 3,
  exampleMessage: 500,
  exampleReply: 600,
  changeNote: 300,
  maxVersions: 50,
} as const;

type Channel = (typeof TRAINING_POLICY_CHANNELS)[number];
type Category = (typeof BEHAVIORAL_TRAINING_CATEGORIES)[number];

export interface StructuredRule {
  title: string;
  category: Category;
  channels: Channel[];
  intent: string;
  triggers: string[];
  handling: TrainingRuleHandling | '';
  instruction: string;
  requiredQuestions: string[];
  mustInclude: string[];
  mustAvoid: string[];
  escalation: { when: string; handoffReason: string };
  examples: Array<{ customerMessage: string; idealReply: string }>;
}

export interface RuleIssue {
  field: string;
  code: string;
  message: string;
}

export interface RulePreview {
  headline: string;
  handlingLabel: string;
  channels: string[];
  safetyNotice: string;
  activationNotice: string;
  sections: Array<{ label: string; items: string[] }>;
  examples: Array<{ customerMessage: string; idealReply: string; checks: Array<{ channel: Channel; ok: boolean; reasons: string[] }> }>;
}

export interface RuleEvaluation {
  errors: RuleIssue[];
  warnings: RuleIssue[];
  readyToSubmit: boolean;
  preview: RulePreview;
}

export const HANDLING_LABELS: Record<TrainingRuleHandling, string> = {
  ai_handles: 'Alex answers (only after safety checks pass)',
  ask_clarifying: 'Alex asks clarifying questions first',
  escalate: 'Alex hands off to a person',
};

const HANDLING_PREVIEW: Record<TrainingRuleHandling, string> = {
  ai_handles: 'answers on its own, but only after the mandatory safety checks pass',
  ask_clarifying: 'asks the follow-up questions below before answering',
  escalate: 'hands the conversation to a person and does not answer it',
};

const CHANNEL_LABELS: Record<Channel, string> = { sms: 'SMS', webchat: 'Website chat', email: 'Email' };

export const SAFETY_NOTICE = 'Mandatory checks always run first. Requests for a person, questions about talking to AI, opt-outs, compliance limits and technical screening failures pause Alex no matter what this rule says.';
export const ACTIVATION_NOTICE = 'Proposal only. Alex does not use training rules yet; approved rules are published in a later release.';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const PROTECTED_TOPIC_PATTERNS: Array<{ code: string; label: string; pattern: RegExp }> = [
  { code: 'human_request', label: 'asking for a person', pattern: /\b(real|actual|live)\s+(person|human)\b/i },
  { code: 'human_request', label: 'asking for a person', pattern: /\b(talk|talking|speak|speaking|chat|chatting)\s+(to|with)\s+(a\s+|an\s+)?(person|human|someone|somebody|manager|salesperson|representative|agent)\b/i },
  { code: 'human_request', label: 'asking for a person', pattern: /\b(ask(s|ing|ed)?|want(s|ing|ed)?|request(s|ing|ed)?|need(s|ing|ed)?)\b[^.\n]{0,25}\b(a\s+)?(person|human|manager|salesperson|representative|somebody|agent)\b/i },
  { code: 'ai_identity', label: 'asking whether they are talking to AI', pattern: /\b(are you|is this|am i (talking|chatting|texting|speaking) (to|with)|you're|youre)\b[^.\n]{0,20}\b(an?\s+)?(ai|bot|robot|chatbot|automated|machine|real person|human)\b/i },
  { code: 'ai_identity', label: 'asking whether they are talking to AI', pattern: /\b(bot|chatbot|robot)\b/i },
  { code: 'opt_out', label: 'opting out', pattern: /\b(unsubscrib\w*|opt(s|ing|ed)?[\s-]?out|remove me|stop (texting|messaging|emailing|contacting)|(don'?t|do not) (text|email|contact|message) me)\b/i },
  { code: 'opt_out', label: 'opting out', pattern: /\bSTOP\b/ },
];

const BYPASS_PATTERNS: Array<{ message: string; pattern: RegExp; negatable?: boolean; unlessEscalating?: boolean }> = [
  {
    message: 'Training rules cannot switch off or work around safety checks, opt-outs, escalation or compliance limits.',
    pattern: /\b(ignore|bypass|skip|override|disable|turn off|get around|work around)\b[^.\n]{0,40}\b(safety|screen(ing)?|checks?|opt[\s-]?outs?|unsubscrib\w*|escalat\w*|hand[\s-]?offs?|compliance|validators?|filters?|rules?)\b/i,
  },
  {
    message: 'Alex may not claim to be a human or deny being AI.',
    pattern: /\b(say|tell|claim|pretend|insist|reply|answer|respond)\b[^.\n]{0,30}\b(you are|you're|youre|to be|that you are|i am|i'm|alex is)\b[^.\n]{0,15}\b(a\s+)?(human|real person|not (a |an )?(bot|ai|robot))\b/i,
    negatable: true,
  },
  {
    message: 'A rule cannot keep messaging a customer who opted out.',
    pattern: /\b(keep|continue)\s+(texting|messaging|emailing|replying|contacting|following up)\b[^.\n]{0,60}\b(stop|unsubscrib\w*|opt)/i,
  },
  {
    message: 'A rule cannot tell Alex to keep answering when a customer asks for a person, asks about AI, or opts out.',
    pattern: /\b(even if|even when|regardless of whether|no matter (if|whether|what))\b[^.\n]{0,60}\b(stop|unsubscrib\w*|opt|person|human|manager|salesperson|bot|robot|ai)\b/i,
    unlessEscalating: true,
  },
];

const NEGATION = /\b(never|don'?t|do not|must not|should not|shouldn'?t|cannot|can'?t)\b/i;
const ESCALATING = /\b(escalat\w*|hand(s|ing)?[\s-]?(it\s+)?off|transfer\w*|pause\w*|staff|a person will|a human will)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

function cleanText(raw: unknown, field: string, label: string, max: number, problems: RuleIssue[]): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    problems.push({ field, code: 'invalid_type', message: `${label} must be text.` });
    return '';
  }
  const value = raw.replace(CONTROL_CHARS, '').replace(/\r\n/g, '\n').trim();
  if (value.length > max) problems.push({ field, code: 'too_long', message: `${label} can be at most ${max} characters.` });
  return value.slice(0, max);
}

function cleanList(raw: unknown, field: string, label: string, maxItems: number, maxLength: number, problems: RuleIssue[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({ field, code: 'invalid_type', message: `${label} must be a list.` });
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      problems.push({ field: `${field}.${index}`, code: 'invalid_type', message: `Each item in ${label.toLowerCase()} must be text.` });
      return;
    }
    const value = item.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
    if (!value) return;
    if (value.length > maxLength) problems.push({ field: `${field}.${index}`, code: 'too_long', message: `Each item in ${label.toLowerCase()} can be at most ${maxLength} characters.` });
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(value.slice(0, maxLength));
  });
  if (items.length > maxItems) problems.push({ field, code: 'too_many', message: `${label} can have at most ${maxItems} items.` });
  return items.slice(0, maxItems);
}

export function parseStructuredRule(raw: unknown): { rule: StructuredRule; problems: RuleIssue[] } {
  const problems: RuleIssue[] = [];
  const input: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) problems.push({ field: 'rule', code: 'invalid_type', message: 'The training rule is missing or malformed.' });
  const L = STRUCTURED_RULE_LIMITS;

  const title = cleanText(input.title, 'title', 'Title', L.title, problems);
  if (title.length < L.titleMin) problems.push({ field: 'title', code: 'required', message: `Give the rule a title of at least ${L.titleMin} characters.` });

  let category: Category = 'scenario_response';
  if (input.category !== undefined && input.category !== null && input.category !== '') {
    if (input.category === 'knowledge') {
      problems.push({ field: 'category', code: 'knowledge_not_behavioral', message: 'Factual answers and FAQs belong in the future Knowledge area, not in behavioral training rules.' });
    } else if (!(BEHAVIORAL_TRAINING_CATEGORIES as readonly string[]).includes(String(input.category))) {
      problems.push({ field: 'category', code: 'invalid_value', message: 'Choose a valid category.' });
    } else {
      category = input.category;
    }
  }

  let channels: Channel[] = [];
  if (input.channels !== undefined && input.channels !== null) {
    if (!Array.isArray(input.channels)) {
      problems.push({ field: 'channels', code: 'invalid_type', message: 'Channels must be a list.' });
    } else {
      for (const channel of input.channels) {
        if (!(TRAINING_POLICY_CHANNELS as readonly string[]).includes(String(channel))) {
          problems.push({ field: 'channels', code: 'invalid_value', message: 'Channels can only be SMS, website chat or email.' });
        } else if (!channels.includes(channel)) {
          channels.push(channel);
        }
      }
    }
  }
  channels = TRAINING_POLICY_CHANNELS.filter((channel) => channels.includes(channel));

  let handling: TrainingRuleHandling | '' = '';
  if (input.handling !== undefined && input.handling !== null && input.handling !== '') {
    if (!(TRAINING_RULE_HANDLING as readonly string[]).includes(String(input.handling))) {
      problems.push({ field: 'handling', code: 'invalid_value', message: 'Choose how Alex should handle this.' });
    } else {
      handling = input.handling;
    }
  }

  const instruction = cleanText(input.instruction, 'instruction', 'Response guidance', L.instruction, problems);
  if (!instruction) problems.push({ field: 'instruction', code: 'required', message: 'Write the response guidance before saving.' });

  let escalationInput: any = {};
  if (input.escalation !== undefined && input.escalation !== null) {
    if (typeof input.escalation !== 'object' || Array.isArray(input.escalation)) {
      problems.push({ field: 'escalation', code: 'invalid_type', message: 'Escalation details are malformed.' });
    } else {
      escalationInput = input.escalation;
    }
  }

  const examples: StructuredRule['examples'] = [];
  if (input.examples !== undefined && input.examples !== null) {
    if (!Array.isArray(input.examples)) {
      problems.push({ field: 'examples', code: 'invalid_type', message: 'Examples must be a list.' });
    } else {
      input.examples.forEach((example: any, index: number) => {
        if (!example || typeof example !== 'object' || Array.isArray(example)) {
          problems.push({ field: `examples.${index}`, code: 'invalid_type', message: `Example ${index + 1} is malformed.` });
          return;
        }
        const customerMessage = cleanText(example.customerMessage, `examples.${index}.customerMessage`, `Example ${index + 1} customer message`, L.exampleMessage, problems);
        const idealReply = cleanText(example.idealReply, `examples.${index}.idealReply`, `Example ${index + 1} ideal response`, L.exampleReply, problems);
        if (!customerMessage && !idealReply) return;
        if (!customerMessage || !idealReply) {
          problems.push({ field: `examples.${index}`, code: 'incomplete_example', message: `Example ${index + 1} needs both a customer message and an ideal response.` });
          return;
        }
        examples.push({ customerMessage, idealReply });
      });
      if (examples.length > L.examples) problems.push({ field: 'examples', code: 'too_many', message: `Add at most ${L.examples} examples.` });
    }
  }

  const rule: StructuredRule = {
    title,
    category,
    channels,
    intent: cleanText(input.intent, 'intent', 'Customer intent', L.intent, problems),
    triggers: cleanList(input.triggers, 'triggers', 'Scenario triggers', L.triggers, L.trigger, problems),
    handling,
    instruction,
    requiredQuestions: cleanList(input.requiredQuestions, 'requiredQuestions', 'Follow-up questions', L.questions, L.question, problems),
    mustInclude: cleanList(input.mustInclude, 'mustInclude', 'Information to include', L.include, L.listItem, problems),
    mustAvoid: cleanList(input.mustAvoid, 'mustAvoid', 'Information to avoid', L.avoid, L.listItem, problems),
    escalation: {
      when: cleanText(escalationInput.when, 'escalation.when', 'Escalation conditions', L.escalationWhen, problems),
      handoffReason: cleanText(escalationInput.handoffReason, 'escalation.handoffReason', 'Handoff reason', L.handoffReason, problems),
    },
    examples: examples.slice(0, L.examples),
  };
  return { rule, problems };
}

function bypassIssues(field: string, text: string): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const sentence of sentences(text)) {
    for (const entry of BYPASS_PATTERNS) {
      const match = sentence.match(entry.pattern);
      if (!match) continue;
      if (entry.negatable && NEGATION.test(sentence.slice(0, match.index))) continue;
      if (entry.unlessEscalating && ESCALATING.test(sentence)) continue;
      issues.push({ field, code: 'safety_bypass', message: entry.message });
    }
  }
  return issues;
}

export function findProtectedTopicInText(text: string): string | null {
  return PROTECTED_TOPIC_PATTERNS.find((entry) => entry.pattern.test(text))?.label || null;
}

export function findSafetyBypassInText(text: string): string[] {
  return bypassIssues('text', text).map((issue) => issue.message);
}

function protectedTopic(rule: StructuredRule): string | null {
  const texts = [rule.intent, ...rule.triggers, ...rule.examples.map((example) => example.customerMessage)];
  for (const text of texts) {
    const hit = PROTECTED_TOPIC_PATTERNS.find((entry) => entry.pattern.test(text));
    if (hit) return hit.label;
  }
  return null;
}

function validatorReasons(text: string, channel: Channel): string[] {
  const result = channel === 'email' ? validateOutboundEmailMessage(text) : validateOutboundMessage(text);
  return result.reasons;
}

function topicReasons(text: string): string[] {
  return validateOutboundMessage(text).reasons.filter((reason) => reason !== 'message too short or malformed');
}

export function buildRulePreview(rule: StructuredRule): RulePreview {
  const handling = rule.handling || 'ai_handles';
  const intent = rule.intent || 'sends this kind of message';
  const sections = [
    { label: 'Recognize it when the customer', items: rule.triggers },
    { label: 'How Alex should respond', items: rule.instruction ? [rule.instruction] : [] },
    { label: 'Ask these follow-up questions', items: rule.requiredQuestions },
    { label: 'Always include', items: rule.mustInclude },
    { label: 'Never include', items: rule.mustAvoid },
    { label: 'Hand off to a person when', items: rule.escalation.when ? [rule.escalation.when] : [] },
    { label: 'Reason shown to staff on handoff', items: rule.escalation.handoffReason ? [rule.escalation.handoffReason] : [] },
  ].filter((section) => section.items.length);
  return {
    headline: `When a customer ${intent.replace(/^(customer|the customer)\s+/i, '')}, Alex ${rule.handling ? HANDLING_PREVIEW[handling] : '(choose how Alex should handle it)'}.`,
    handlingLabel: rule.handling ? HANDLING_LABELS[rule.handling] : 'Not chosen yet',
    channels: rule.channels.map((channel) => CHANNEL_LABELS[channel]),
    safetyNotice: SAFETY_NOTICE,
    activationNotice: ACTIVATION_NOTICE,
    sections,
    examples: rule.examples.map((example) => ({
      ...example,
      checks: rule.channels.map((channel) => {
        const reasons = validatorReasons(example.idealReply, channel);
        return { channel, ok: reasons.length === 0, reasons };
      }),
    })),
  };
}

export function evaluateStructuredRule(rule: StructuredRule): RuleEvaluation {
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const L = STRUCTURED_RULE_LIMITS;

  if (!rule.intent) errors.push({ field: 'intent', code: 'required', message: 'Describe the customer intent this rule covers.' });
  if (!rule.triggers.length) errors.push({ field: 'triggers', code: 'required', message: 'Add at least one scenario trigger.' });
  if (!rule.handling) errors.push({ field: 'handling', code: 'required', message: 'Choose how Alex should handle this.' });
  if (rule.instruction.length < L.instructionMin) errors.push({ field: 'instruction', code: 'too_short', message: `Response guidance needs at least ${L.instructionMin} characters.` });
  if (!rule.channels.length) errors.push({ field: 'channels', code: 'required', message: 'Choose at least one channel.' });
  if (rule.handling === 'ask_clarifying' && !rule.requiredQuestions.length) {
    errors.push({ field: 'requiredQuestions', code: 'required', message: 'Add at least one follow-up question for Alex to ask.' });
  }
  if (rule.handling === 'escalate') {
    if (!rule.escalation.when) errors.push({ field: 'escalation.when', code: 'required', message: 'Describe when Alex should hand off.' });
    if (!rule.escalation.handoffReason) errors.push({ field: 'escalation.handoffReason', code: 'required', message: 'Add the handoff reason staff will see.' });
  }

  const topic = protectedTopic(rule);
  if (topic && rule.handling && rule.handling !== 'escalate') {
    errors.push({
      field: 'handling',
      code: 'protected_topic',
      message: `Customers ${topic} always go through Suprah's mandatory checks and are handed to a person. Choose "Alex hands off to a person" for this rule.`,
    });
  }

  const scanned: Array<[string, string]> = [
    ['title', rule.title],
    ['intent', rule.intent],
    ['instruction', rule.instruction],
    ...rule.triggers.map((text, index) => [`triggers.${index}`, text] as [string, string]),
    ...rule.requiredQuestions.map((text, index) => [`requiredQuestions.${index}`, text] as [string, string]),
    ...rule.mustInclude.map((text, index) => [`mustInclude.${index}`, text] as [string, string]),
    ...rule.examples.map((example, index) => [`examples.${index}.idealReply`, example.idealReply] as [string, string]),
  ];
  const seenBypass = new Set<string>();
  for (const [field, text] of scanned) {
    for (const issue of bypassIssues(field, text)) {
      const key = `${issue.field}:${issue.message}`;
      if (seenBypass.has(key)) continue;
      seenBypass.add(key);
      errors.push(issue);
    }
  }

  const guidanceTopics = topicReasons(rule.instruction);
  if (guidanceTopics.length) {
    warnings.push({ field: 'instruction', code: 'validator_topic', message: `The guidance mentions topics that existing safety checks block in replies: ${guidanceTopics.join(', ')}.` });
  }
  rule.mustInclude.forEach((item, index) => {
    const reasons = topicReasons(item);
    if (reasons.length) warnings.push({ field: `mustInclude.${index}`, code: 'validator_topic', message: `Replies that include "${item}" would be blocked by existing safety checks: ${reasons.join(', ')}.` });
  });
  rule.examples.forEach((example, index) => {
    for (const channel of rule.channels) {
      const reasons = validatorReasons(example.idealReply, channel);
      if (reasons.length) {
        warnings.push({ field: `examples.${index}.idealReply`, code: 'validator_block', message: `Example ${index + 1} response would be blocked on ${CHANNEL_LABELS[channel]}: ${reasons.join(', ')}.` });
      }
    }
  });
  if (rule.handling === 'ai_handles' && !rule.examples.length) {
    warnings.push({ field: 'examples', code: 'no_examples', message: 'Add an example so reviewers can see what a good answer looks like.' });
  }

  return { errors, warnings, readyToSubmit: errors.length === 0, preview: buildRulePreview(rule) };
}

export function specFromRule(rule: StructuredRule): TrainingPolicySpec {
  const optional = <T>(items: T[]) => (items.length ? items : undefined);
  const escalation = rule.escalation.when || rule.escalation.handoffReason
    ? { ...(rule.escalation.when ? { when: rule.escalation.when } : {}), ...(rule.escalation.handoffReason ? { handoffReason: rule.escalation.handoffReason } : {}) }
    : undefined;
  return {
    format: 'structured_v1',
    title: rule.title,
    category: rule.category,
    channels: rule.channels,
    intent: rule.intent || undefined,
    triggers: optional(rule.triggers),
    handling: rule.handling || undefined,
    instruction: rule.instruction,
    requiredQuestions: optional(rule.requiredQuestions),
    mustInclude: optional(rule.mustInclude),
    mustAvoid: optional(rule.mustAvoid),
    escalation,
    examples: optional(rule.examples),
  };
}

export function ruleFromSpec(spec: any, policy?: any): StructuredRule {
  return parseStructuredRule({
    title: spec?.title || policy?.title,
    category: spec?.category || (policy?.category === 'knowledge' ? undefined : policy?.category),
    channels: spec?.channels || policy?.channels,
    intent: spec?.intent,
    triggers: spec?.triggers,
    handling: spec?.handling,
    instruction: spec?.instruction,
    requiredQuestions: spec?.requiredQuestions,
    mustInclude: spec?.mustInclude,
    mustAvoid: spec?.mustAvoid,
    escalation: spec?.escalation,
    examples: spec?.examples,
  }).rule;
}

export function evaluateRuleForReview(rule: StructuredRule): RuleEvaluation {
  const evaluation = evaluateStructuredRule(rule);
  const seen = new Set(evaluation.errors.map((issue) => `${issue.field}:${issue.code}`));
  const errors = [...evaluation.errors, ...strictRuleIssues(rule).filter((issue) => !seen.has(`${issue.field}:${issue.code}`))];
  return { ...evaluation, errors, readyToSubmit: errors.length === 0 };
}

export function reviewBlockers(spec: any, policy?: any): RuleIssue[] {
  if (spec?.format === 'structured_v1' || policy?.ruleFormat === 'structured_v1') return evaluateRuleForReview(ruleFromSpec(spec, policy)).errors;
  return strictInstructionIssues(String(spec?.instruction || ''));
}

function requireParsed(raw: unknown): StructuredRule {
  const { rule, problems } = parseStructuredRule(raw);
  if (problems.length) throw new ApiError(400, problems[0].message, problems);
  return rule;
}

function cleanChangeNote(value: unknown, required: boolean): string | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError(400, 'The change note must be text');
  const note = String(value || '').replace(CONTROL_CHARS, '').trim();
  if (required && !note) throw new ApiError(400, 'Add a short note describing what you changed for the author');
  if (note.length > STRUCTURED_RULE_LIMITS.changeNote) throw new ApiError(400, `Change notes can be at most ${STRUCTURED_RULE_LIMITS.changeNote} characters`);
  return note || undefined;
}

function requireExpectedVersion(value: unknown, policy: IAiTrainingPolicy): void {
  if (value === undefined || value === null || value === '') throw new ApiError(400, 'expectedVersion is required');
  if (Number(value) !== policy.currentVersion) throw new ApiError(409, 'This proposal has a newer version. Refresh before saving your changes.');
}

export function previewStructuredRule(raw: unknown) {
  const { rule, problems } = parseStructuredRule(raw);
  const evaluation = evaluateRuleForReview(rule);
  const errors = [...problems, ...evaluation.errors];
  return { rule, problems, ...evaluation, errors, readyToSubmit: errors.length === 0 };
}

export async function createStructuredProposal(input: {
  organizationId: string;
  user: any;
  rule: unknown;
  submit?: unknown;
}): Promise<{ policy: IAiTrainingPolicy; evaluation: RuleEvaluation }> {
  const actor = trainingActor(input.user);
  const rule = requireParsed(input.rule);
  const evaluation = evaluateRuleForReview(rule);
  const submit = input.submit === true;
  if (submit && evaluation.errors.length) throw new ApiError(400, 'Fix the highlighted items before submitting', evaluation.errors);
  if (!rule.channels.length) rule.channels = ['sms', 'webchat'];
  const now = new Date();
  const entries = [auditEntry('proposal_drafted', actor, { version: 1, toStatus: 'draft' })];
  if (submit) entries.push(auditEntry('proposal_submitted', actor, { version: 1, fromStatus: 'draft', toStatus: 'in_review' }));
  const policy = await runTrainingWrite((session) => createPolicyWithFirstVersion({
    organizationId: input.organizationId,
    session,
    policy: {
      title: rule.title,
      category: rule.category,
      channels: rule.channels,
      status: submit ? 'in_review' : 'draft',
      source: 'manual',
      ruleFormat: 'structured_v1',
      createdBy: actor,
      lastEditedBy: actor,
      ...(submit ? { submittedVersion: 1, submittedAt: now } : {}),
      pendingAudit: entries,
    },
    version: { spec: specFromRule(rule) as unknown as Record<string, unknown>, changeNote: 'Created in Training Rules', createdBy: actor },
  }));
  await flushPolicyAudit(input.organizationId, policy._id);
  return { policy, evaluation };
}

export async function saveStructuredVersion(input: {
  organizationId: string;
  policyId: string;
  user: any;
  rule: unknown;
  expectedVersion: unknown;
  changeNote?: unknown;
}): Promise<{ policy: IAiTrainingPolicy; evaluation: RuleEvaluation }> {
  const actor = trainingActor(input.user);
  const policy = await loadVisibleProposal(input.organizationId, input.policyId, input.user);
  const isAuthor = policy.createdBy?.userId === actor.userId;
  const reviewer = canReviewTraining(actor.role as TrainingRole);
  let mode: 'author' | 'review';
  if (isAuthor && ['draft', 'changes_requested'].includes(policy.status)) mode = 'author';
  else if (reviewer && policy.status === 'in_review') mode = 'review';
  else if (isAuthor && policy.status === 'in_review') throw new ApiError(409, 'This version was submitted and cannot be changed. Withdraw it, or wait for the reviewer.');
  else if (!isAuthor && !reviewer) throw new ApiError(403, 'Only the author can edit this proposal');
  else throw new ApiError(409, `This proposal is ${policy.status.replace(/_/g, ' ')} and cannot be edited`);

  requireExpectedVersion(input.expectedVersion, policy);
  if (policy.currentVersion >= STRUCTURED_RULE_LIMITS.maxVersions) throw new ApiError(409, 'This proposal has too many versions. Start a new proposal instead.');
  const rule = requireParsed(input.rule);
  if (!rule.channels.length) rule.channels = (policy.channels as Channel[])?.length ? [...policy.channels] as Channel[] : ['sms', 'webchat'];
  const changeNote = cleanChangeNote(input.changeNote, mode === 'review');
  const evaluation = evaluateRuleForReview(rule);
  const snapshot = policy.toObject();
  const { updated } = await runTrainingWrite((session) => appendPolicyVersion({
    organizationId: input.organizationId,
    policy: snapshot,
    session,
    version: { spec: specFromRule(rule) as unknown as Record<string, unknown>, changeNote, createdBy: actor },
    set: () => ({ title: rule.title, category: rule.category, channels: rule.channels, ruleFormat: 'structured_v1', lastEditedBy: actor }),
    audit: (version) => [auditEntry(mode === 'review' ? 'review_edited' : 'draft_saved', actor, { version, note: changeNote })],
  }));
  await flushPolicyAudit(input.organizationId, policy._id);
  return { policy: updated, evaluation };
}

export async function submitStructuredProposal(input: {
  organizationId: string;
  policyId: string;
  user: any;
  expectedVersion: unknown;
}): Promise<{ policy: IAiTrainingPolicy; evaluation: RuleEvaluation }> {
  const actor = trainingActor(input.user);
  const policy = await loadVisibleProposal(input.organizationId, input.policyId, input.user);
  if (policy.createdBy?.userId !== actor.userId) throw new ApiError(403, 'Only the author can submit this proposal');
  if (!['draft', 'changes_requested'].includes(policy.status)) throw new ApiError(409, `This proposal is ${policy.status.replace(/_/g, ' ')} and cannot be submitted`);
  requireExpectedVersion(input.expectedVersion, policy);
  await requirePolicyIntegrity(input.organizationId, policy);
  const version: any = await AiTrainingPolicyVersion.findOne({ organizationId: input.organizationId, policyId: policy._id, version: policy.currentVersion }).lean();
  if (!version) throw new ApiError(409, 'The current version could not be found. Save the rule again.');
  if (version.spec?.format !== 'structured_v1') throw new ApiError(409, 'Open this proposal in the rule editor and save it before submitting.');
  const evaluation = evaluateRuleForReview(ruleFromSpec(version.spec, policy));
  if (evaluation.errors.length) throw new ApiError(400, 'Fix the highlighted items before submitting', evaluation.errors);

  const fromStatus = policy.status as TrainingPolicyStatus;
  const entry = auditEntry(fromStatus === 'draft' ? 'proposal_submitted' : 'proposal_revised', actor, {
    version: policy.currentVersion, fromStatus, toStatus: 'in_review',
  });
  const updated = await AiTrainingPolicy.findOneAndUpdate(
    { _id: policy._id, organizationId: input.organizationId, status: fromStatus, currentVersion: policy.currentVersion },
    { $set: { status: 'in_review', submittedVersion: policy.currentVersion, submittedAt: new Date() }, $push: { pendingAudit: entry } },
    { new: true },
  );
  if (!updated) throw new ApiError(409, 'This proposal was just changed by someone else. Refresh and try again.');
  await flushPolicyAudit(input.organizationId, policy._id);
  return { policy: updated, evaluation };
}
