import { isDemoPhone } from '../utils/demoPhone';

export const LEAD_SOURCE = {
  WEBSITE_BOOKING: 'Website Booking',
  WEBSITE_CHAT: 'Website Chat',
  WEBSITE_INQUIRY: 'Website Inquiry',
  THIRD_PARTY_LEAD: 'Third-Party Lead',
  INBOUND_SMS: 'Inbound SMS',
  INBOUND_CALL: 'Inbound Call',
  EMAIL_INQUIRY: 'Email Inquiry',
  MANUAL_ENTRY: 'Manual Entry',
  DEMO: 'Demo',
} as const;

export type LeadSource = (typeof LEAD_SOURCE)[keyof typeof LEAD_SOURCE];

export const LEAD_SOURCE_VALUES: LeadSource[] = Object.values(LEAD_SOURCE);

export const REPORTABLE_LEAD_SOURCE_VALUES: LeadSource[] = LEAD_SOURCE_VALUES.filter(
  (value) => value !== LEAD_SOURCE.DEMO,
);

export const UNMAPPED_LEAD_SOURCE_LABEL = 'Other';

const LEGACY_SOURCE_MAP: Record<string, { source: LeadSource; sourceProvider?: string }> = {
  'gmail sync': { source: LEAD_SOURCE.EMAIL_INQUIRY },
  email: { source: LEAD_SOURCE.EMAIL_INQUIRY },
  'dealerscloud lead': { source: LEAD_SOURCE.THIRD_PARTY_LEAD, sourceProvider: 'DealersCloud' },
  'adf lead (dealerscloud)': { source: LEAD_SOURCE.THIRD_PARTY_LEAD, sourceProvider: 'DealersCloud' },
  'adf lead': { source: LEAD_SOURCE.THIRD_PARTY_LEAD },
  'adf email': { source: LEAD_SOURCE.THIRD_PARTY_LEAD },
};

export interface NormalizedLeadSource {
  source: LeadSource | typeof UNMAPPED_LEAD_SOURCE_LABEL;
  sourceProvider?: string;
}

export function normalizeLeadSourceForDisplay(input: {
  source?: string | null;
  channel?: string | null;
  sourceProvider?: string | null;
}): NormalizedLeadSource {
  const raw = String(input.source || '').trim();
  const existingProvider = input.sourceProvider ? String(input.sourceProvider).trim() : undefined;

  if ((LEAD_SOURCE_VALUES as string[]).includes(raw)) {
    return { source: raw as LeadSource, sourceProvider: existingProvider || undefined };
  }

  const legacy = LEGACY_SOURCE_MAP[raw.toLowerCase()];
  if (legacy) {
    return { source: legacy.source, sourceProvider: existingProvider || legacy.sourceProvider };
  }

  if (input.channel === 'adf' && raw) {
    return { source: LEAD_SOURCE.THIRD_PARTY_LEAD, sourceProvider: existingProvider || raw };
  }

  if (!raw) {
    return { source: LEAD_SOURCE.EMAIL_INQUIRY, sourceProvider: existingProvider };
  }

  return { source: UNMAPPED_LEAD_SOURCE_LABEL, sourceProvider: existingProvider || raw };
}

export function buildLeadSourceFilterCondition(source: string): any | null {
  const requested = String(source || '').trim();
  if (!requested || requested === 'All') return null;

  if (requested === LEAD_SOURCE.EMAIL_INQUIRY) {
    return {
      $or: [
        { source: LEAD_SOURCE.EMAIL_INQUIRY },
        { source: { $regex: /^(email|gmail sync)$/i } },
        { source: { $exists: false } },
        { source: null },
        { source: '' },
      ],
    };
  }

  if (requested === LEAD_SOURCE.THIRD_PARTY_LEAD) {
    return {
      $or: [
        { source: LEAD_SOURCE.THIRD_PARTY_LEAD },
        { source: { $regex: /^(dealerscloud lead|adf lead \(dealerscloud\)|adf lead|adf email)$/i } },
        {
          channel: 'adf',
          source: {
            $exists: true,
            $nin: ['', null, ...LEAD_SOURCE_VALUES],
            $not: /^(email|gmail sync)$/i,
          },
        },
      ],
    };
  }

  if (requested === UNMAPPED_LEAD_SOURCE_LABEL) {
    return {
      source: {
        $exists: true,
        $nin: ['', null, ...LEAD_SOURCE_VALUES],
        $not: /^(email|gmail sync|dealerscloud lead|adf lead \(dealerscloud\)|adf lead|adf email)$/i,
      },
      channel: { $ne: 'adf' },
    };
  }

  if ((LEAD_SOURCE_VALUES as string[]).includes(requested)) {
    return { source: requested };
  }

  return null;
}

export function isGenuineDemoLead(source?: string | null, phone?: string | null): boolean {
  return source === LEAD_SOURCE.DEMO && isDemoPhone(phone || '');
}
