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

export function contactIdentity(input: { email?: unknown; phone?: unknown; alternatePhone?: unknown }) {
  return {
    normalizedEmail: normalizeIdentityEmail(input.email),
    normalizedPhone: normalizeIdentityPhone(input.phone),
    normalizedAlternatePhone: normalizeIdentityPhone(input.alternatePhone),
  };
}
