import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { ApiError } from './ApiError';

export type SmsDestinationPolicy = 'manual' | 'automated';

export type SmsDestinationReason =
  | 'missing'
  | 'extension'
  | 'unsupported_characters'
  | 'incomplete'
  | 'invalid'
  | 'ambiguous'
  | 'unsupported_number_type'
  | 'country_not_allowed';

export type SmsDestinationResult =
  | { ok: true; e164: string; country: string }
  | { ok: false; reason: SmsDestinationReason; message: string };

export const SMS_INVALID_DESTINATION_CODE = 'SMS_INVALID_DESTINATION';

export const SMS_DESTINATION_MESSAGES: Record<SmsDestinationReason, string> = {
  missing: 'There is no phone number to text.',
  extension: 'The phone number includes an extension, so it cannot be texted.',
  unsupported_characters: 'The phone number has letters or symbols that cannot be texted.',
  incomplete: 'The phone number is missing digits.',
  invalid: 'The phone number is not a valid number.',
  ambiguous: "We can't tell which number to text. Use + and the country code, like +1 for the US or +63 for the Philippines, with no extra 0 after it.",
  unsupported_number_type: 'This type of phone number cannot receive texts.',
  country_not_allowed: 'Automatic texts only go to numbers in the US, US territories, and Canada.',
};

export const AUTOMATED_SMS_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA', 'PR', 'VI', 'GU', 'AS', 'MP']);
const BLOCKED_NUMBER_TYPES = new Set(['PREMIUM_RATE', 'SHARED_COST', 'PAGER', 'UAN', 'VOICEMAIL']);
const EXTENSION_PATTERN = /(ext|[#;]|x\s*\d)/i;

function blocked(reason: SmsDestinationReason): SmsDestinationResult {
  return { ok: false, reason, message: SMS_DESTINATION_MESSAGES[reason] };
}

export function resolveSmsDestination(phone: unknown, policy: SmsDestinationPolicy): SmsDestinationResult {
  const raw = String(phone ?? '').trim();
  if (!raw) return blocked('missing');
  if (EXTENSION_PATTERN.test(raw)) return blocked('extension');
  if (/[^\d\s()+.-]/.test(raw) || raw.lastIndexOf('+') > 0) return blocked('unsupported_characters');

  const digits = raw.replace(/\D/g, '');
  const hasPlus = raw.startsWith('+');
  if (digits.length < (hasPlus ? 8 : 10)) return blocked('incomplete');
  if (!hasPlus && !(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) {
    return blocked('ambiguous');
  }
  const identityKey = hasPlus || digits.length === 11 ? `+${digits}` : `+1${digits}`;

  let parsed: ReturnType<typeof parsePhoneNumberFromString>;
  try {
    parsed = parsePhoneNumberFromString(raw, { defaultCountry: 'US' });
  } catch {
    parsed = undefined;
  }
  if (!parsed || !parsed.isValid()) return blocked('invalid');
  if (parsed.number !== identityKey) return blocked('ambiguous');
  if (!parsed.country || BLOCKED_NUMBER_TYPES.has(String(parsed.getType()))) {
    return blocked('unsupported_number_type');
  }
  if (policy === 'automated' && !AUTOMATED_SMS_COUNTRIES.has(parsed.country)) return blocked('country_not_allowed');

  return { ok: true, e164: parsed.number, country: parsed.country };
}

export class SmsDestinationError extends ApiError {
  reason: SmsDestinationReason;
  policy: SmsDestinationPolicy;

  constructor(reason: SmsDestinationReason, policy: SmsDestinationPolicy) {
    super(400, SMS_DESTINATION_MESSAGES[reason], [{ code: SMS_INVALID_DESTINATION_CODE, reason, policy }]);
    this.name = 'SmsDestinationError';
    this.reason = reason;
    this.policy = policy;
  }
}

export function isSmsDestinationError(err: unknown): err is SmsDestinationError {
  return err instanceof SmsDestinationError;
}

export function assertSmsDestination(phone: unknown, policy: SmsDestinationPolicy): string {
  const destination = resolveSmsDestination(phone, policy);
  if (!destination.ok) throw new SmsDestinationError(destination.reason, policy);
  return destination.e164;
}
