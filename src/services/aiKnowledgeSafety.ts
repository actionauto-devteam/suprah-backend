import type { ImportIssue } from './aiTrainingImportParser';
import {
  BARE_DOMAIN_PATTERN,
  EMPTY_BUSINESS_CONTACTS,
  guardrailIssues,
  mentionCovered,
  normalizePhoneDigits,
  privacyIssues,
  protectedQuestionIssues,
  safetyIssues,
  sentencesOf,
  type BusinessContactSets,
} from './aiTrainingImportScreening';
import { EMAIL_PATTERN, FICTIONAL_EMAIL_DOMAIN, PHONE_PATTERN, URL_PATTERN } from './aiTrainingLab.service';

export interface KnowledgeIssue {
  field: string;
  code: string;
  message: string;
}

export interface KnowledgeCheck {
  errors: KnowledgeIssue[];
  warnings: KnowledgeIssue[];
}

export interface KnowledgeCheckInput {
  kind: string;
  title: string;
  question?: string;
  answer: string;
}

export interface KnowledgeCheckContext {
  contacts?: BusinessContactSets;
  programNames?: string[];
}

export const KNOWLEDGE_PRIVACY_CODES = new Set([
  'real_phone', 'real_email', 'real_link', 'card_number', 'vin', 'record_id', 'mock_directive', 'ssn', 'date_of_birth', 'transcript',
]);

const MESSAGE_OVERRIDES: Record<string, string> = {
  guardrail_figure: 'Remove prices, payments, rates, percentages and other money figures. Knowledge Base answers cannot include them.',
  guardrail_promise: 'Remove availability or approval promises. Describe the process instead.',
  real_phone: 'Remove this phone number, or add it to the approved business contacts for these locations first.',
  real_email: 'Remove this email address, or add it to the approved business contacts for these locations first.',
  real_link: 'Remove this link, or add the website to the approved business contacts for these locations first.',
};

export function normalizeKnowledgeKey(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const DISCOUNT_CODE = 'knowledge_discount_offer';

const TERM_RULES: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: 'knowledge_deposit_terms',
    pattern: /\bdeposits?\b|\b(?:hold|holds|holding|reserve|reserves|reserving)\s+(?:the|a|an|your|any|that|this)?\s*(?:vehicle|vehicles|car|cars|truck|trucks|suv|suvs|van|vans)\b/gi,
    message: 'Remove deposit or vehicle-hold terms. Say the team will confirm them instead.',
  },
  {
    code: 'knowledge_payment_terms',
    pattern: /\b(?:no|zero|\$?0)\s+(?:money\s+)?down\b|\bdown payments?\b|\b(?:monthly|weekly|bi-?weekly|low)\s+payments?\b|\bpayments?\s+(?:as low as|starting at|start at|from)\b|\bfirst payment\b|\bdefer(?:red)?\s+payments?\b|\bpay later\b/gi,
    message: 'Remove payment terms such as down payments or monthly payments. Say the finance team will go over them.',
  },
  {
    code: 'knowledge_financing_terms',
    pattern: /\b(?:low|lower|lowest|best|great|special|competitive|reduced)\s+(?:interest\s+)?(?:rates?|APR|financing)\b|\bAPR\b|\binterest rates?\b|\b(?:guaranteed|instant|easy)\s+(?:credit|financing|approvals?)\b|\b(?:approval|credit|financing)\s+(?:is\s+)?guaranteed\b|\b(?:all|any|every)\s+credit\b|\b(?:bad|poor|no)\s+credit\b|\bcredit (?:problems|issues)\b/gi,
    message: 'Remove rate, credit or approval claims. Say the finance team will go over financing options.',
  },
  {
    code: 'knowledge_price_claims',
    pattern: /\b(?:best|lowest|cheapest|unbeatable)\s+(?:price|prices|deal|deals|value)\b|\bprice[\s-]match(?:ing)?\b|\bbeat any\b|\bbelow (?:market|invoice|msrp|sticker)\b|\bat (?:cost|invoice)\b|\bno[\s-]haggle\b|\b(?:dealer|doc|documentation|admin|administrative|processing|destination)\s+fees?\b|\bout[\s-]the[\s-]door\b|\bsticker price\b|\bfinal (?:price|pricing|cost)\b|\bMSRP\b/gi,
    message: 'Remove price claims, fees or price-match promises. Say the team will confirm pricing.',
  },
  {
    code: 'knowledge_trade_in_value',
    pattern: /\btop dollar\b|\btrade[\s-]?in\s+(?:values?|offers?|bonus(?:es)?|credits?|allowances?|prices?)\b|\b(?:value|values|appraise|appraises|pay|pays)\s+(?:more\s+)?(?:for\s+)?(?:your|the|their)\s+trade\b|\bkelley blue book\b|\bKBB\b|\bblue book\b|\bmore for your trade\b|\bguaranteed trade\b/gi,
    message: 'Remove trade-in value claims. Say the team will appraise the trade-in.',
  },
  {
    code: DISCOUNT_CODE,
    pattern: /\bdiscount(?:s|ed)?\b|\brebates?\b|\bincentives?\b|\bspecial offers?\b|\bpromo(?:tion)?(?:s|al)?\b|\bcoupons?\b|\bon sale\b|\bclearance\b|\bloyalty (?:bonus|cash)\b/gi,
    message: 'Remove discounts, rebates or incentives, or name an approved dealership program. Say the team will confirm current offers.',
  },
];

const PROGRAM_TERMS = {
  code: 'knowledge_program_terms',
  pattern: /\b(?:all|every|any)\s+(?:of\s+(?:our|the)\s+)?(?:military|veterans?|active[\s-]duty|service\s?members?|first\s+responders?|teachers?|educators?|nurses?|students?|graduates?|grads?|customers?|members?|buyers?)\b[^.;!?]{0,60}\b(?:qualif\w*|eligible|get|gets|receive\w*|save\w*)\b|\bguarantee\w*\b|\bautomatic(?:ally)?\s+(?:qualif\w*|eligib\w*|approv\w*|appl\w*)\b|\beveryone\s+(?:qualifies|gets|is eligible)\b|\byou(?:'ll| will)\s+(?:get|receive|save|qualify|be eligible)\b|\b(?:qualif\w*|eligible)\s+(?:for sure|no matter what)\b|\bstack\w*\b|\bcombin\w*\b[^.;!?]{0,60}\bwith\s+(?:other|any|all|every|additional)\b|\b(?:on top of|in addition to)\s+(?:other|any|all|every)\s+(?:offers?|discounts?|rebates?|incentives?|promotions?|programs?)\b|\b(?:use|used|using)\b[^.;!?]{0,60}\bwith\s+(?:other|any|all|every)\s+(?:offers?|discounts?|rebates?|incentives?|promotions?|programs?)\b|\btogether\s+with\s+(?:other|any|all|every|additional)\b/gi,
  message: 'Describe the program without promising eligibility, amounts or how it combines with other offers. Say the team will confirm eligibility.',
};

export function programMentioned(text: string, programNames: string[]): boolean {
  if (!programNames.length) return false;
  const normalized = ` ${normalizeKnowledgeKey(text)} `;
  return programNames.some((name) => name && normalized.includes(` ${name} `));
}

function firstUncovered(sentence: string, pattern: RegExp): boolean {
  for (const match of sentence.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (!mentionCovered(sentence, index, index + match[0].length)) return true;
  }
  return false;
}

export function knowledgeTermIssues(field: string, text: string, programNames: string[] = []): KnowledgeIssue[] {
  const found = new Map<string, KnowledgeIssue>();
  if (!text) return [];
  for (const sentence of sentencesOf(text)) {
    const namesProgram = programMentioned(sentence, programNames);
    for (const rule of TERM_RULES) {
      if (found.has(rule.code)) continue;
      if (rule.code === DISCOUNT_CODE && namesProgram) continue;
      if (firstUncovered(sentence, rule.pattern)) found.set(rule.code, { field, code: rule.code, message: rule.message });
    }
    const discountWords = new RegExp(TERM_RULES.find((rule) => rule.code === DISCOUNT_CODE)!.pattern.source, 'i').test(sentence);
    if (!found.has(PROGRAM_TERMS.code) && (namesProgram || discountWords) && firstUncovered(sentence, PROGRAM_TERMS.pattern)) {
      found.set(PROGRAM_TERMS.code, { field, code: PROGRAM_TERMS.code, message: PROGRAM_TERMS.message });
    }
  }
  return Array.from(found.values());
}

const toIssue = (issue: ImportIssue): KnowledgeIssue => ({
  field: issue.field,
  code: issue.code,
  message: MESSAGE_OVERRIDES[issue.code] || issue.message,
});

function unlistedEmailIssues(field: string, text: string, contacts: BusinessContactSets): ImportIssue[] {
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    if (FICTIONAL_EMAIL_DOMAIN.test(match[1])) continue;
    if (!contacts.emails.has(match[0].toLowerCase())) {
      return [{ field, code: 'real_email', severity: 'error', message: MESSAGE_OVERRIDES.real_email }];
    }
  }
  return [];
}

export function knowledgeContentCheck(input: KnowledgeCheckInput, context: KnowledgeCheckContext = {}): KnowledgeCheck {
  const contacts = context.contacts || EMPTY_BUSINESS_CONTACTS;
  const raw: ImportIssue[] = [];
  const privacy = (field: string, text?: string) =>
    text ? [...privacyIssues(field, text, { contacts, addressSensitive: false, checkNames: false }), ...unlistedEmailIssues(field, text, contacts)] : [];

  raw.push(...privacy('title', input.title), ...guardrailIssues('title', input.title, 'question'));
  if (input.question) {
    raw.push(...privacy('question', input.question), ...guardrailIssues('question', input.question, 'question'));
    raw.push(...protectedQuestionIssues('question', input.question));
  }
  raw.push(...privacy('answer', input.answer), ...guardrailIssues('answer', input.answer, 'knowledge'), ...safetyIssues('answer', input.answer));

  const errors: KnowledgeIssue[] = [];
  const warnings: KnowledgeIssue[] = [];
  const seen = new Set<string>();
  const push = (list: KnowledgeIssue[], issue: KnowledgeIssue) => {
    const key = `${issue.field}:${issue.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(issue);
  };
  for (const issue of raw) {
    if (issue.severity === 'error') push(errors, toIssue(issue));
    else if (issue.severity === 'warning') push(warnings, toIssue(issue));
  }
  for (const issue of knowledgeTermIssues('answer', input.answer, context.programNames || [])) push(errors, issue);
  return { errors, warnings };
}

export const privacyErrors = (check: KnowledgeCheck): KnowledgeIssue[] => check.errors.filter((issue) => KNOWLEDGE_PRIVACY_CODES.has(issue.code));

export interface KnowledgeContactValues {
  phones: Set<string>;
  emails: Set<string>;
  domains: Set<string>;
}

const cleanHost = (host: string) => host.toLowerCase().replace(/^www\./, '').replace(/[.,;:!?)]+$/, '');

export function knowledgeContactValues(text: string): KnowledgeContactValues {
  const values: KnowledgeContactValues = { phones: new Set(), emails: new Set(), domains: new Set() };
  const source = String(text || '');
  for (const match of source.matchAll(PHONE_PATTERN)) {
    const digits = normalizePhoneDigits(match[0]);
    if (digits.length === 10) values.phones.add(digits);
  }
  for (const match of source.matchAll(EMAIL_PATTERN)) values.emails.add(match[0].toLowerCase());
  for (const match of source.matchAll(URL_PATTERN)) {
    const host = String(match[1] || match[2] || '');
    if (host) values.domains.add(cleanHost(host));
  }
  for (const match of source.matchAll(BARE_DOMAIN_PATTERN)) values.domains.add(cleanHost(match[2]));
  return values;
}
