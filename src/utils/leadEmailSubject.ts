export const MAX_EMAIL_SUBJECT_LENGTH = 200;

type SubjectLead = { subject?: unknown; emailThreadSubject?: unknown; threadId?: unknown } | null | undefined;

export function cleanEmailSubject(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EMAIL_SUBJECT_LENGTH);
}

export function threadEmailSubject(lead: SubjectLead): string {
  return cleanEmailSubject(lead?.emailThreadSubject) || cleanEmailSubject(`Re: ${cleanEmailSubject(lead?.subject) || 'Inquiry Response'}`);
}

export function resolveLeadEmailSubject(lead: SubjectLead, requested?: unknown): { subject: string; locked: boolean } {
  const existing = threadEmailSubject(lead);
  if (lead?.threadId) return { subject: existing, locked: true };
  return { subject: cleanEmailSubject(requested) || existing, locked: false };
}

export function encodeEmailHeader(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
