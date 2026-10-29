import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export function normalizeIdentityEmail(value: unknown): string | null {
  const email = String(value ?? '').trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function normalizeIdentityPhone(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || /[a-z]/i.test(raw.replace(/(?:ext(?:ension)?\.?|x|;ext=)\s*\d+$/i, ''))) return null;
  try {
    const parsed = parsePhoneNumberFromString(raw, { defaultCountry: 'US', extract: false });
    return parsed?.isValid() ? `${parsed.number}${parsed.ext ? `;ext=${parsed.ext}` : ''}` : null;
  } catch {
    return null;
  }
}

const PLACEHOLDER_EMAILS = new Set(['demo.customer@example.com']);
const PLACEHOLDER_EMAIL_LOCAL_PARTS = new Set([
  'none', 'noemail', 'no-email', 'no_email', 'no.email', 'nomail', 'no-mail', 'noreply', 'no-reply', 'donotreply',
  'do-not-reply', 'na', 'n.a', 'n-a', 'null', 'nil', 'unknown', 'notprovided', 'not-provided', 'not_provided',
  'noaddress', 'fake', 'fakeemail', 'test', 'testing', 'asdf', 'asdfasdf', 'abc', 'abc123', 'xxx', 'xx', 'x',
  'nobody', 'noone', 'no', 'email',
]);
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'none.com', 'noemail.com', 'nomail.com', 'noemail.net', 'nomail.net', 'no.com', 'na.com', 'fake.com',
  'fakeemail.com', 'test.com', 'notprovided.com', 'unknown.com', 'email.email', 'noemailaddress.com', 'donotreply.com',
]);
const PLACEHOLDER_PHONE_NUMBERS = new Set(['0123456789', '1234567890', '9876543210', '0987654321']);

export function isPlaceholderEmail(value: unknown): boolean {
  const email = normalizeIdentityEmail(value);
  if (!email) return false;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return PLACEHOLDER_EMAILS.has(email)
    || PLACEHOLDER_EMAIL_LOCAL_PARTS.has(local)
    || PLACEHOLDER_EMAIL_DOMAINS.has(domain)
    || domain.endsWith('.invalid');
}

export function isPlaceholderPhone(value: unknown): boolean {
  const phone = normalizeIdentityPhone(value);
  if (!phone) return false;
  const digits = phone.split(';')[0].replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const subscriber = national.slice(-7);
  return /^(\d)\1+$/.test(national)
    || PLACEHOLDER_PHONE_NUMBERS.has(national)
    || /^(\d)\1{6}$/.test(subscriber)
    || subscriber === '1234567';
}

export function matchableIdentityEmail(value: unknown): string | null {
  const email = normalizeIdentityEmail(value);
  return email && !isPlaceholderEmail(email) ? email : null;
}

export function matchableIdentityPhone(value: unknown): string | null {
  const phone = normalizeIdentityPhone(value);
  return phone && !isPlaceholderPhone(phone) ? phone : null;
}

export function contactIdentity(input: { email?: unknown; phone?: unknown; alternatePhone?: unknown }) {
  return {
    normalizedEmail: matchableIdentityEmail(input.email),
    normalizedPhone: matchableIdentityPhone(input.phone),
    normalizedAlternatePhone: matchableIdentityPhone(input.alternatePhone),
  };
}
