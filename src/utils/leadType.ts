import { LEAD_SOURCE, LEAD_SOURCE_VALUES } from '../constants/leadSource';
import { LEAD_CAMPAIGN_FIELDS, type LeadCampaignKind } from './leadActivity';

export const INBOUND_LEAD_SOURCES: string[] = LEAD_SOURCE_VALUES.filter(
  (value) => value !== LEAD_SOURCE.MANUAL_ENTRY && value !== LEAD_SOURCE.DEMO,
);

export const LEAD_CAMPAIGN_KINDS = Object.keys(LEAD_CAMPAIGN_FIELDS) as LeadCampaignKind[];

export const LEAD_TYPE_FILTERS = [
  'inbound',
  'outbound',
  'outbound:team_text',
  'outbound:team_call',
  'outbound:added_by_team',
  'campaign',
  'campaign:price_drop',
  'campaign:reengagement',
  'campaign:sms_campaign',
  'campaign:email_campaign',
] as const;

export type LeadTypeFilter = (typeof LEAD_TYPE_FILTERS)[number];

export interface LeadCampaignSummary {
  kind: LeadCampaignKind;
  sentAt: Date;
  responded: boolean;
}

const FIRST_CONTACT_UNSET = { firstContactBy: { $nin: ['customer', 'team'] } };

export function parseLeadTypeFilter(value: unknown): LeadTypeFilter | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return (LEAD_TYPE_FILTERS as readonly string[]).includes(text) ? (text as LeadTypeFilter) : null;
}

export function firstContactForStaffLead(source: unknown): { firstContactBy: 'customer' | 'team'; firstContactVia: 'added_by_team' | null } {
  const value = typeof source === 'string' ? source.trim() : '';
  if (INBOUND_LEAD_SOURCES.includes(value)) return { firstContactBy: 'customer', firstContactVia: null };
  return { firstContactBy: 'team', firstContactVia: 'added_by_team' };
}

export function campaignKindsFor(filter: LeadTypeFilter | null): LeadCampaignKind[] | null {
  if (filter === 'campaign') return LEAD_CAMPAIGN_KINDS;
  if (filter && filter.startsWith('campaign:')) return [filter.slice('campaign:'.length) as LeadCampaignKind];
  return null;
}

export function leadTypeCondition(filter: LeadTypeFilter): Record<string, unknown> {
  const campaignKinds = campaignKindsFor(filter);
  if (campaignKinds) {
    const sent = campaignKinds.map((kind) => ({ [LEAD_CAMPAIGN_FIELDS[kind]]: { $type: 'date' } }));
    return sent.length === 1 ? sent[0] : { $or: sent };
  }
  switch (filter) {
    case 'inbound':
      return { $or: [{ firstContactBy: 'customer' }, { ...FIRST_CONTACT_UNSET, source: { $ne: LEAD_SOURCE.MANUAL_ENTRY } }] };
    case 'outbound':
      return { $or: [{ firstContactBy: 'team' }, { ...FIRST_CONTACT_UNSET, source: LEAD_SOURCE.MANUAL_ENTRY }] };
    case 'outbound:team_text':
      return { firstContactBy: 'team', firstContactVia: 'team_text' };
    case 'outbound:team_call':
      return { firstContactBy: 'team', firstContactVia: 'team_call' };
    case 'outbound:added_by_team':
    default:
      return {
        $or: [
          { firstContactBy: 'team', firstContactVia: 'added_by_team' },
          { ...FIRST_CONTACT_UNSET, source: LEAD_SOURCE.MANUAL_ENTRY },
        ],
      };
  }
}

export function campaignDateCondition(kinds: LeadCampaignKind[], range: Record<string, Date>): Record<string, unknown> {
  const sent = kinds.map((kind) => ({ [LEAD_CAMPAIGN_FIELDS[kind]]: range }));
  return sent.length === 1 ? sent[0] : { $or: sent };
}

function dateValue(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function campaignSummary(lead: any, kinds: LeadCampaignKind[] = LEAD_CAMPAIGN_KINDS): LeadCampaignSummary | null {
  let latest: { kind: LeadCampaignKind; sentAt: Date } | null = null;
  for (const kind of kinds) {
    const field = LEAD_CAMPAIGN_FIELDS[kind].split('.')[1];
    const sentAt = dateValue(lead?.campaignSentAt?.[field]);
    if (sentAt && (!latest || sentAt.getTime() > latest.sentAt.getTime())) latest = { kind, sentAt };
  }
  if (!latest) return null;
  const customerAt = dateValue(lead?.followUp?.lastCustomerActivityAt);
  return { ...latest, responded: Boolean(customerAt && customerAt.getTime() > latest.sentAt.getTime()) };
}

const isDate = (path: string) => ({ $eq: [{ $type: path }, 'date'] });
const firstContactSet = { $in: ['$firstContactBy', ['customer', 'team']] };
const manualEntry = { $eq: ['$source', LEAD_SOURCE.MANUAL_ENTRY] };
const isTeam = { $or: [{ $eq: ['$firstContactBy', 'team'] }, { $and: [{ $not: [firstContactSet] }, manualEntry] }] };
const countIf = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });

export function leadTypeCountsGroup(): { _id: null } & Record<string, any> {
  const campaignChecks = LEAD_CAMPAIGN_KINDS.map((kind) => isDate(`$${LEAD_CAMPAIGN_FIELDS[kind]}`));
  return {
    _id: null,
    inbound: countIf({ $not: [isTeam] }),
    outbound: countIf(isTeam),
    team_text: countIf({ $and: [{ $eq: ['$firstContactBy', 'team'] }, { $eq: ['$firstContactVia', 'team_text'] }] }),
    team_call: countIf({ $and: [{ $eq: ['$firstContactBy', 'team'] }, { $eq: ['$firstContactVia', 'team_call'] }] }),
    added_by_team: countIf({
      $or: [
        { $and: [{ $eq: ['$firstContactBy', 'team'] }, { $eq: ['$firstContactVia', 'added_by_team'] }] },
        { $and: [{ $not: [firstContactSet] }, manualEntry] },
      ],
    }),
    campaign: countIf({ $or: campaignChecks }),
    ...Object.fromEntries(LEAD_CAMPAIGN_KINDS.map((kind, index) => [kind, countIf(campaignChecks[index])])),
  };
}

export function leadTypeCountsFromGroup(row: any): Record<LeadTypeFilter, number> {
  const value = (key: string) => Number(row?.[key] || 0);
  return {
    inbound: value('inbound'),
    outbound: value('outbound'),
    'outbound:team_text': value('team_text'),
    'outbound:team_call': value('team_call'),
    'outbound:added_by_team': value('added_by_team'),
    campaign: value('campaign'),
    'campaign:price_drop': value('price_drop'),
    'campaign:reengagement': value('reengagement'),
    'campaign:sms_campaign': value('sms_campaign'),
    'campaign:email_campaign': value('email_campaign'),
  };
}
