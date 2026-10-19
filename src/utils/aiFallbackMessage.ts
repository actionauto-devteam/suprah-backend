import { validateOutboundMessage } from './aiOutboundSafety';

export const GENERIC_FALLBACK_MESSAGES = [
  'Thanks for your message! A member of our team will follow up with you as soon as possible.',
  'Thanks for reaching out — a member of our team will get back to you shortly.',
];

export type FallbackKind =
  | 'test_drive_with_time'
  | 'visit_with_time'
  | 'test_drive'
  | 'visit'
  | 'availability'
  | 'details'
  | 'callback'
  | 'vehicle_clarification'
  | 'general';

export interface FallbackTranscriptEntry {
  from: 'customer' | 'ai' | 'staff';
  body: string;
}

export interface ContextualFallback {
  text: string;
  kind: FallbackKind;
}

const RECENT_AI_WINDOW = 6;
const MAX_FALLBACK_LENGTH = 300;

const TEST_DRIVE_PATTERN = /\btest[\s-]?drive\b/i;
const VISIT_PATTERN = /\bappointment\b|\bschedul(e|ed|ing)\b|\bcome (in|by|down|see|look)\b|\bstop (by|in)\b|\bvisit\b|\bswing by\b|\bbook\b/i;
const AVAILABILITY_PATTERN = /\bavailab(le|ility)\b|\bstill (have|got|there|for sale|on)\b|\bin stock\b|\bon the lot\b|\bsold yet\b|\bstill around\b/i;
const DETAILS_PATTERN = /\bprice|\bpricing\b|\bcost\b|\bpayment|\bfinanc|\bloan\b|\blease\b|\bapr\b|\bcredit\b|\bdown ?payment\b|\btrade\b|\bout the door\b|\botd\b|\bhow much\b|\$\s?\d/i;
const CALLBACK_PATTERN = /\bcall me\b|\bcall (me )?back\b|\bgive me a call\b|\bphone call\b|\bcan (you|someone) call\b/i;

const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_DAY = `${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?`;
const WEEKDAY_DATE_PATTERN = new RegExp(`\\b${WEEKDAY}(?:,?\\s+(?:the\\s+)?(?:${MONTH_DAY}|\\d{1,2}(?:st|nd|rd|th)))?\\b`, 'i');
const MONTH_DAY_PATTERN = new RegExp(`\\b${MONTH_DAY}\\b`, 'i');
const RELATIVE_DAY_PATTERN = /\b(today|tomorrow|tonight|this (?:morning|afternoon|evening|weekend)|next week)\b/i;
const NUMERIC_DATE_PATTERN = /\b\d{1,2}\/\d{1,2}\b/;
const TIME_PATTERN = /\b(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
const TIME_RANGE_PATTERN = /\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|till)\s*\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)/i;

function latestCustomerMessage(transcript: FallbackTranscriptEntry[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].from === 'customer') return String(transcript[i].body || '');
  }
  return '';
}

function recentAiMessages(transcript: FallbackTranscriptEntry[]): string[] {
  return transcript
    .filter((entry) => entry.from === 'ai')
    .slice(-RECENT_AI_WINDOW)
    .map((entry) => String(entry.body || '').trim());
}

function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function extractRequestedDay(text: string): string | null {
  const weekday = text.match(WEEKDAY_DATE_PATTERN);
  if (weekday) return capitalizeWords(weekday[0].replace(/\s+/g, ' ').trim());
  const monthDay = text.match(MONTH_DAY_PATTERN);
  if (monthDay) return capitalizeWords(monthDay[0].replace(/\s+/g, ' ').trim());
  const relative = text.match(RELATIVE_DAY_PATTERN);
  if (relative) return relative[0].toLowerCase();
  const numeric = text.match(NUMERIC_DATE_PATTERN);
  if (numeric) return numeric[0];
  return null;
}

function capitalizeWords(value: string): string {
  return value
    .split(' ')
    .map((word) => (/^[a-z]/i.test(word) && !/^(the|of)$/i.test(word) ? capitalizeFirst(word.toLowerCase()) : word))
    .join(' ');
}

export function extractRequestedTime(text: string): string | null {
  if (TIME_RANGE_PATTERN.test(text)) return null;
  const matches = Array.from(text.matchAll(TIME_PATTERN));
  if (matches.length !== 1) return null;
  const [, hourRaw, minutes, meridiemRaw] = matches[0];
  const hour = parseInt(hourRaw, 10);
  if (!hour || hour > 12) return null;
  const meridiem = meridiemRaw.toLowerCase().startsWith('a') ? 'AM' : 'PM';
  return `${hour}${minutes ? `:${minutes}` : ''} ${meridiem}`;
}

function buildCandidate(kind: FallbackKind, message: string, vehicleLabel?: string): string {
  const vehicle = vehicleLabel ? ` the ${vehicleLabel}` : '';
  const day = extractRequestedDay(message);
  const time = extractRequestedTime(message);
  const requested = day ? `${day}${time ? ` at ${time}` : ''}` : time || 'that time';

  switch (kind) {
    case 'test_drive_with_time':
      return `Thanks for your test drive request${vehicle ? ` for${vehicle}` : ''}! A member of our team will follow up to confirm whether ${requested} works.`;
    case 'visit_with_time':
      return `Thanks for letting us know you'd like to come in! A member of our team will follow up to confirm whether ${requested} works.`;
    case 'test_drive':
      return `Thanks for your interest in a test drive${vehicle ? ` of${vehicle}` : ''}! A member of our team will follow up with you to find a time.`;
    case 'visit':
      return 'Thanks for reaching out about coming in! A member of our team will follow up with you to find a time.';
    case 'availability':
      return `Thanks for asking about${vehicle || ' that vehicle'}! A member of our team will follow up with you about its current status.`;
    case 'details':
      return `Good question! A member of our team will follow up with you directly with those details${vehicle ? ` on${vehicle}` : ''}.`;
    case 'callback':
      return 'You got it — a member of our team will reach out to you by phone as soon as they can.';
    default:
      return GENERIC_FALLBACK_MESSAGES[0];
  }
}

export function detectFallbackKind(message: string): FallbackKind {
  const text = String(message || '');
  if (!text.trim()) return 'general';
  const hasWhen = Boolean(extractRequestedDay(text) || extractRequestedTime(text));
  if (TEST_DRIVE_PATTERN.test(text)) return hasWhen ? 'test_drive_with_time' : 'test_drive';
  if (VISIT_PATTERN.test(text)) return hasWhen ? 'visit_with_time' : 'visit';
  if (CALLBACK_PATTERN.test(text)) return 'callback';
  if (DETAILS_PATTERN.test(text)) return 'details';
  if (AVAILABILITY_PATTERN.test(text)) return 'availability';
  return 'general';
}

function isUsable(text: string, recent: string[]): boolean {
  return (
    text.length <= MAX_FALLBACK_LENGTH &&
    validateOutboundMessage(text).ok &&
    !recent.includes(text.trim())
  );
}

function pickGeneric(recent: string[]): string {
  const unused = GENERIC_FALLBACK_MESSAGES.find((message) => !recent.includes(message));
  if (unused) return unused;
  let best = GENERIC_FALLBACK_MESSAGES[0];
  let bestIndex = Infinity;
  for (const message of GENERIC_FALLBACK_MESSAGES) {
    const lastUsed = recent.lastIndexOf(message);
    if (lastUsed < bestIndex) {
      bestIndex = lastUsed;
      best = message;
    }
  }
  return best;
}

export function buildContextualFallback(input: {
  transcript: FallbackTranscriptEntry[];
  vehicleLabel?: string;
}): ContextualFallback {
  const message = latestCustomerMessage(input.transcript);
  const recent = recentAiMessages(input.transcript);
  const kind = detectFallbackKind(message);

  if (kind !== 'general') {
    const attempts = input.vehicleLabel
      ? [buildCandidate(kind, message, input.vehicleLabel), buildCandidate(kind, message)]
      : [buildCandidate(kind, message)];
    for (const text of attempts) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (isUsable(normalized, recent)) return { text: normalized, kind };
    }
  }

  const generic = pickGeneric(recent);
  if (validateOutboundMessage(generic).ok) return { text: generic, kind: 'general' };
  return { text: GENERIC_FALLBACK_MESSAGES[0], kind: 'general' };
}
