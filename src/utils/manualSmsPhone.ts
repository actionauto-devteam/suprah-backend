export const PHONE_EXTENSION_MESSAGE =
  "This phone number includes an extension or other characters that can't be texted. Edit the number so it only has the phone digits, then send the text.";

export const INVALID_SMS_PHONE_MESSAGE = 'Add a valid phone number before sending a text.';

export function manualSmsPhoneProblem(phone: unknown): string | null {
  const raw = String(phone ?? '').trim();
  if (/[^\d\s()+.-]/.test(raw) || raw.lastIndexOf('+') > 0) return PHONE_EXTENSION_MESSAGE;
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    return digits.length >= 10 && digits.length <= 15 ? null : INVALID_SMS_PHONE_MESSAGE;
  }
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) return null;
  return INVALID_SMS_PHONE_MESSAGE;
}
