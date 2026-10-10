export type SmsFailureCategory = 'invalid_number' | 'landline' | 'blocked' | 'carrier_rejected' | 'unknown';

export interface SmsFailureDescription {
  friendlyMessage: string;
  category: SmsFailureCategory;
}

interface TelnyxErrorEntry {
  code?: string;
  title?: string;
  detail?: string;
}

const CODE_MESSAGES: Record<string, SmsFailureDescription> = {
  '40001': { friendlyMessage: "This number couldn't be reached — it may be invalid.", category: 'invalid_number' },
  '40002': { friendlyMessage: "This number couldn't be reached — it may be invalid.", category: 'invalid_number' },
  '40003': { friendlyMessage: "This looks like a landline and can't receive text messages.", category: 'landline' },
  '40300': { friendlyMessage: 'The carrier blocked this message.', category: 'carrier_rejected' },
};

function classifyByKeywords(text: string): SmsFailureDescription | null {
  const lower = text.toLowerCase();
  if (lower.includes('landline') || lower.includes('not sms capable') || lower.includes('non-sms')) {
    return { friendlyMessage: "This looks like a landline and can't receive text messages.", category: 'landline' };
  }
  if (lower.includes('invalid') && (lower.includes('to') || lower.includes('destination') || lower.includes('number'))) {
    return { friendlyMessage: "This number couldn't be reached — it may be invalid.", category: 'invalid_number' };
  }
  if (lower.includes('block') || lower.includes('stop')) {
    return { friendlyMessage: 'This message was blocked by the carrier or the customer opted out.', category: 'blocked' };
  }
  if (lower.includes('unreachable') || lower.includes('undeliverable') || lower.includes('reject')) {
    return { friendlyMessage: "This message couldn't be delivered to this number.", category: 'carrier_rejected' };
  }
  return null;
}

/** Turns the raw Telnyx `errorDetail` already captured on a failed
 *  CommunicationMessage into a short, user-friendly line — never shown raw
 *  to a normal user. Purely reactive over data that's already there; does
 *  not attempt to validate a number before sending. */
export function describeSmsFailure(errorDetail?: string | null): SmsFailureDescription | null {
  if (!errorDetail) return null;

  try {
    const parsed = JSON.parse(errorDetail);
    const entries: TelnyxErrorEntry[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.errors) ? parsed.errors : [];
    const first = entries[0];
    if (first?.code && CODE_MESSAGES[String(first.code)]) {
      return CODE_MESSAGES[String(first.code)];
    }
    const text = [first?.title, first?.detail].filter(Boolean).join(' ');
    if (text) {
      const byKeyword = classifyByKeywords(text);
      if (byKeyword) return byKeyword;
    }
  } catch {
    const byKeyword = classifyByKeywords(errorDetail);
    if (byKeyword) return byKeyword;
  }

  return { friendlyMessage: 'This message could not be delivered.', category: 'unknown' };
}
