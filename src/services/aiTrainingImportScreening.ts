import { isDemoPhone } from '../utils/demoPhone';
import { hasGuaranteedAvailabilityLanguage, validateOutboundMessage } from '../utils/aiOutboundSafety';
import { findProtectedTopicInText, findSafetyBypassInText } from './aiTrainingRules.service';
import {
  EMAIL_PATTERN,
  FICTIONAL_EMAIL_DOMAIN,
  MOCK_DIRECTIVE_PATTERN,
  PHONE_PATTERN,
  RECORD_ID_PATTERN,
  STREET_PATTERN,
  URL_PATTERN,
  VIN_PATTERN,
} from './aiTrainingLab.service';
import type { ImportIssue } from './aiTrainingImportParser';

export interface BusinessContactSets {
  phones: Set<string>;
  emails: Set<string>;
  domains: Set<string>;
}

export const EMPTY_BUSINESS_CONTACTS: BusinessContactSets = { phones: new Set(), emails: new Set(), domains: new Set() };

export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
]);

export const BARE_DOMAIN_PATTERN = /(^|[^@\w.-])((?:[a-z0-9-]+\.)+(?:com|net|org|io|us|co|biz|info|app|auto|cars))\b/gi;
const CARD_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b|\b(?:ssn|social security(?: number)?)\b[^\d\n]{0,15}\d{3}[- ]?\d{2}[- ]?\d{4}/i;
const DOB_PATTERN = /\b(?:dob|d\.o\.b\.?|date of birth|birth ?date|born on|birthday)\b[^\n]{0,20}?(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2})/i;
const TIMESTAMP_LINE = /^\s*\[?\(?\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\]?\)?\s*[-:]?\s+\S/i;
const SPEAKER_LINE = /^\s*(customer|client|lead|agent|rep|staff|me|alex|anna|bot|ai|dealer|salesperson|sales|advisor|visitor|you)\s*:\s+\S/i;

const NAME_ALLOWLIST = new Set([
  'alex', 'anna', 'podium', 'suprah', 'action', 'auto', 'autos', 'team', 'sales', 'service', 'finance', 'manager', 'there', 'all',
  'everyone', 'folks', 'friend', 'sir', 'maam', 'ma', 'hi', 'hello', 'hey', 'thanks', 'thank', 'the', 'a', 'an', 'our', 'your', 'my',
  'we', 'you', 'i', 'yes', 'no', 'sure', 'ok', 'okay', 'great', 'happy', 'sorry', 'just', 'looking', 'interested', 'here', 'back',
  'ready', 'calling', 'reaching', 'texting', 'writing', 'following', 'checking', 'wondering', 'glad', 'excited', 'good', 'morning',
  'afternoon', 'evening', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'mr', 'mrs', 'ms', 'dr', 'toyota', 'honda',
  'ford', 'chevy', 'chevrolet', 'nissan', 'hyundai', 'kia', 'jeep', 'ram', 'dodge', 'gmc', 'subaru', 'mazda', 'tesla', 'bmw', 'audi',
  'lexus', 'acura', 'volkswagen', 'vw', 'buick', 'cadillac', 'lincoln', 'chrysler', 'mercedes', 'benz', 'volvo', 'porsche', 'mitsubishi',
  'infiniti', 'genesis', 'camry', 'corolla', 'civic', 'accord', 'silverado', 'sierra', 'tacoma', 'tundra', 'highlander', 'wrangler',
  'cherokee', 'explorer', 'escape', 'mustang', 'bronco', 'altima', 'rogue', 'sentra', 'tucson', 'elantra', 'sonata', 'santa', 'fe',
  'sorento', 'outback', 'forester', 'crosstrek', 'model', 'prius', 'odyssey', 'pilot', 'utah', 'salt', 'lake', 'city', 'orem', 'lehi',
  'provo', 'sandy', 'ogden', 'american', 'fork', 'spanish', 'west', 'north', 'south', 'east', 'valley', 'highway', 'street', 'avenue',
  'road', 'dealership', 'dealer', 'store', 'lot', 'customer', 'sedan', 'suv', 'truck', 'van', 'coupe', 'hybrid', 'electric', 'new',
  'used', 'certified', 'pre', 'owned', 'can', 'could', 'would', 'will', 'is', 'are', 'do', 'does', 'what', 'when', 'where', 'which',
  'who', 'how', 'why', 'please', 'let', 'me', 'it', 'this', 'that', 'thats', 'its', 'im', 'ive', 'id', 'dont', 'not', 'test', 'drive',
]);

export function normalizePhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function domainAllowed(host: string, contacts: BusinessContactSets): boolean {
  const clean = host.toLowerCase().replace(/^www\./, '').replace(/[.,;:!?)]+$/, '');
  if (FICTIONAL_EMAIL_DOMAIN.test(clean)) return true;
  for (const domain of contacts.domains) {
    if (clean === domain || clean.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function isCardNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

function transcriptLike(text: string): boolean {
  const lines = text.split('\n');
  if (lines.filter((line) => TIMESTAMP_LINE.test(line)).length >= 2) return true;
  const speakers = lines.map((line) => line.match(SPEAKER_LINE)?.[1]?.toLowerCase()).filter(Boolean) as string[];
  return speakers.length >= 2 && new Set(speakers).size >= 2;
}

function nameCandidates(text: string, allow: Set<string>): string[] {
  const found = new Set<string>();
  const isName = (word?: string) => Boolean(word) && /^[A-Z][a-z'’]{1,20}$/.test(word!) && !NAME_ALLOWLIST.has(word!.toLowerCase().replace(/['’]/g, '')) && !allow.has(word!.toLowerCase());
  for (const match of text.matchAll(/\b(?:[Mm]y name is|[Mm]y name's|[Tt]his is|I am|I'm|I’m|[Cc]all me|[Ii]t's)\s+([A-Z][a-z'’]{1,20})(?:\s+([A-Z][a-z'’]{1,20}))?/g)) {
    if (isName(match[1])) found.add(match[1]);
    if (isName(match[2])) found.add(match[2]);
  }
  for (const match of text.matchAll(/(?:^|[.!?\n]\s*)(?:[Hh]i|[Hh]ey|[Hh]ello|[Dd]ear|[Tt]hanks|[Tt]hank you|[Gg]ood (?:morning|afternoon|evening))[\s,]+([A-Z][a-z'’]{1,20})\b/g)) {
    if (isName(match[1])) found.add(match[1]);
  }
  const words = Array.from(text.matchAll(/\b[A-Z][a-z'’]{1,20}\b/g));
  for (let i = 1; i < words.length; i += 1) {
    const previous = words[i - 1];
    const current = words[i];
    const gap = text.slice((previous.index ?? 0) + previous[0].length, current.index ?? 0);
    if (gap === ' ' && isName(previous[0]) && isName(current[0])) found.add(`${previous[0]} ${current[0]}`);
  }
  const signature = text.match(/(?:^|\n)\s*(?:[-–—]\s*|(?:[Tt]hanks|[Tt]hank you|[Rr]egards|[Bb]est|[Ss]incerely|[Cc]heers)[,!]?\s+)([A-Z][a-z'’]{1,20})\s*$/);
  if (signature && isName(signature[1])) found.add(signature[1]);
  return Array.from(found);
}

export interface PrivacyOptions {
  contacts: BusinessContactSets;
  addressSensitive: boolean;
  checkNames: boolean;
  nameAllowlist?: Set<string>;
}

export function privacyIssues(field: string, text: string, options: PrivacyOptions): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (!text) return issues;
  const add = (code: string, message: string, severity: ImportIssue['severity'] = 'error') => {
    if (!issues.some((issue) => issue.code === code)) issues.push({ field, code, severity, message });
  };
  for (const match of text.matchAll(PHONE_PATTERN)) {
    if (!isDemoPhone(match[0]) && !options.contacts.phones.has(normalizePhoneDigits(match[0]))) {
      add('real_phone', 'Remove phone numbers. Only fictional 555-01xx numbers or the dealership numbers listed as business contacts are allowed.');
      break;
    }
  }
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const address = match[0].toLowerCase();
    if (!FICTIONAL_EMAIL_DOMAIN.test(match[1]) && !options.contacts.emails.has(address) && !domainAllowed(match[1], options.contacts)) {
      add('real_email', "Remove email addresses. Only example.com addresses or the dealership's listed business emails are allowed.");
      break;
    }
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    if (!domainAllowed(String(match[1] || match[2] || ''), options.contacts)) {
      add('real_link', "Remove links. Only example.com or the dealership's listed website domains are allowed.");
      break;
    }
  }
  for (const match of text.matchAll(BARE_DOMAIN_PATTERN)) {
    if (!domainAllowed(match[2], options.contacts)) {
      add('real_link', "Remove links. Only example.com or the dealership's listed website domains are allowed.");
      break;
    }
  }
  for (const match of text.matchAll(CARD_PATTERN)) {
    if (isCardNumber(match[0])) {
      add('card_number', 'Remove the card number.');
      break;
    }
  }
  if (VIN_PATTERN.test(text)) add('vin', 'Remove the VIN.');
  if (RECORD_ID_PATTERN.test(text)) add('record_id', 'Remove CRM record IDs.');
  if (MOCK_DIRECTIVE_PATTERN.test(text)) add('mock_directive', 'Local QA directives are not allowed.');
  if (SSN_PATTERN.test(text)) add('ssn', 'Remove the Social Security number.');
  if (DOB_PATTERN.test(text)) add('date_of_birth', 'Remove the date of birth.');
  if (transcriptLike(text)) add('transcript', 'This looks like a pasted customer conversation. Rewrite it as a rule or a short made-up example.');
  if (STREET_PATTERN.test(text)) {
    add('street_address', options.addressSensitive
      ? 'This looks like a street address. Replace it with a made-up address.'
      : "This looks like a street address. Keep it only if it is the dealership's own address.", options.addressSensitive ? 'error' : 'warning');
  }
  if (options.checkNames) {
    const names = nameCandidates(text, options.nameAllowlist || new Set());
    if (names.length) {
      add('possible_personal_name', 'This example may include a real person\'s name. Replace it with a made-up name, or mark the row as reviewed.');
    }
  }
  return issues;
}

export function maskText(text: string): string {
  const global = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let masked = text;
  masked = masked.replace(global(EMAIL_PATTERN), '[email]');
  masked = masked.replace(global(URL_PATTERN), '[link]');
  masked = masked.replace(BARE_DOMAIN_PATTERN, (_all, lead) => `${lead}[link]`);
  masked = masked.replace(CARD_PATTERN, (value) => (isCardNumber(value) ? '[card]' : value));
  masked = masked.replace(global(VIN_PATTERN), '[vin]');
  masked = masked.replace(global(RECORD_ID_PATTERN), '[id]');
  masked = masked.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]');
  masked = masked.replace(global(PHONE_PATTERN), '[phone]');
  masked = masked.replace(global(STREET_PATTERN), '[address]');
  masked = masked.replace(/\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/g, '[date]');
  for (const name of nameCandidates(masked, new Set())) masked = masked.split(name).join('[name]');
  return masked;
}

export type GuardrailClass = 'question' | 'instruction' | 'reply' | 'knowledge' | 'reference' | 'exempt';

const GUARDED_REASONS = new Set([
  'currency amount',
  'price mention',
  'percent-off',
  'discount/incentive language',
  'financing/payment language',
  'trade-in mention',
  'guaranteed-availability language',
]);

const TOPIC_LABELS: Record<string, string> = {
  price: 'pricing',
  discount: 'discounts or incentives',
  financing: 'financing or payments',
  trade_in: 'trade-in values',
  availability: 'availability promises',
  approval: 'approval promises',
  unrecognized: 'guarded topics',
};

const TOPIC_PATTERNS: Array<{ topic: string; pattern: RegExp }> = [
  { topic: 'price', pattern: /\bprice[sd]?\b|\bpricing\b|\bMSRP\b/gi },
  { topic: 'discount', pattern: /\bdiscount(?:s|ed)?\b|\bpromo(?:tion)?(?:al)?\b|\bincentives?\b|\brebates?\b|\bon sale\b|\bsale price\b|\bclearance\b|\bspecial offer\b/gi },
  { topic: 'financing', pattern: /\bfinanc(?:e|ing)\b|\bloans?\b|\blease[ds]?\b|\bAPR\b|\bdown payment\b|\bmonthly payments?\b|\bcredit approv(?:al|ed)\b|\/\s?mo\b/gi },
  { topic: 'trade_in', pattern: /\btrade[\s-]?in\b/gi },
  { topic: 'availability', pattern: /\bguarantee(?:d|s)?\b|\bact fast\b|\bwon'?t last\b|\blimited (?:time|availability|stock)\b|\bhurry\b|\bfirst come\b|\bstill available\b|\bin stock\b|\bavailable now\b/gi },
  { topic: 'approval', pattern: /\beveryone (?:is|gets) approved\b|\bno credit (?:check|needed|required)\b|\bapproved regardless\b|\b(?:bad|no) credit,? no problem\b|\bbuy here,? pay here\b/gi },
];

const FIGURE_PATTERNS = [
  /\$\s?\d/,
  /\d+\s?%/,
  /\bUSD\b/i,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:k|grand|bucks|dollars?)\b/i,
];
const FINANCE_FIGURE = /\b\d[\d,.]*\s?(?:months?|mos?|yrs?|years?|apr|percent)\b|\b(?:apr|rate)\s?(?:of\s)?\d/i;
const STAFF_NOUN_AFTER = /^\s+(?:team|teams|manager|managers|department|specialist|specialists|office|director|desk|staff)\b/i;
const CONDITIONAL_AVAILABILITY = /\bstill available\b|\bin stock\b|\bavailable now\b/i;
const AVAILABILITY_HEDGE = /\b(if|whether|check|confirm(ing)?|verify|verifying|see|seeing|find out|let me|i'll|we'll|will|going to)\b/i;

const NEGATIVE = /\b(?:never|don'?t|do not|does not|doesn'?t|must not|mustn'?t|should not|shouldn'?t|cannot|can'?t|won'?t|will not|avoid\w*|refus\w*|declin\w*|not allowed to)\b|\bwithout (?:quoting|giving|mentioning|discussing|sharing|stating|promising|confirming|offering)\b|\b(?:instead of|rather than)\b|\bnot (?:to )?(?:quote|give|share|discuss|mention|state|promise|confirm|offer|negotiate)\b/gi;
const NEGATION_REVERSED = /^\s*(?:to\s+)?(?:hesitate|forget|fail|miss|neglect|skip|stop|be afraid)\b/i;
const NEGATIVE_START = /^\s*(?:no|never|nothing about)\b/i;
const QUESTION_FRAME = /(?:\b(?:customers?|they|he|she|someone|lead|buyer|shopper|visitor|caller|person)\b[^.;,]{0,20}\b(?:asks?|asked|asking|wants?|wanted|needs?|needed|requests?|requested|inquires?|inquired|wonders?|wondered|is (?:asking|wondering|curious)|are (?:asking|wondering|curious))|\b(?:asks?|asked|asking|questions?|inquir(?:y|ies|es|ed|ing)|requests?)\s+(?:about|for|regarding|on|if|whether|what|how))\b[^.;,]{0,30}$/i;
const STAFF_DEFERRAL = /\b(?:team|manager|staff|someone|person|specialist|department|rep|representative|salesperson|advisor|consultant)\b[^.;]{0,40}\b(?:will|can|would|is going to|to)\b[^.;]{0,30}\b(?:confirm|verify|go over|discuss|review|explain|answer|handle|help with|talk (?:about|through)|walk (?:them|you) through|provide|share)\b[^.;]{0,25}$/i;
const CONFIRM_BEFORE = /\b(?:confirm|verify|check|go over|discuss|review)\b[^.;]{0,40}$/i;
const WITH_TEAM_AFTER = /^[^.;]{0,40}\b(?:with|by)\s+(?:the|our|a|your)\s+(?:sales |finance |business )?(?:team|manager|person|staff|specialist|rep|representative|department|desk)\b/i;
const PASSIVE_NEGATION_AFTER = /^\s*(?:[\w'-]+\s+){0,4}?(?:should|must|may|can|will|is|are)\s+(?:never|not)\s+be\s+(?:quoted|discussed|mentioned|shared|given|promised|confirmed|offered|stated|negotiated|disclosed)\b/i;
const CLAUSE_BREAK = /[;:]|\b(?:but|however|although|though|while|except)\b|\b(?:and|then|also|plus)\s+(?=(?:tell|say|let|mention|offer|explain|share|give|quote|promise|state|confirm|guarantee)\b)/gi;
const IMPERATIVE = /\b(?:tell|say|explain|offer|mention|give|quote|share|promise|state|let|confirm|discuss|guarantee)\b/i;

export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

function lastClause(text: string): string {
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BREAK)) start = (match.index ?? 0) + match[0].length;
  return text.slice(start);
}

function negated(clause: string): boolean {
  if (NEGATIVE_START.test(clause)) return true;
  let last: RegExpMatchArray | null = null;
  for (const match of clause.matchAll(NEGATIVE)) last = match;
  if (!last) return false;
  return !NEGATION_REVERSED.test(clause.slice((last.index ?? 0) + last[0].length));
}

function listContinuation(gap: string): boolean {
  if (gap.length > 30 || IMPERATIVE.test(gap)) return false;
  if (!/[,/&]|\bor\b|\band\b/i.test(gap)) return false;
  return /^[\s,/&]*(?:(?:or|and|plus)\s+)?(?:[a-z'-]+\s*[,/&]?\s*){0,3}(?:or|and|plus)?\s*$/i.test(gap);
}

interface TopicHit {
  topic: string;
  index: number;
  end: number;
}

function topicHits(sentence: string): TopicHit[] {
  const hits: TopicHit[] = [];
  for (const { topic, pattern } of TOPIC_PATTERNS) {
    for (const match of sentence.matchAll(pattern)) {
      const index = match.index ?? 0;
      if ((topic === 'financing' || topic === 'price') && STAFF_NOUN_AFTER.test(sentence.slice(index + match[0].length))) continue;
      if (topic === 'availability' && CONDITIONAL_AVAILABILITY.test(match[0])) {
        const context = sentence.slice(Math.max(0, index - 30), index);
        if (AVAILABILITY_HEDGE.test(context)) continue;
      }
      hits.push({ topic, index, end: index + match[0].length });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

function uncoveredTopics(sentence: string, hits: TopicHit[]): TopicHit[] {
  const uncovered: TopicHit[] = [];
  let coveredEnd = -1;
  for (const hit of hits) {
    const before = sentence.slice(0, hit.index);
    const clause = lastClause(before);
    const after = sentence.slice(hit.end);
    const covered = negated(clause)
      || QUESTION_FRAME.test(clause)
      || STAFF_DEFERRAL.test(clause)
      || (CONFIRM_BEFORE.test(clause) && WITH_TEAM_AFTER.test(after))
      || PASSIVE_NEGATION_AFTER.test(after)
      || (coveredEnd >= 0 && listContinuation(sentence.slice(coveredEnd, hit.index)));
    if (covered) coveredEnd = hit.end;
    else {
      coveredEnd = -1;
      uncovered.push(hit);
    }
  }
  return uncovered;
}

export function mentionCovered(sentence: string, index: number, end: number): boolean {
  const clause = lastClause(sentence.slice(0, index));
  const after = sentence.slice(end);
  return negated(clause)
    || STAFF_DEFERRAL.test(clause)
    || (CONFIRM_BEFORE.test(clause) && WITH_TEAM_AFTER.test(after))
    || PASSIVE_NEGATION_AFTER.test(after);
}

function hasFigure(sentence: string): boolean {
  if (FIGURE_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
  return topicHits(sentence).some((hit) => hit.topic === 'financing') && FINANCE_FIGURE.test(sentence);
}

function labelsFor(hits: Array<{ topic: string }>): string {
  return Array.from(new Set(hits.map((hit) => TOPIC_LABELS[hit.topic] || hit.topic))).join(', ');
}

export function guardrailIssues(field: string, text: string, cls: GuardrailClass): ImportIssue[] {
  if (cls === 'exempt' || !text) return [];
  const issues: ImportIssue[] = [];
  const add = (code: string, severity: ImportIssue['severity'], message: string) => {
    if (!issues.some((issue) => issue.code === code)) issues.push({ field, code, severity, message });
  };
  for (const sentence of sentencesOf(text)) {
    if (hasFigure(sentence)) {
      add('guardrail_figure', 'error', 'Remove prices, payments, rates, percentages and other money figures. Imported training content cannot include them.');
      continue;
    }
    const reasons = validateOutboundMessage(sentence).reasons.filter((reason) => GUARDED_REASONS.has(reason));
    if (hasGuaranteedAvailabilityLanguage(sentence) && !reasons.includes('guaranteed-availability language')) reasons.push('guaranteed-availability language');
    const hits = topicHits(sentence);
    if (!reasons.length && !hits.length) continue;
    if (cls === 'reply') {
      add('guardrail_reply', 'error', `This reply would be blocked by Suprah's outbound safety check (${reasons.join(', ') || labelsFor(hits)}). Rewrite it without pricing, financing, discount, trade-in or availability claims.`);
      continue;
    }
    if (cls === 'question') {
      add('guardrail_topic_question', 'info', `Mentions ${labelsFor(hits) || 'a guarded topic'} as part of what the customer asks. That is allowed.`);
      continue;
    }
    const uncovered = uncoveredTopics(sentence, hits);
    if (reasons.length && !hits.length) uncovered.push({ topic: 'unrecognized', index: 0, end: 0 });
    if (cls === 'knowledge' || cls === 'reference') {
      const promises = uncovered.filter((hit) => hit.topic === 'availability' || hit.topic === 'approval' || hit.topic === 'unrecognized');
      if (promises.length) {
        add('guardrail_promise', 'error', 'Remove availability or approval promises. Describe the process instead.');
      } else {
        add('guardrail_topic_knowledge', 'info', `Mentions ${labelsFor(hits)}. Allowed only as a description of the process, with no figures or promises.`);
      }
      continue;
    }
    if (uncovered.length) {
      add('guardrail_topic', 'error', `${labelsFor(uncovered)} can only appear as an instruction not to discuss them, or to have the team confirm them. Rewrite this sentence.`);
    } else {
      add('guardrail_negative_instruction', 'info', `Read as a safe instruction not to discuss ${labelsFor(hits)}, or to have the team confirm it.`);
    }
  }
  return issues;
}

const AVOID_REDUNDANT_PREFIX = /^\s*(?:(?:please\s+)?(?:don'?t|do not|never|avoid(?:ing)?|no)\s+)+/i;
const AVOID_INVERTED = /^\s*(?:refus\w*|declin\w*|withhold\w*|not\s+\w+|without\s+\w+|hold\w*\s+back|keep\w*\s+(?:it|them|this|that)\s+(?:back|from))/i;
const AVOID_SAFETY = /\b(?:escalat\w*|hand(?:ing)?[\s-]?offs?|handoffs?|hand(?:ing)?\s+(?:it\s+|them\s+)?(?:over|off)|transfer\w*|opt[\s-]?outs?|opting[\s-]?out|unsubscrib\w*|stop (?:requests?|messages?)|(?:say|saying|admit\w*|disclos\w*|tell\w*|confirm\w*|reveal\w*)[^.;\n]{0,30}\b(?:ai|a bot|bot|automated|virtual assistant|artificial)\b|(?:connect\w*|talk\w*|speak\w*|put\w*\s+(?:them\s+)?through)[^.;\n]{0,25}\b(?:person|human|manager|staff|someone)\b|mandatory checks?|safety checks?)/i;
const AVOID_VIOLATION_VERB = /\b(?:ignor\w*|bypass\w*|skip\w*|overrid\w*|disabl\w*|work\w* around|get\w* around|break\w*|violat\w*|den(?:y|ies|ied|ying))\b/i;
const AVOID_POSITIVE_IMPERATIVE = /^\s*(?:also\s+|and\s+|then\s+|instead\s+)?(?:tell|say|quote|offer|promise|guarantee|mention|explain|share|give|state|let|confirm|reply|respond|answer)\b/i;

export function avoidItemIssues(field: string, text: string): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (!text) return issues;
  const add = (found: ImportIssue[]) => {
    for (const issue of found) if (issue.severity === 'error' && !issues.some((existing) => existing.code === issue.code)) issues.push(issue);
  };
  const clauses = text.split(/(?<=[.!?;])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const rest = clauses.slice(1);
  for (const clause of clauses) {
    const avoided = clause.replace(/^\s*(?:also|and|then|plus)\s+/i, '').replace(AVOID_REDUNDANT_PREFIX, '');
    if (AVOID_INVERTED.test(avoided)) {
      add([{ field, code: 'must_avoid_contradiction', severity: 'error', message: '"Never include" items must name the thing to avoid. Wording like "refusing to quote prices" would tell Alex to do the opposite.' }]);
    }
    const safetyMatch = avoided.match(AVOID_SAFETY);
    if (safetyMatch && !AVOID_VIOLATION_VERB.test(avoided.slice(0, safetyMatch.index))) {
      add([{ field, code: 'must_avoid_safety', severity: 'error', message: "A rule can't tell Alex to avoid handing off, honoring opt-outs, safety checks, or saying it's an AI assistant." }]);
    }
  }
  if (rest.some((clause) => AVOID_POSITIVE_IMPERATIVE.test(clause))) {
    add([{ field, code: 'must_avoid_extra_instruction', severity: 'error', message: 'Keep each "Never include" item to the one thing Alex should avoid. Put instructions in the response guidance.' }]);
  }
  for (const clause of rest) {
    if (AVOID_POSITIVE_IMPERATIVE.test(clause)) add(guardrailIssues(field, clause, 'instruction'));
    add(safetyIssues(field, clause));
  }
  return issues;
}

export function safetyIssues(field: string, text: string): ImportIssue[] {
  if (!text) return [];
  const messages = Array.from(new Set(findSafetyBypassInText(text)));
  return messages.map((message) => ({ field, code: 'safety_bypass', severity: 'error' as const, message }));
}

export function protectedQuestionIssues(field: string, text: string): ImportIssue[] {
  const topic = text ? findProtectedTopicInText(text) : null;
  if (!topic) return [];
  return [{ field, code: 'protected_topic', severity: 'error', message: `Customers ${topic} are always handled by Suprah's mandatory checks, so this can't be an FAQ answer.` }];
}
